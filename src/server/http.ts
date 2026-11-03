import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { basename, join } from 'node:path'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { summarize } from '../shared/logic'
import { PROTOCOL, type OnlineClient, type ServerInfo } from '../shared/types'
import type { ConfigStore } from './config'
import { exportBaseName, exportZip, type ExportScope } from './exporter'
import { AGENT, buildMcp } from './mcp'
import { SelfTestStore } from './selftest'
import { ConflictError, StoreError, type ProjectStore } from './store'
import { webPage } from './webpage'
import { CLIENT_HEADER, decode, DEV_HEADER, encode } from './wire'

export function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')) return ni.address
    }
  }
  return '127.0.0.1'
}

export interface ServerStatus {
  running: boolean
  address: string
  port: number
  webUrl: string
  mcpUrl: string
  error: string
}

const MAX_BODY = 64 * 1024 * 1024

/** none：令牌不对；team：团队令牌（测试人员）；dev：自测令牌（开发和验收的人），能做团队令牌的所有事，外加开发自测 */
export type Access = 'none' | 'team' | 'dev'
const clock = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

async function readBody(req: IncomingMessage): Promise<string> {
  return (await readRaw(req)).toString('utf8')
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) throw new StoreError('请求太大')
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * BugShot 服务端：所有数据只存在这里。
 * - /rpc 给桌面客户端读写数据，/events 推送变化
 * - /mcp 给 AI agent
 * - / 是只读网页，/api/* 给网页用
 * - 开发自测（/api/selftest、/selftest/*、rpc 的 self* 方法、MCP 的 selftest_* 工具）只认自测令牌
 */
export class BugShotServer extends EventEmitter {
  private server: Server | null = null
  status: ServerStatus = { running: false, address: '', port: 0, webUrl: '', mcpUrl: '', error: '' }
  private streams = new Map<ServerResponse, OnlineClient & { dev: boolean }>()
  readonly selftest: SelfTestStore
  private agents = new Map<string, OnlineClient>()
  private keepalive: NodeJS.Timeout | null = null

  constructor(
    private store: ProjectStore,
    private config: ConfigStore,
    private exportDir: string,
    private version: string
  ) {
    super()
    this.selftest = new SelfTestStore(store)
    store.on('changed', (id: string) => this.push('changed', { id }))
    this.selftest.on('changed', (id: string) => this.push('selftest', { id }, true))
  }

  info(): ServerInfo {
    const c = this.config.value
    return { app: 'bugshot-server', name: c.name, address: this.status.address || lanAddress(), version: this.version, protocol: PROTOCOL, port: c.port, needToken: c.requireToken, readOnly: c.readOnly }
  }

  /** 在线的客户端（连着 /events 的）和最近 10 分钟访问过的 AI agent */
  clients(): OnlineClient[] {
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const [k, a] of this.agents) if (Date.parse(a.last) < cutoff) this.agents.delete(k)
    return [...[...this.streams.values()].map(({ dev: _, ...c }) => c), ...this.agents.values()]
  }

  async start(): Promise<ServerStatus> {
    await this.stop()
    const port = this.config.value.port
    await mkdir(this.exportDir, { recursive: true })
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error(err)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '服务器错误' }))
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => resolve())
      })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      this.status = { ...this.status, running: false, error: e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请换一个端口` : e.message }
      return this.status
    }
    this.server = server
    const address = lanAddress()
    const base = `http://${address}:${port}`
    this.status = { running: true, address, port, webUrl: base, mcpUrl: `${base}/mcp`, error: '' }
    this.keepalive = setInterval(() => {
      for (const res of this.streams.keys()) res.write(': ping\n\n')
    }, 25_000)
    return this.status
  }

  async stop() {
    const s = this.server
    this.server = null
    this.status = { ...this.status, running: false }
    if (this.keepalive) clearInterval(this.keepalive)
    for (const res of this.streams.keys()) res.end()
    this.streams.clear()
    if (s) {
      s.closeAllConnections()
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
  }

  /** devOnly：开发自测的消息只发给带自测令牌的客户端，测试人员收不到 */
  private push(event: string, data: unknown, devOnly = false) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const [res, c] of this.streams) if (!devOnly || c.dev) res.write(msg)
    if (event === 'clients' || event === 'activity') this.emit('clients')
  }

  /** AI agent 改了数据，告诉所有客户端；开发自测的只告诉带自测令牌的 */
  activity(msg: string, devOnly = false) {
    this.push('activity', { msg }, devOnly)
  }

  private access(req: IncomingMessage, url: URL): Access {
    const c = this.config.value
    const header = req.headers.authorization ?? ''
    if (c.devToken && (header === `Bearer ${c.devToken}` || req.headers[DEV_HEADER] === c.devToken)) return 'dev'
    if (!c.requireToken) return 'team'
    const cookie = /(?:^|;\s*)bugshot_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    return header === `Bearer ${c.token}` || url.searchParams.get('token') === c.token || cookie === c.token ? 'team' : 'none'
  }

  private clientName(req: IncomingMessage): string {
    const raw = req.headers[CLIENT_HEADER]
    try {
      return decodeURIComponent(String(raw ?? '')).slice(0, 40)
    } catch {
      return ''
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local')
    const json = (code: number, data: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(data))
    }

    // 不需要口令：客户端连接前先确认这是 BugShot 服务端
    if (url.pathname === '/api/info') return json(200, this.info())

    const access = this.access(req, url)
    if (access === 'none') {
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        res.end(webPage({ needToken: true }))
      } else json(401, { error: '团队令牌不对' })
      return
    }

    const dev = access === 'dev'
    if (url.pathname === '/mcp') return this.handleMcp(req, res, dev)
    if (url.pathname === '/rpc' && req.method === 'POST') return this.handleRpc(req, res, json, dev)
    if (url.pathname === '/events') return this.handleEvents(req, res, dev)
    if (url.pathname === '/api/designs' && req.method === 'POST') return this.handleDesignUpload(req, res, url, json)

    // 开发自测：测试人员（团队令牌）一律当作不存在
    const selfPath = url.pathname === '/api/selftest' || url.pathname.startsWith('/api/selftest/') || url.pathname.startsWith('/selftest/')
    if (selfPath && !dev) return json(403, { error: '自测令牌不对', code: 'dev' })
    if (url.pathname === '/api/selftest' && req.method === 'POST') return this.handleSelfUpload(req, url, json)

    if (req.method !== 'GET') return json(405, { error: '不支持' })

    if (url.pathname === '/') {
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }
      if (url.searchParams.get('token')) headers['set-cookie'] = `bugshot_token=${url.searchParams.get('token')}; Path=/; HttpOnly; SameSite=Lax`
      res.writeHead(200, headers)
      return res.end(webPage({ needToken: false }))
    }
    if (url.pathname === '/api/projects') return json(200, this.store.list().map(summarize))
    if (url.pathname === '/api/state') return json(200, this.store.list())
    if (url.pathname === '/api/selftest') return json(200, await this.selftest.all())
    let m = /^\/api\/projects\/([^/]+)$/.exec(url.pathname)
    if (m) {
      try {
        return json(200, this.store.get(decodeURIComponent(m[1])))
      } catch {
        return json(404, { error: '项目不存在' })
      }
    }
    m = /^\/api\/selftest\/([^/]+)$/.exec(url.pathname)
    if (m) {
      try {
        return json(200, await this.selftest.get(decodeURIComponent(m[1])))
      } catch {
        return json(404, { error: '项目不存在' })
      }
    }
    m = /^\/selftest\/([^/]+)\/([^/]+\.(png|jpg))$/.exec(url.pathname)
    if (m) {
      try {
        const img = await this.selftest.readFile(decodeURIComponent(m[1]), decodeURIComponent(m[2]))
        res.writeHead(200, { 'content-type': m[3] === 'jpg' ? 'image/jpeg' : 'image/png', 'cache-control': 'max-age=31536000, immutable' })
        return res.end(img)
      } catch {
        return json(404, { error: '截图不存在' })
      }
    }
    m = /^\/shots\/([^/]+)\/([^/]+\.png)$/.exec(url.pathname)
    if (m) {
      try {
        const png = await this.store.readShot(decodeURIComponent(m[1]), decodeURIComponent(m[2]))
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=31536000, immutable' })
        return res.end(png)
      } catch {
        return json(404, { error: '截图不存在' })
      }
    }
    m = /^\/designs\/([^/]+)\/([^/]+\.(png|jpg))$/.exec(url.pathname)
    if (m) {
      try {
        const img = await this.store.readDesign(decodeURIComponent(m[1]), decodeURIComponent(m[2]))
        res.writeHead(200, { 'content-type': m[3] === 'jpg' ? 'image/jpeg' : 'image/png', 'cache-control': 'max-age=31536000, immutable' })
        return res.end(img)
      } catch {
        return json(404, { error: '设计稿不存在' })
      }
    }
    m = /^\/exports\/([^/]+\.zip)$/.exec(url.pathname)
    if (m) {
      const file = join(this.exportDir, basename(decodeURIComponent(m[1])))
      if (!existsSync(file)) return json(404, { error: '文件不存在' })
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(file))}` })
      return createReadStream(file).pipe(res)
    }
    json(404, { error: '未找到' })
  }

  /**
   * 给 AI agent 用 curl 传本地图片：
   * POST /api/designs?project=<项目名或 id>&page=<Figma 页面名>&name=<画板名>，请求体是 PNG/JPG
   */
  private async handleDesignUpload(req: IncomingMessage, res: ServerResponse, url: URL, json: (code: number, data: unknown) => void) {
    const q = (k: string) => url.searchParams.get(k) ?? ''
    try {
      if (this.config.value.readOnly) throw new StoreError('BugShot 服务端设置为只读，AI agent 不能修改数据')
      const ref = q('project')
      const p = this.store.list().find((x) => x.id === ref) ?? this.store.findByName(ref.trim())
      if (!p) throw new StoreError(`找不到项目：${ref}`)
      const d = await this.store.upsertDesign(p.id, { page: q('page'), name: q('name'), image: await readRaw(req), module: (q('module') || undefined) as never, figmaUrl: q('figma_url') || undefined, box: q('w') ? { x: Number(q('x')), y: Number(q('y')), w: Number(q('w')), h: Number(q('h')) } : undefined }, this.clientName(req) || AGENT)
      this.activity(`给“${p.name}”上传设计稿“${d.name}”`)
      json(200, { ok: true, id: d.id, page: d.page, name: d.name, module: d.module })
    } catch (err) {
      json(400, { error: err instanceof StoreError ? err.message : (err as Error).message })
    }
  }

  /**
   * 给开发的 AI 用 curl 直接传手机截图（要自测令牌）：
   * adb exec-out screencap -p | curl -X POST --data-binary @- -H "Authorization: Bearer <自测令牌>" "<地址>/api/selftest?project=<项目>&name=<页面名>&note=<改了什么>"
   */
  private async handleSelfUpload(req: IncomingMessage, url: URL, json: (code: number, data: unknown) => void) {
    const q = (k: string) => url.searchParams.get(k) ?? ''
    try {
      if (this.config.value.readOnly) throw new StoreError('BugShot 服务端设置为只读，AI agent 不能修改数据')
      const ref = q('project')
      const p = this.store.list().find((x) => x.id === ref) ?? this.store.findByName(ref.trim())
      if (!p) throw new StoreError(`找不到项目：${ref}`)
      const pg = await this.selftest.upload(
        p.id,
        { name: q('name'), image: await readRaw(req), module: (q('module') || undefined) as never, note: q('note') || undefined, design: q('design') || undefined, device: q('device') || undefined, activity: q('activity') || undefined },
        this.clientName(req) || AGENT
      )
      this.activity(`给“${p.name}”的开发自测上传“${pg.name}” v${pg.shots.length}`, true)
      json(200, { ok: true, page: pg.name, version: pg.shots.length, status: pg.status, design: pg.design })
    } catch (err) {
      json(400, { error: err instanceof StoreError ? err.message : (err as Error).message })
    }
  }

  private handleEvents(req: IncomingMessage, res: ServerResponse, dev: boolean) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(`event: hello\ndata: ${JSON.stringify(this.info())}\n\n`)
    this.streams.set(res, { name: this.clientName(req) || '未命名', kind: 'client', detail: '', address: req.socket.remoteAddress ?? '', last: new Date().toISOString(), dev })
    this.push('clients', {})
    req.on('close', () => {
      this.streams.delete(res)
      this.push('clients', {})
    })
  }

  private async handleRpc(req: IncomingMessage, res: ServerResponse, json: (code: number, data: unknown) => void, dev: boolean) {
    let call: { method: string; args: unknown[] }
    try {
      call = decode(JSON.parse(await readBody(req))) as typeof call
    } catch (err) {
      return json(400, { error: err instanceof StoreError ? err.message : '请求格式不对' })
    }
    const by = this.clientName(req)
    try {
      if (call.method.startsWith('self') && !dev) return json(403, { error: '自测令牌不对', code: 'dev' })
      const value = await this.dispatch(call.method, Array.isArray(call.args) ? call.args : [], by, req)
      json(200, { value: encode(value ?? null) })
    } catch (err) {
      if (err instanceof ConflictError) return json(409, { error: err.message, code: 'conflict', by: err.by })
      if (err instanceof StoreError) return json(400, { error: err.message })
      console.error(err)
      json(500, { error: (err as Error).message || '服务器错误' })
    }
  }

  private async dispatch(method: string, a: any[], by: string, req: IncomingMessage): Promise<unknown> {
    const s = this.store
    switch (method) {
      case 'hello': {
        for (const c of this.streams.values()) if (c.name === (by || '未命名') && c.address === req.socket.remoteAddress) c.detail = String(a[0] ?? '')
        this.push('clients', {})
        return this.info()
      }
      case 'createProject':
        return s.createProject({ name: a[0]?.name ?? '', developer: a[0]?.developer, type: a[0]?.type, createdBy: 'user' })
      case 'updateProject':
        return s.updateProject(a[0], a[1] ?? {})
      case 'deleteProject':
        return s.deleteProject(a[0])
      case 'addBug':
        return s.addBug(a[0], a[1], { ...(a[2] ?? {}), reporter: a[2]?.reporter || by })
      case 'updateBug':
        return s.updateBug(a[0], a[1], a[2] ?? {}, { ...(a[3] ?? {}), by })
      case 'deleteBug':
        return s.deleteBug(a[0], a[1])
      case 'setCheck':
        return s.setCheck(a[0], a[1], a[2] ?? null)
      case 'startRound':
        return s.startRound(a[0])
      case 'endRound':
        return s.endRound(a[0], a[1])
      case 'setRoundResult':
        return s.setRoundResult(a[0], a[1], a[2])
      case 'addShot':
        return s.addShot(a[0], a[1], a[2], a[3] ?? {})
      case 'replaceShot':
        return s.replaceShot(a[0], a[1], a[2], a[3])
      case 'markShot':
        return s.markShot(a[0], a[1], a[2], a[3] ?? [], a[4] ?? null)
      case 'deleteShot':
        return s.deleteShot(a[0], a[1], a[2])
      case 'exportZip': {
        const p = s.get(a[0])
        const scope = a[1] as ExportScope
        const file = `${exportBaseName(p, scope)}.zip`
        const r = await exportZip(s, p.id, scope, join(this.exportDir, file))
        return { ...r, file }
      }
      case 'upsertDesign':
        return s.upsertDesign(a[0], a[1], by)
      case 'deleteDesign':
        return s.deleteDesign(a[0], a[1])
      case 'importProject':
        return s.importProject(a[0], a[1] ?? {}, by)
      // 开发自测（handleRpc 已检查自测令牌）
      case 'selfEnable':
        return this.selftest.setEnabled(a[0], !!a[1])
      case 'selfComment':
        return this.selftest.comment(a[0], a[1], a[2] ?? {}, by)
      case 'selfPass':
        return this.selftest.setPassed(a[0], a[1], !!a[2], by)
      case 'selfDesign':
        return this.selftest.setDesign(a[0], a[1], a[2] ?? null)
      case 'selfDelete':
        return this.selftest.deletePage(a[0], a[1])
      default:
        throw new StoreError(`未知操作：${method}`)
    }
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse, dev: boolean) {
    const address = req.socket.remoteAddress ?? ''
    const seen = this.agents.get(address)
    this.agents.set(address, { name: this.clientName(req) || AGENT, kind: 'mcp', detail: seen?.detail ?? '', address, last: new Date().toISOString() })
    let body: unknown
    if (req.method === 'POST') {
      try {
        body = JSON.parse((await readBody(req)) || 'null')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }))
      }
    }
    const c = this.config.value
    // 无状态模式：每个请求一个独立的 server + transport
    const server = buildMcp({
      store: this.store,
      selftest: dev ? this.selftest : null,
      exportDir: this.exportDir,
      version: this.version,
      readOnly: () => this.config.value.readOnly,
      webUrl: () => this.status.webUrl,
      token: () => (c.requireToken ? c.token : null),
      activity: (msg, devOnly) => {
        const a = this.agents.get(address)
        if (a) a.detail = `${clock()} ${msg}`
        this.activity(msg, devOnly)
      }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
}
