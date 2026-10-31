import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanMarks } from '../shared/annotate'
import { AUTO_MATCH, decodeSig, moduleFromPage, rankDesigns } from '../shared/match'
import { MODULES, type BugDesign, type Design, type Mark, type Module, type Project, type SelfTest, type SelfTestMsg, type SelfTestPage } from '../shared/types'
import { StoreError } from './errors'
import { imageSig, imageType } from './image'
import type { ProjectStore } from './store'

const now = () => new Date().toISOString()
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 12)

export interface SelfShotInput {
  name: string
  image: Buffer
  module?: Module | ''
  /** AI 写的说明，比如“按评论改了什么” */
  note?: string
  /** 指定设计稿：id、画板名或“页面名/画板名”，不填自动匹配 */
  design?: string
  device?: string
  activity?: string
}

/** 设计稿 id、画板名，或“页面名/画板名” */
export function findDesign(p: Project, ref: string): Design | undefined {
  const list = p.designs ?? []
  const r = ref.trim()
  return list.find((x) => x.id === r) ?? list.find((x) => x.name === r) ?? list.find((x) => `${x.page}/${x.name}` === r)
}

/**
 * 开发自测的数据：projects/<id>/selftest.json + selftest/*.png。
 * 和正式测试的 project.json 分开存，只有带自测令牌的请求能读写（见 http.ts）。
 */
export class SelfTestStore extends EventEmitter {
  private cache = new Map<string, SelfTest>()

  constructor(private projects: ProjectStore) {
    super()
  }

  private dir = (id: string) => join(this.projects.root, 'projects', id)
  shotDir = (id: string) => join(this.dir(id), 'selftest')
  private jsonFile = (id: string) => join(this.dir(id), 'selftest.json')

  async get(projectId: string): Promise<SelfTest> {
    try {
      this.projects.get(projectId)
    } catch (err) {
      this.cache.delete(projectId)
      throw err
    }
    let t = this.cache.get(projectId)
    if (!t) {
      t = { projectId, enabled: false, pages: [] }
      if (existsSync(this.jsonFile(projectId))) {
        try {
          t = JSON.parse(await readFile(this.jsonFile(projectId), 'utf8')) as SelfTest
        } catch (err) {
          console.error(`开发自测数据无法读取 ${projectId}:`, err)
        }
      }
      this.cache.set(projectId, t)
    }
    return t
  }

  /** 打开了开发自测、或者已经有自测页面的项目 */
  async all(): Promise<SelfTest[]> {
    const out: SelfTest[] = []
    for (const p of this.projects.list()) {
      const t = await this.get(p.id)
      if (t.enabled || t.pages.length) out.push(t)
    }
    return out
  }

  private async save(t: SelfTest) {
    await mkdir(this.shotDir(t.projectId), { recursive: true })
    const file = this.jsonFile(t.projectId)
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(t, null, 2), 'utf8')
    await rename(tmp, file)
    this.emit('changed', t.projectId)
  }

  findPage(t: SelfTest, ref: string): SelfTestPage {
    const r = ref.trim()
    const pg = t.pages.find((x) => x.id === r) ?? t.pages.find((x) => x.name === r)
    if (!pg) throw new StoreError(`开发自测里没有这个页面：${ref}`)
    return pg
  }

  async setEnabled(projectId: string, on: boolean): Promise<SelfTest> {
    const t = await this.get(projectId)
    t.enabled = !!on
    await this.save(t)
    return t
  }

  /** 自动匹配最像的设计稿，不够像就不关联 */
  private match(p: Project, sig: string): BugDesign | null {
    const s = decodeSig(sig)
    const top = s ? rankDesigns(s, p.designs ?? [], 1)[0] : undefined
    return top && top.score >= AUTO_MATCH ? { id: top.id, score: top.score } : null
  }

  /** AI 上传一页截图；同名页面再传就是新版本，页面回到“待验收” */
  async upload(projectId: string, input: SelfShotInput, by: string): Promise<SelfTestPage> {
    const p = this.projects.get(projectId)
    const t = await this.get(projectId)
    const name = input.name.trim()
    if (!name) throw new StoreError('页面名不能为空')
    if (input.module && !MODULES.includes(input.module)) throw new StoreError(`未知模块：${input.module}`)
    const type = imageType(input.image)
    if (!type) throw new StoreError(`“${name}”的图片不是 PNG 或 JPG`)
    const { width, height, sig } = imageSig(input.image)
    let pg = t.pages.find((x) => x.name === name)
    if (!pg) {
      pg = { id: shortId(), name, module: '', status: 'todo', shots: [], design: null, thread: [], updatedAt: now() }
      t.pages.push(pg)
    }
    const ver = pg.shots.length + 1
    const file = `${pg.id}_v${ver}_${Date.now().toString(36)}.${type}`
    await mkdir(this.shotDir(projectId), { recursive: true })
    await writeFile(join(this.shotDir(projectId), file), input.image)
    pg.shots.push({ file, width, height, sig, by, at: now(), ...(input.device ? { device: input.device.slice(0, 120) } : {}), ...(input.activity ? { activity: input.activity.slice(0, 200) } : {}) })
    if (input.design) {
      const d = findDesign(p, input.design)
      if (!d) throw new StoreError(`找不到设计稿：${input.design}`)
      pg.design = { id: d.id, score: null }
    } else if (!pg.design || pg.design.score !== null || !p.designs?.some((d) => d.id === pg!.design!.id)) {
      // 手动选过的设计稿保留，自动匹配的每一版重新匹配
      pg.design = this.match(p, sig)
    }
    const d = pg.design && p.designs?.find((x) => x.id === pg!.design!.id)
    pg.module = input.module || d?.module || pg.module || moduleFromPage(name)
    pg.status = 'todo'
    delete pg.passedBy
    delete pg.passedAt
    if (input.note?.trim()) pg.thread.push({ id: shortId(), who: 'ai', by, ver, text: input.note.trim().slice(0, 2000), at: now() })
    pg.updatedAt = now()
    t.enabled = true
    await this.save(t)
    return pg
  }

  /** AI 回复（比如看不懂评论先问一句），不传新截图，状态不变 */
  async reply(projectId: string, pageRef: string, text: string, by: string): Promise<SelfTestPage> {
    const t = await this.get(projectId)
    const pg = this.findPage(t, pageRef)
    if (!text.trim()) throw new StoreError('回复不能为空')
    pg.thread.push({ id: shortId(), who: 'ai', by, ver: pg.shots.length, text: text.trim().slice(0, 2000), at: now() })
    pg.updatedAt = now()
    await this.save(t)
    return pg
  }

  /** 验收人的评论：评论点 / 框 + 文字，markedPng 是这一版截图画上所有评论点后的图；发出去页面就是“有问题” */
  async comment(projectId: string, pageId: string, input: { text?: string; marks?: Mark[]; markedPng?: Buffer | null }, by: string): Promise<SelfTestPage> {
    const t = await this.get(projectId)
    const pg = this.findPage(t, pageId)
    const text = (input.text ?? '').trim().slice(0, 2000)
    const marks = cleanMarks(input.marks ?? [])
    if (!text && !marks.length) throw new StoreError('写点评论，或者在截图上点一下')
    if (marks.length && !input.markedPng) throw new StoreError('缺少标注后的图片')
    const msg: SelfTestMsg = { id: shortId(), who: 'me', by, ver: pg.shots.length, text, at: now() }
    if (marks.length) {
      msg.marks = marks
      msg.marked = `${pg.id}_v${msg.ver}_m${Date.now().toString(36)}.png`
      await mkdir(this.shotDir(projectId), { recursive: true })
      await writeFile(join(this.shotDir(projectId), msg.marked), input.markedPng!)
    }
    pg.thread.push(msg)
    pg.status = 'issue'
    delete pg.passedBy
    delete pg.passedAt
    pg.updatedAt = now()
    await this.save(t)
    return pg
  }

  /** 通过 / 撤销通过，只有验收人能做，MCP 不提供 */
  async setPassed(projectId: string, pageId: string, passed: boolean, by: string): Promise<SelfTestPage> {
    const t = await this.get(projectId)
    const pg = this.findPage(t, pageId)
    if (passed) {
      pg.status = 'pass'
      pg.passedBy = by
      pg.passedAt = now()
    } else {
      pg.status = pg.thread.length && pg.thread[pg.thread.length - 1].who === 'me' ? 'issue' : 'todo'
      delete pg.passedBy
      delete pg.passedAt
    }
    pg.updatedAt = now()
    await this.save(t)
    return pg
  }

  async setDesign(projectId: string, pageId: string, designId: string | null): Promise<SelfTestPage> {
    const p = this.projects.get(projectId)
    const t = await this.get(projectId)
    const pg = this.findPage(t, pageId)
    if (designId && !p.designs?.some((d) => d.id === designId)) throw new StoreError('设计稿不存在')
    pg.design = designId ? { id: designId, score: null } : null
    pg.updatedAt = now()
    await this.save(t)
    return pg
  }

  async deletePage(projectId: string, pageId: string): Promise<void> {
    const t = await this.get(projectId)
    const pg = this.findPage(t, pageId)
    for (const f of [...pg.shots.map((s) => s.file), ...pg.thread.map((m) => m.marked)]) if (f) await unlink(join(this.shotDir(projectId), f)).catch(() => {})
    t.pages = t.pages.filter((x) => x !== pg)
    await this.save(t)
  }

  async readFile(projectId: string, file: string): Promise<Buffer> {
    const t = await this.get(projectId)
    if (/[\\/]/.test(file) || !t.pages.some((pg) => pg.shots.some((s) => s.file === file) || pg.thread.some((m) => m.marked === file))) throw new StoreError('截图不存在')
    return readFile(join(this.shotDir(projectId), file))
  }
}
