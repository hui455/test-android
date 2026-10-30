import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanMarks } from '../shared/annotate'
import { AI_STATUS, latestRound } from '../shared/logic'
import { moduleFromPage } from '../shared/match'
import { MODULES, type AiStatus, type Bug, type BugDesign, type CheckResult, type Design, type DeviceInfo, type FigmaSource, type Mark, type Module, type NewBug, type Project, type RoundResult, type Screenshot } from '../shared/types'
import { StoreError } from './errors'
import { imageSig, imageType } from './image'

const now = () => new Date().toISOString()
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 12)

export { StoreError }

/** 某个时间点所在的轮次 */
const roundAt = (p: Project, t: string) => [...p.rounds].reverse().find((r) => r.start <= t)?.no ?? 1

/** 保存时发现别人刚改过同一条反馈 */
export class ConflictError extends StoreError {
  constructor(readonly by: string) {
    super(`这条反馈刚被${by || '别人'}修改过`)
  }
}

export interface NewBugOpts {
  png?: Buffer
  device?: DeviceInfo | null
  reporter?: string
  /** 截图上的圈画，和 markedPng 一起传 */
  marks?: Mark[]
  markedPng?: Buffer
  createdAt?: string
  /** 对标机的截图 */
  refPng?: Buffer
  refDevice?: DeviceInfo | null
  /** 客户端离线时记的、连上后才补传：归到记录时所在的轮次，那一轮结束了也收下 */
  late?: boolean
}

async function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, file)
}

/**
 * 项目数据存在本机目录：projects/<id>/project.json + screenshots/*.png。
 * 全部项目常驻内存，每次修改后整份写回对应的 project.json。
 * 只在服务端运行，客户端通过 http.ts 的 /rpc 调用这里的方法。
 */
export class ProjectStore extends EventEmitter {
  private projects = new Map<string, Project>()

  constructor(readonly root: string) {
    super()
  }

  private projectDir = (id: string) => join(this.root, 'projects', id)
  shotDir = (id: string) => join(this.projectDir(id), 'screenshots')
  shotPath = (id: string, file: string) => join(this.shotDir(id), file)
  designDir = (id: string) => join(this.projectDir(id), 'designs')
  designPath = (id: string, file: string) => join(this.designDir(id), file)

  async load(): Promise<void> {
    const dir = join(this.root, 'projects')
    await mkdir(dir, { recursive: true })
    for (const id of await readdir(dir)) {
      const file = join(dir, id, 'project.json')
      if (!existsSync(file)) continue
      try {
        const p = JSON.parse(await readFile(file, 'utf8')) as Project
        this.projects.set(p.id, p)
      } catch (err) {
        console.error(`跳过无法读取的项目 ${file}:`, err)
      }
    }
  }

  list(): Project[] {
    return [...this.projects.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  get(id: string): Project {
    const p = this.projects.get(id)
    if (!p) throw new StoreError(`项目不存在：${id}`)
    return p
  }

  findByName(name: string): Project | undefined {
    return this.list().find((p) => p.name === name)
  }

  private async save(p: Project) {
    await mkdir(this.shotDir(p.id), { recursive: true })
    await writeJsonAtomic(join(this.projectDir(p.id), 'project.json'), p)
    this.emit('changed', p.id)
  }

  private bug(p: Project, bugId: string): Bug {
    const b = p.bugs.find((x) => x.id === bugId)
    if (!b) throw new StoreError(`反馈不存在：${bugId}`)
    return b
  }

  private assertTesting(p: Project) {
    if (latestRound(p).end) throw new StoreError(`第${p.rounds.length}轮已结束，请先开始新一轮复测`)
  }

  async createProject(input: { name: string; developer?: string; type?: string; createdBy?: 'user' | 'agent' }): Promise<Project> {
    const name = input.name.trim()
    if (!name) throw new StoreError('项目名称不能为空')
    if (this.findByName(name)) throw new StoreError(`已有同名项目：${name}`)
    const t = now()
    const p: Project = {
      id: shortId(),
      name,
      developer: input.developer?.trim() ?? '',
      type: input.type?.trim() || '马甲',
      createdAt: t,
      createdBy: input.createdBy ?? 'user',
      rounds: [{ no: 1, start: t, end: null, result: 'fail' }],
      bugs: [],
      nextSeq: 1
    }
    this.projects.set(p.id, p)
    await this.save(p)
    return p
  }

  async updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'developer' | 'type' | 'refApp'>>): Promise<Project> {
    const p = this.get(id)
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw new StoreError('项目名称不能为空')
      const other = this.findByName(name)
      if (other && other.id !== id) throw new StoreError(`已有同名项目：${name}`)
      p.name = name
    }
    if (patch.developer !== undefined) p.developer = patch.developer.trim()
    if (patch.type !== undefined) p.type = patch.type.trim()
    if (patch.refApp !== undefined) p.refApp = !!patch.refApp
    await this.save(p)
    return p
  }

  async deleteProject(id: string): Promise<void> {
    this.get(id)
    this.projects.delete(id)
    await rm(this.projectDir(id), { recursive: true, force: true })
    this.emit('changed', id)
  }

  async addBug(projectId: string, input: NewBug, opts: NewBugOpts = {}): Promise<Bug> {
    const p = this.get(projectId)
    if (!opts.late) this.assertTesting(p)
    if (!MODULES.includes(input.module)) throw new StoreError(`未知模块：${input.module}`)
    if (!input.text.trim()) throw new StoreError('问题描述不能为空')
    const t = now()
    const b: Bug = {
      id: shortId(),
      seq: p.nextSeq++,
      module: input.module,
      page: input.page.trim(),
      text: input.text.trim(),
      mode: input.mode,
      round: opts.late && opts.createdAt ? roundAt(p, opts.createdAt) : p.rounds.length,
      checks: {},
      shots: [],
      device: opts.device ?? null,
      reporter: opts.reporter ?? '',
      design: this.checkDesign(p, input.design),
      createdAt: opts.createdAt ?? t,
      updatedAt: t
    }
    p.bugs.push(b)
    if (opts.png) {
      const s = await this.writeShot(p, b, opts.png)
      b.shots.push(s)
      const marks = cleanMarks(opts.marks ?? [])
      if (marks.length && opts.markedPng) {
        s.marks = marks
        s.marked = `${s.file.replace(/\.png$/, '')}_m${Date.now().toString(36)}.png`
        await writeFile(this.shotPath(p.id, s.marked), opts.markedPng)
      }
    }
    if (opts.refPng) b.shots.push({ ...(await this.writeShot(p, b, opts.refPng)), ref: true, device: opts.refDevice ?? null })
    await this.save(p)
    return b
  }

  /** base 是客户端看到的 updatedAt，和现在的不一致说明别人改过，force 时直接覆盖 */
  async updateBug(projectId: string, bugId: string, patch: Partial<NewBug>, opts: { by?: string; base?: string; force?: boolean } = {}): Promise<Bug> {
    const p = this.get(projectId)
    const b = this.bug(p, bugId)
    if (opts.base && !opts.force && opts.base !== b.updatedAt) throw new ConflictError(b.updatedBy ?? '')
    if (patch.module !== undefined) {
      if (!MODULES.includes(patch.module)) throw new StoreError(`未知模块：${patch.module}`)
      b.module = patch.module
    }
    if (patch.page !== undefined) b.page = patch.page.trim()
    if (patch.text !== undefined) {
      if (!patch.text.trim()) throw new StoreError('问题描述不能为空')
      b.text = patch.text.trim()
    }
    if (patch.mode !== undefined) b.mode = patch.mode
    if (patch.design !== undefined) b.design = this.checkDesign(p, patch.design)
    b.updatedAt = now()
    if (opts.by !== undefined) b.updatedBy = opts.by
    await this.save(p)
    return b
  }

  async deleteBug(projectId: string, bugId: string): Promise<void> {
    const p = this.get(projectId)
    const b = this.bug(p, bugId)
    for (const s of b.shots) await this.removeFiles(p, s)
    p.bugs = p.bugs.filter((x) => x !== b)
    await this.save(p)
  }

  private async writeShot(p: Project, b: Bug, png: Buffer): Promise<Screenshot> {
    await mkdir(this.shotDir(p.id), { recursive: true })
    const file = `${String(b.seq).padStart(3, '0')}_${Date.now()}_${shortId().slice(0, 4)}.png`
    await writeFile(this.shotPath(p.id, file), png)
    return { file, takenAt: now() }
  }

  private async removeFiles(p: Project, s: Screenshot) {
    for (const f of [s.file, s.marked]) if (f) await unlink(this.shotPath(p.id, f)).catch(() => {})
  }

  /** 保存圈画标注；marks 为空时清掉标注，png 是画好标注的图片 */
  async markShot(projectId: string, bugId: string, index: number, marks: Mark[], png: Buffer | null): Promise<Bug> {
    const p = this.get(projectId)
    const b = this.bug(p, bugId)
    const s = b.shots[index]
    if (!s) throw new StoreError('截图不存在')
    const clean = cleanMarks(marks)
    if (clean.length && !png) throw new StoreError('缺少标注后的图片')
    const old = s.marked
    if (clean.length) {
      const file = `${s.file.replace(/\.png$/, '')}_m${Date.now().toString(36)}.png`
      await writeFile(this.shotPath(p.id, file), png!)
      s.marks = clean
      s.marked = file
    } else {
      delete s.marks
      delete s.marked
    }
    if (old) await unlink(this.shotPath(p.id, old)).catch(() => {})
    b.updatedAt = now()
    await this.save(p)
    return b
  }

  async addShot(projectId: string, bugId: string, png: Buffer, opts: { ref?: boolean; device?: DeviceInfo | null } = {}): Promise<Bug> {
    const p = this.get(projectId)
    const b = this.bug(p, bugId)
    const s = await this.writeShot(p, b, png)
    b.shots.push(opts.ref ? { ...s, ref: true, device: opts.device ?? null } : s)
    b.updatedAt = now()
    await this.save(p)
    return b
  }

  async replaceShot(projectId: string, bugId: string, index: number, png: Buffer): Promise<Bug> {
    const p = this.get(projectId)
    const b = this.bug(p, bugId)
    const old = b.shots[index]
    if (!old) throw new StoreError('截图不存在')
    const s = await this.writeShot(p, b, png)
    b.shots[index] = old.ref ? { ...s, ref: true, device: old.device ?? null } : s
    await this.removeFiles(p, old)
    b.updatedAt = now()
    await this.save(p)
    return b
  }

  async deleteShot(projectId: string, bugId: string, index: number): Promise<Bug> {
    const p = this.get(projectId)
    const b = this.bug(p, bugId)
    const [old] = b.shots.splice(index, 1)
    if (!old) throw new StoreError('截图不存在')
    await this.removeFiles(p, old)
    b.updatedAt = now()
    await this.save(p)
    return b
  }

  async readShot(projectId: string, file: string): Promise<Buffer> {
    const p = this.get(projectId)
    if (!p.bugs.some((b) => b.shots.some((s) => s.file === file || s.marked === file))) throw new StoreError('截图不存在')
    return readFile(this.shotPath(projectId, file))
  }

  /** AI 反馈只是提示，不改复测结果，也不改 updatedAt（免得测试人员正在编辑时提示冲突）；再写一次替换上一条 */
  async markAiFixed(projectId: string, bugId: string, summary: string, by: string, status: AiStatus = 'fixed'): Promise<Bug> {
    const p = this.get(projectId)
    const b = this.bug(p, bugId)
    if (!summary.trim()) throw new StoreError(status === 'fixed' ? '请写明改了什么' : '请写明原因')
    if (!(status in AI_STATUS)) throw new StoreError(`不认识的状态：${status}`)
    b.aiFix = { status, summary: summary.trim().slice(0, 2000), by, at: now(), round: p.rounds.length }
    await this.save(p)
    return b
  }

  async setCheck(projectId: string, bugId: string, result: CheckResult | null): Promise<Bug> {
    const p = this.get(projectId)
    const b = this.bug(p, bugId)
    const r = p.rounds.length
    if (b.round >= r) throw new StoreError('本轮新增的问题不需要复测')
    if (result) b.checks[r] = result
    else delete b.checks[r]
    b.updatedAt = now()
    await this.save(p)
    return b
  }

  /** 把客户端旧版本（本机存储）的项目搬到服务端；重名时在名字后面加上来源 */
  async importProject(src: Project, files: Record<string, Buffer>, from: string): Promise<Project> {
    let name = src.name
    for (let i = 1; this.findByName(name); i++) name = `${src.name}（${from || '导入'}${i > 1 ? i : ''}）`
    const p: Project = { ...src, id: shortId(), name, bugs: src.bugs.map((b) => ({ ...b, reporter: b.reporter || from })) }
    await mkdir(this.shotDir(p.id), { recursive: true })
    for (const [file, data] of Object.entries(files)) {
      if (/[\\/]/.test(file) || !file.endsWith('.png')) throw new StoreError(`截图文件名不对：${file}`)
      await writeFile(this.shotPath(p.id, file), data)
    }
    this.projects.set(p.id, p)
    await this.save(p)
    return p
  }

  /** 关联的设计稿不存在（比如刚被删掉）时就不关联 */
  private checkDesign(p: Project, d: BugDesign | null | undefined): BugDesign | null {
    if (!d || !p.designs?.some((x) => x.id === d.id)) return null
    return { id: d.id, score: typeof d.score === 'number' ? Math.max(0, Math.min(1, d.score)) : null }
  }

  // ---------- 设计稿 ----------

  /** 同一页面下同名的画板视为同一个，重新上传会更新图片，已关联的反馈不受影响 */
  async upsertDesign(projectId: string, input: { page: string; name: string; image: Buffer; module?: Module | ''; figmaUrl?: string }, by = ''): Promise<Design> {
    const p = this.get(projectId)
    const page = input.page.trim()
    const name = input.name.trim()
    if (!name) throw new StoreError('画板名称不能为空')
    if (input.module && !MODULES.includes(input.module)) throw new StoreError(`未知模块：${input.module}`)
    const type = imageType(input.image)
    if (!type) throw new StoreError(`“${name}”的图片不是 PNG 或 JPG`)
    const { width, height, sig } = imageSig(input.image)
    p.designs ??= []
    const old = p.designs.find((d) => d.page === page && d.name === name)
    const id = old?.id ?? shortId()
    // 换文件名：客户端按文件名缓存图片
    const file = `${id}_${Date.now().toString(36)}.${type}`
    await mkdir(this.designDir(p.id), { recursive: true })
    await writeFile(this.designPath(p.id, file), input.image)
    const d: Design = {
      id,
      page,
      name,
      module: input.module || old?.module || moduleFromPage(page),
      file,
      width,
      height,
      figmaUrl: input.figmaUrl?.trim() ?? old?.figmaUrl ?? '',
      sig,
      uploadedBy: by,
      updatedAt: now()
    }
    if (old) {
      await unlink(this.designPath(p.id, old.file)).catch(() => {})
      p.designs[p.designs.indexOf(old)] = d
    } else p.designs.push(d)
    await this.save(p)
    return d
  }

  async deleteDesign(projectId: string, designId: string): Promise<void> {
    const p = this.get(projectId)
    const d = p.designs?.find((x) => x.id === designId)
    if (!d) throw new StoreError('设计稿不存在')
    p.designs = p.designs!.filter((x) => x !== d)
    for (const b of p.bugs) if (b.design?.id === d.id) b.design = null
    await unlink(this.designPath(p.id, d.file)).catch(() => {})
    await this.save(p)
  }

  async setFigma(projectId: string, src: FigmaSource | null): Promise<Project> {
    const p = this.get(projectId)
    p.figma = src && (src.name.trim() || src.url.trim()) ? { name: src.name.trim(), url: src.url.trim() } : null
    await this.save(p)
    return p
  }

  async readDesign(projectId: string, file: string): Promise<Buffer> {
    const p = this.get(projectId)
    if (!p.designs?.some((d) => d.file === file)) throw new StoreError('设计稿不存在')
    return readFile(this.designPath(projectId, file))
  }

  async startRound(projectId: string): Promise<Project> {
    const p = this.get(projectId)
    if (!latestRound(p).end) throw new StoreError(`第${p.rounds.length}轮还在测试中，先结束本轮`)
    p.rounds.push({ no: p.rounds.length + 1, start: now(), end: null, result: 'fail' })
    await this.save(p)
    return p
  }

  async endRound(projectId: string, result: RoundResult): Promise<Project> {
    const p = this.get(projectId)
    const round = latestRound(p)
    if (round.end) throw new StoreError(`第${round.no}轮已经结束`)
    round.end = now()
    round.result = result
    await this.save(p)
    return p
  }

  /** 修改某一轮的结果（结束后发现记错时用） */
  async setRoundResult(projectId: string, no: number, result: RoundResult): Promise<Project> {
    const p = this.get(projectId)
    const round = p.rounds[no - 1]
    if (!round) throw new StoreError(`没有第${no}轮`)
    round.result = result
    await this.save(p)
    return p
  }
}
