import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { latestRound } from '../shared/logic'
import { MODULES, type Bug, type CheckResult, type DeviceInfo, type NewBug, type Project, type RoundResult } from '../shared/types'

const now = () => new Date().toISOString()
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 12)

export class StoreError extends Error {}

async function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, file)
}

/**
 * 项目数据存在本机目录：projects/<id>/project.json + screenshots/*.png。
 * 全部项目常驻内存，每次修改后整份写回对应的 project.json。
 */
export class ProjectStore extends EventEmitter {
  private projects = new Map<string, Project>()

  constructor(readonly root: string) {
    super()
  }

  private projectDir = (id: string) => join(this.root, 'projects', id)
  shotDir = (id: string) => join(this.projectDir(id), 'screenshots')
  shotPath = (id: string, file: string) => join(this.shotDir(id), file)

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

  async updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'developer' | 'type'>>): Promise<Project> {
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
    await this.save(p)
    return p
  }

  async deleteProject(id: string): Promise<void> {
    this.get(id)
    this.projects.delete(id)
    await rm(this.projectDir(id), { recursive: true, force: true })
    this.emit('changed', id)
  }

  async addBug(projectId: string, input: NewBug, opts: { png?: Buffer; device?: DeviceInfo | null } = {}): Promise<Bug> {
    const p = this.get(projectId)
    this.assertTesting(p)
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
      round: p.rounds.length,
      checks: {},
      shots: [],
      device: opts.device ?? null,
      createdAt: t,
      updatedAt: t
    }
    p.bugs.push(b)
    if (opts.png) b.shots.push(await this.writeShot(p, b, opts.png))
    await this.save(p)
    return b
  }

  async updateBug(projectId: string, bugId: string, patch: Partial<NewBug>): Promise<Bug> {
    const p = this.get(projectId)
    const b = this.bug(p, bugId)
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
    b.updatedAt = now()
    await this.save(p)
    return b
  }

  async deleteBug(projectId: string, bugId: string): Promise<void> {
    const p = this.get(projectId)
    const b = this.bug(p, bugId)
    for (const s of b.shots) await unlink(this.shotPath(p.id, s.file)).catch(() => {})
    p.bugs = p.bugs.filter((x) => x !== b)
    await this.save(p)
  }

  private async writeShot(p: Project, b: Bug, png: Buffer) {
    await mkdir(this.shotDir(p.id), { recursive: true })
    const file = `${String(b.seq).padStart(3, '0')}_${Date.now()}_${shortId().slice(0, 4)}.png`
    await writeFile(this.shotPath(p.id, file), png)
    return { file, takenAt: now() }
  }

  async addShot(projectId: string, bugId: string, png: Buffer): Promise<Bug> {
    const p = this.get(projectId)
    const b = this.bug(p, bugId)
    b.shots.push(await this.writeShot(p, b, png))
    b.updatedAt = now()
    await this.save(p)
    return b
  }

  async replaceShot(projectId: string, bugId: string, index: number, png: Buffer): Promise<Bug> {
    const p = this.get(projectId)
    const b = this.bug(p, bugId)
    const old = b.shots[index]
    if (!old) throw new StoreError('截图不存在')
    b.shots[index] = await this.writeShot(p, b, png)
    await unlink(this.shotPath(p.id, old.file)).catch(() => {})
    b.updatedAt = now()
    await this.save(p)
    return b
  }

  async deleteShot(projectId: string, bugId: string, index: number): Promise<Bug> {
    const p = this.get(projectId)
    const b = this.bug(p, bugId)
    const [old] = b.shots.splice(index, 1)
    if (!old) throw new StoreError('截图不存在')
    await unlink(this.shotPath(p.id, old.file)).catch(() => {})
    b.updatedAt = now()
    await this.save(p)
    return b
  }

  async readShot(projectId: string, file: string): Promise<Buffer> {
    const p = this.get(projectId)
    if (!p.bugs.some((b) => b.shots.some((s) => s.file === file))) throw new StoreError('截图不存在')
    return readFile(this.shotPath(projectId, file))
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
