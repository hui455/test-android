import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { request, type ClientRequest } from 'node:http'
import { join } from 'node:path'
import { discover } from '../server/discovery'
import type { ExportScope } from '../server/exporter'
import { CLIENT_HEADER, decode, encode } from '../server/wire'
import { PROTOCOL, type Bug, type ConnSettings, type ConnState, type DeviceInfo, type Mark, type NewBug, type Project, type ServerInfo } from '../shared/types'

/** 连不上服务端（网络错误、超时） */
export class OfflineError extends Error {}

/** 服务端返回的错误 */
export class RemoteError extends Error {
  constructor(
    message: string,
    readonly code = '',
    readonly by = ''
  ) {
    super(message)
  }
}

interface OutboxItem {
  id: string
  projectId: string
  input: NewBug
  device: DeviceInfo | null
  marks: Mark[]
  reporter: string
  createdAt: string
  hasShot: boolean
  hasMarked: boolean
  /** 上传失败的原因（比如项目已被删除），留着让测试人员自己处理 */
  error?: string
}

const OUTBOX_SHOT = 'outbox:'
const RETRY_MS = 5000
const CACHE_DAYS = 30
const OFFLINE_MSG = '服务端连不上，这个操作要等连上后再做'

/**
 * 客户端的数据层：所有数据在服务端，这里保存一份缓存用来显示，
 * 连不上时新记的反馈先放在本机 outbox/，连上后按顺序补传。
 */
export class RemoteStore extends EventEmitter {
  private projects = new Map<string, Project>()
  private outbox: OutboxItem[] = []
  private conn: ConnSettings = { url: '', token: '', name: '' }
  private sse: ClientRequest | null = null
  private retry: NodeJS.Timeout | null = null
  private gen = 0
  private flushing = false
  private fails = 0
  private device = ''
  state: ConnState = { status: 'unset', url: '', serverName: '', serverVersion: '', error: '', outbox: 0, legacy: 0 }

  constructor(private root: string) {
    super()
  }

  private cacheFile = () => join(this.root, 'cache.json')
  private outDir = () => join(this.root, 'outbox')
  private shotCache = (projectId: string, file: string) => join(this.root, 'shot-cache', projectId, file)
  private designCache = (projectId: string, file: string) => join(this.root, 'shot-cache', projectId, `design-${file}`)

  async load() {
    await mkdir(this.outDir(), { recursive: true })
    try {
      for (const p of JSON.parse(await readFile(this.cacheFile(), 'utf8')) as Project[]) this.projects.set(p.id, p)
    } catch {
      /* 第一次运行没有缓存 */
    }
    for (const f of (await readdir(this.outDir())).filter((n) => n.endsWith('.json')).sort()) {
      try {
        this.outbox.push(JSON.parse(await readFile(join(this.outDir(), f), 'utf8')) as OutboxItem)
      } catch (err) {
        console.error(`跳过无法读取的待上传反馈 ${f}:`, err)
      }
    }
    this.outbox.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    this.state.outbox = this.outbox.length
    void this.cleanShotCache()
  }

  private async cleanShotCache() {
    const dir = join(this.root, 'shot-cache')
    if (!existsSync(dir)) return
    const cutoff = Date.now() - CACHE_DAYS * 86_400_000
    for (const pid of await readdir(dir)) {
      for (const f of await readdir(join(dir, pid)).catch(() => [] as string[])) {
        const p = join(dir, pid, f)
        if ((await stat(p)).atimeMs < cutoff) await unlink(p).catch(() => {})
      }
    }
  }

  private set(patch: Partial<ConnState>) {
    this.state = { ...this.state, ...patch, outbox: this.outbox.length }
    this.emit('changed')
  }

  // ---------- 连接 ----------

  configure(conn: ConnSettings) {
    this.conn = { ...conn, url: conn.url.trim().replace(/\/+$/, '') }
    void this.connect()
  }

  setDevice(model: string) {
    this.device = model
    if (this.state.status === 'online') void this.rpc('hello', model).catch(() => {})
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { [CLIENT_HEADER]: encodeURIComponent(this.conn.name) }
    if (this.conn.token) h.authorization = `Bearer ${this.conn.token}`
    if (json) h['content-type'] = 'application/json'
    return h
  }

  private async fetch(path: string, init: RequestInit = {}, base = this.conn.url, timeout = 20_000): Promise<Response> {
    let res: Response
    try {
      res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(timeout) })
    } catch (err) {
      throw new OfflineError(`连不上服务端（${(err as Error).cause ? String(((err as Error).cause as Error).message ?? '') : (err as Error).message}）`)
    }
    if (res.ok) return res
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; by?: string }
    if (res.status === 401) throw new RemoteError(body.error ?? '团队令牌不对', 'auth')
    throw new RemoteError(body.error ?? `服务端出错（${res.status}）`, body.code, body.by)
  }

  async rpc<T>(method: string, ...args: unknown[]): Promise<T> {
    const res = await this.fetch('/rpc', { method: 'POST', headers: this.headers(true), body: JSON.stringify({ method, args: encode(args) }) }, this.conn.url, 120_000)
    return decode(((await res.json()) as { value: unknown }).value) as T
  }

  /** 连接设置界面里“测试连接”用，不改当前连接 */
  async probe(conn: ConnSettings): Promise<ServerInfo> {
    const url = conn.url.trim().replace(/\/+$/, '')
    const info = (await (await this.fetch('/api/info', {}, url, 5000)).json()) as ServerInfo
    if (info.app !== 'bugshot-server') throw new RemoteError('这个地址不是 BugShot 服务端')
    if (info.protocol !== PROTOCOL) throw new RemoteError(`服务端是 v${info.version}，和这个客户端不兼容，请升级到同一版本`, 'mismatch')
    await this.fetch('/api/projects', { headers: { authorization: `Bearer ${conn.token}` } }, url, 5000)
    return info
  }

  private schedule() {
    if (this.retry) clearTimeout(this.retry)
    this.retry = setTimeout(() => void this.connect(), RETRY_MS)
  }

  private closeStream() {
    this.sse?.destroy()
    this.sse = null
  }

  async connect() {
    const gen = ++this.gen
    if (this.retry) clearTimeout(this.retry)
    this.closeStream()
    if (!this.conn.url) return this.set({ status: 'unset', url: '', serverName: '', error: '' })
    // 掉线重连时保持“连不上”的状态，免得标题栏来回闪
    this.set({ status: this.state.status === 'offline' ? 'offline' : 'connecting', url: this.conn.url })
    try {
      const info = (await (await this.fetch('/api/info', {}, this.conn.url, 5000)).json()) as ServerInfo
      if (gen !== this.gen) return
      if (info.app !== 'bugshot-server') throw new RemoteError('这个地址不是 BugShot 服务端', 'mismatch')
      if (info.protocol !== PROTOCOL) throw new RemoteError(`服务端是 v${info.version}，和这个客户端不兼容，请升级到同一版本`, 'mismatch')
      const list = (await (await this.fetch('/api/state', { headers: this.headers() })).json()) as Project[]
      if (gen !== this.gen) return
      this.projects = new Map(list.map((p) => [p.id, p]))
      await this.saveCache()
      this.openStream(gen)
      this.fails = 0
      if (this.conn.serverName !== info.name) {
        this.conn.serverName = info.name
        this.emit('conn', this.conn)
      }
      this.set({ status: 'online', serverName: info.name, serverVersion: info.version, error: '' })
      void this.rpc('hello', this.device).catch(() => {})
      void this.flush()
    } catch (err) {
      if (gen !== this.gen) return
      if (err instanceof RemoteError && err.code === 'auth') return this.set({ status: 'auth', error: '团队令牌不对，请在“连接服务端”里重新填写' })
      if (err instanceof RemoteError && err.code === 'mismatch') return this.set({ status: 'mismatch', error: err.message })
      this.set({ status: 'offline', error: (err as Error).message })
      this.schedule()
      if (++this.fails % 3 === 0) void this.relocate()
    }
  }

  /** 服务端那台电脑换了 IP：在局域网里按名称找，找到就换成新地址 */
  private async relocate() {
    const name = this.conn.serverName
    if (!name) return
    const hit = (await discover()).find((f) => f.name === name && f.url !== this.conn.url)
    if (!hit || this.state.status === 'online') return
    this.conn = { ...this.conn, url: hit.url }
    this.emit('conn', this.conn)
    void this.connect()
  }

  private openStream(gen: number) {
    const u = new URL('/events', this.conn.url)
    const req = request(u, { headers: this.headers() }, (res) => {
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (chunk: string) => {
        buf += chunk
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const event = /^event: (.*)$/m.exec(block)?.[1]
          const data = /^data: (.*)$/m.exec(block)?.[1]
          if (event && data) this.onEvent(event, JSON.parse(data))
        }
      })
      res.on('close', () => lost())
    })
    const lost = () => {
      if (gen !== this.gen || this.sse !== req) return
      this.sse = null
      this.set({ status: 'offline', error: '和服务端的连接断开了' })
      this.schedule()
    }
    req.on('error', lost)
    req.end()
    this.sse = req
  }

  private onEvent(event: string, data: { id?: string; msg?: string }) {
    if (event === 'changed' && data.id) void this.refresh(data.id).catch(() => {})
    if (event === 'activity' && data.msg) this.emit('activity', data.msg)
  }

  /** 从服务端重新取一个项目；项目已被删除时从缓存去掉 */
  async refresh(id: string) {
    try {
      const p = (await (await this.fetch(`/api/projects/${encodeURIComponent(id)}`, { headers: this.headers() })).json()) as Project
      this.projects.set(p.id, p)
    } catch (err) {
      if (!(err instanceof RemoteError)) throw err
      this.projects.delete(id)
    }
    void this.saveCache()
    this.emit('changed')
  }

  private saving: Promise<void> | null = null
  /** 连续的修改合并成一次写盘 */
  private saveCache(): Promise<void> {
    this.saving ??= new Promise((resolve) =>
      setTimeout(async () => {
        this.saving = null
        const tmp = `${this.cacheFile()}.tmp`
        await writeFile(tmp, JSON.stringify([...this.projects.values()]), 'utf8').catch(() => {})
        await rename(tmp, this.cacheFile()).catch(() => {})
        resolve()
      }, 300)
    )
    return this.saving
  }

  // ---------- 读 ----------

  private pendingBug(it: OutboxItem): Bug {
    return {
      id: it.id,
      seq: 0,
      module: it.input.module,
      page: it.input.page,
      text: it.input.text,
      mode: it.input.mode,
      round: this.projects.get(it.projectId)?.rounds.length ?? 1,
      checks: {},
      shots: it.hasShot ? [{ file: `${OUTBOX_SHOT}${it.id}.png`, takenAt: it.createdAt, ...(it.hasMarked ? { marks: it.marks, marked: `${OUTBOX_SHOT}${it.id}.m.png` } : {}) }] : [],
      device: it.device,
      reporter: it.reporter,
      design: it.input.design ?? null,
      pending: true,
      uploadError: it.error,
      createdAt: it.createdAt,
      updatedAt: it.createdAt
    }
  }

  /** 缓存的项目 + 本机待上传的反馈 */
  list(): Project[] {
    return [...this.projects.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((p) => {
        const mine = this.outbox.filter((it) => it.projectId === p.id)
        return mine.length ? { ...p, bugs: [...p.bugs, ...mine.map((it) => this.pendingBug(it))] } : p
      })
  }

  get(id: string): Project {
    const p = this.list().find((x) => x.id === id)
    if (!p) throw new Error(`项目不存在：${id}`)
    return p
  }

  outboxErrors(): { id: string; error: string }[] {
    return this.outbox.filter((it) => it.error).map((it) => ({ id: it.id, error: it.error! }))
  }

  async readShot(projectId: string, file: string): Promise<Buffer> {
    if (file.startsWith(OUTBOX_SHOT)) return readFile(join(this.outDir(), file.slice(OUTBOX_SHOT.length)))
    const cached = this.shotCache(projectId, file)
    if (existsSync(cached)) return readFile(cached)
    const res = await this.fetch(`/shots/${encodeURIComponent(projectId)}/${encodeURIComponent(file)}`, { headers: this.headers() })
    const png = Buffer.from(await res.arrayBuffer())
    await mkdir(join(this.root, 'shot-cache', projectId), { recursive: true })
    await writeFile(cached, png)
    return png
  }

  /** 设计稿图片，和截图放在同一个缓存目录 */
  async readDesign(projectId: string, file: string): Promise<Buffer> {
    const cached = this.designCache(projectId, file)
    if (existsSync(cached)) return readFile(cached)
    const res = await this.fetch(`/designs/${encodeURIComponent(projectId)}/${encodeURIComponent(file)}`, { headers: this.headers() })
    const img = Buffer.from(await res.arrayBuffer())
    await mkdir(join(this.root, 'shot-cache', projectId), { recursive: true })
    await writeFile(cached, img)
    return img
  }

  // ---------- 写 ----------

  /** 在服务端执行，成功后马上刷新这个项目，界面不用等推送 */
  async mutate<T>(projectId: string | null, method: string, ...args: unknown[]): Promise<T> {
    if (this.state.status !== 'online') throw new Error(OFFLINE_MSG)
    try {
      const value = await this.rpc<T>(method, ...args)
      // 新建、导入项目时返回的就是项目本身
      const created = !projectId && value && typeof value === 'object' && 'rounds' in value ? (value as unknown as Project).id : null
      if (projectId ?? created) await this.refresh((projectId ?? created)!)
      return value
    } catch (err) {
      if (err instanceof OfflineError) {
        void this.connect()
        throw new Error(OFFLINE_MSG)
      }
      throw err
    }
  }

  private local(id: string) {
    return this.outbox.find((it) => it.id === id)
  }

  private assertUploaded(bugId: string) {
    if (this.local(bugId)) throw new Error('这条还没上传到服务端，连上后再改截图')
  }

  async addBug(projectId: string, input: NewBug, opts: { png?: Buffer; device?: DeviceInfo | null; marks?: Mark[]; markedPng?: Buffer }): Promise<Bug> {
    if (this.state.status === 'online') {
      try {
        const b = await this.rpc<Bug>('addBug', projectId, input, { ...opts, reporter: this.conn.name })
        await this.refresh(projectId)
        return b
      } catch (err) {
        if (!(err instanceof OfflineError)) throw err
        void this.connect()
      }
    }
    if (!this.projects.has(projectId)) throw new Error('项目不存在')
    return this.enqueue(projectId, input, opts)
  }

  private async enqueue(projectId: string, input: NewBug, opts: { png?: Buffer; device?: DeviceInfo | null; marks?: Mark[]; markedPng?: Buffer }): Promise<Bug> {
    if (!input.text.trim()) throw new Error('问题描述不能为空')
    const it: OutboxItem = {
      id: `local-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      projectId,
      input: { ...input, page: input.page.trim(), text: input.text.trim() },
      device: opts.device ?? null,
      marks: opts.marks ?? [],
      reporter: this.conn.name,
      createdAt: new Date().toISOString(),
      hasShot: !!opts.png,
      hasMarked: !!(opts.png && opts.markedPng && opts.marks?.length)
    }
    if (opts.png) await writeFile(join(this.outDir(), `${it.id}.png`), opts.png)
    if (it.hasMarked) await writeFile(join(this.outDir(), `${it.id}.m.png`), opts.markedPng!)
    await this.writeItem(it)
    this.outbox.push(it)
    this.set({})
    return this.pendingBug(it)
  }

  private writeItem(it: OutboxItem) {
    return writeFile(join(this.outDir(), `${it.id}.json`), JSON.stringify(it), 'utf8')
  }

  private async dropItem(it: OutboxItem) {
    for (const f of [`${it.id}.json`, `${it.id}.png`, `${it.id}.m.png`]) await rm(join(this.outDir(), f), { force: true })
    this.outbox = this.outbox.filter((x) => x !== it)
    this.set({})
  }

  /** 按记录顺序补传，网络又断了就停下等下次 */
  async flush() {
    if (this.flushing) return
    this.flushing = true
    try {
      for (const it of [...this.outbox]) {
        if (this.state.status !== 'online') return
        if (it.error) continue
        try {
          const png = it.hasShot ? await readFile(join(this.outDir(), `${it.id}.png`)) : undefined
          const markedPng = it.hasMarked ? await readFile(join(this.outDir(), `${it.id}.m.png`)) : undefined
          await this.rpc('addBug', it.projectId, it.input, { png, markedPng, marks: it.marks, device: it.device, reporter: it.reporter, createdAt: it.createdAt, late: true })
          await this.dropItem(it)
          await this.refresh(it.projectId)
        } catch (err) {
          if (err instanceof OfflineError) return void this.connect()
          it.error = (err as Error).message
          await this.writeItem(it)
          this.set({})
        }
      }
    } finally {
      this.flushing = false
    }
  }

  async updateBug(projectId: string, bugId: string, patch: Partial<NewBug>, force = false): Promise<Bug> {
    const it = this.local(bugId)
    if (it) {
      it.input = { ...it.input, ...patch }
      delete it.error
      await this.writeItem(it)
      this.set({})
      void this.flush()
      return this.pendingBug(it)
    }
    const base = this.projects.get(projectId)?.bugs.find((b) => b.id === bugId)?.updatedAt
    return this.mutate(projectId, 'updateBug', projectId, bugId, patch, { base, force })
  }

  async deleteBug(projectId: string, bugId: string): Promise<void> {
    const it = this.local(bugId)
    if (it) return this.dropItem(it)
    return this.mutate(projectId, 'deleteBug', projectId, bugId)
  }

  shotOp<T>(method: 'addShot' | 'replaceShot' | 'markShot' | 'deleteShot', projectId: string, bugId: string, ...rest: unknown[]): Promise<T> {
    this.assertUploaded(bugId)
    return this.mutate(projectId, method, projectId, bugId, ...rest)
  }

  async exportZip(projectId: string, scope: ExportScope, outPath: string): Promise<{ bugs: number; shots: number }> {
    const r = await this.mutate<{ bugs: number; shots: number; file: string }>(null, 'exportZip', projectId, scope)
    const res = await this.fetch(`/exports/${encodeURIComponent(r.file)}`, { headers: this.headers() }, this.conn.url, 300_000)
    await writeFile(outPath, Buffer.from(await res.arrayBuffer()))
    return { bugs: r.bugs, shots: r.shots }
  }

  stop() {
    this.gen++
    if (this.retry) clearTimeout(this.retry)
    this.closeStream()
  }
}
