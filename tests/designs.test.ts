import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { PNG } from 'pngjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aiPrompt, bugsCsv } from '../src/shared/logic'
import { AUTO_MATCH, decodeSig, encodeSig, makeSig, moduleFromPage, rankDesigns, similarity } from '../src/shared/match'
import { ConfigStore } from '../src/server/config'
import { exportZip } from '../src/server/exporter'
import { BugShotServer } from '../src/server/http'
import { decodeImage } from '../src/server/image'
import { ProjectStore } from '../src/server/store'

type Rect = [number, number, number, number, string]

/** 按 375pt 宽的手机界面画色块，导出成 PNG */
function screen(w: number, h: number, bg: string, rects: Rect[]): Buffer {
  const png = new PNG({ width: w, height: h })
  const k = w / 375
  const fill = (x0: number, y0: number, rw: number, rh: number, c: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
    for (let y = Math.max(0, Math.round(y0 * k)); y < Math.min(h, Math.round((y0 + rh) * k)); y++)
      for (let x = Math.max(0, Math.round(x0 * k)); x < Math.min(w, Math.round((x0 + rw) * k)); x++) {
        const i = (y * w + x) * 4
        png.data[i] = r
        png.data[i + 1] = g
        png.data[i + 2] = b
        png.data[i + 3] = 255
      }
  }
  fill(0, 0, 375, (h / w) * 375, bg)
  for (const r of rects) fill(...r)
  return PNG.sync.write(png)
}

const HOME: Rect[] = [
  [0, 0, 375, 160, '#2f6fed'],
  [16, 60, 110, 22, '#ffffff'],
  [12, 175, 351, 120, '#ffffff'],
  [12, 305, 351, 190, '#ffffff'],
  [12, 505, 351, 110, '#fde7c8'],
  [0, 760, 375, 52, '#ffffff']
]
const homeDesign = screen(750, 1624, '#f3f5f8', HOME)
const listDesign = screen(750, 2400, '#ffffff', [[0, 0, 375, 90, '#ffffff'], [16, 40, 90, 20, '#1b2129'], ...Array.from({ length: 10 }, (_, i): Rect => [12, 110 + i * 92, 351, 80, '#f3f5f8'])])
const darkDesign = screen(750, 1624, '#f3f5f8', [[0, 0, 375, 260, '#1b2129'], [140, 60, 90, 90, '#8c96a3'], [12, 280, 351, 300, '#ffffff'], [0, 760, 375, 52, '#ffffff']])
// 真机截图：分辨率不同，标题大一点，多了状态栏和文字，颜色略有偏差
const homeShot = screen(1080, 2400, '#f2f4f7', [
  [0, 0, 375, 164, '#3070ea'],
  [16, 62, 140, 30, '#ffffff'],
  [300, 8, 60, 10, '#ffffff'],
  [12, 178, 351, 122, '#ffffff'],
  [12, 310, 351, 194, '#ffffff'],
  [12, 514, 351, 112, '#fce5c5'],
  [0, 780, 375, 52, '#ffffff'],
  [30, 200, 200, 14, '#8c96a3']
])

describe('截图和设计稿比对', () => {
  const sig = (b: Buffer) => makeSig(decodeImage(b))

  it('同一个界面相似度高，不同界面低', () => {
    const shot = sig(homeShot)
    const home = similarity(shot, sig(homeDesign))
    expect(home).toBeGreaterThanOrEqual(AUTO_MATCH)
    expect(similarity(shot, sig(listDesign))).toBeLessThan(0.5)
    expect(similarity(shot, sig(darkDesign))).toBeLessThan(0.5)
    expect(similarity(sig(homeDesign), sig(homeDesign))).toBe(1)
  })

  it('特征可以存成字符串再读回来', () => {
    const s = sig(homeDesign)
    expect(decodeSig(encodeSig(s))).toEqual(s)
    expect(decodeSig('坏数据')).toBeNull()
  })

  it('按相似度排序，最像的排第一', () => {
    const mk = (id: string, b: Buffer) => ({ id, sig: encodeSig(sig(b)) }) as never
    const ranked = rankDesigns(sig(homeShot), [mk('list', listDesign), mk('home', homeDesign), mk('dark', darkDesign)])
    expect(ranked).toHaveLength(3)
    expect(ranked[0].id).toBe('home')
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score)
  })

  it('从页面名推断模块', () => {
    expect(moduleFromPage('tab1 首页')).toBe('tab1')
    expect(moduleFromPage('Tab4-我的')).toBe('tab4')
    expect(moduleFromPage('广告位')).toBe('广告')
    expect(moduleFromPage('登录注册')).toBe('登录/支付')
    expect(moduleFromPage('组件')).toBe('')
  })
})

let dir: string
let port: number
let store: ProjectStore
let server: BugShotServer
let config: ConfigStore
const TOKEN = 'bs_test'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugshot-design-'))
  port = 20000 + Math.floor(Math.random() * 2000)
  store = new ProjectStore(join(dir, 'server'))
  config = new ConfigStore(join(dir, 'server'))
  await Promise.all([store.load(), config.load({ port, token: TOKEN })])
  server = new BugShotServer(store, config, join(dir, 'server', 'exports'), '0.0.0-test')
  await server.start()
})

afterEach(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

describe('设计稿存储', () => {
  it('同页面同名重新上传会更新图片，保留 id 和关联', async () => {
    const p = await store.createProject({ name: '16-违章查询' })
    const d = await store.upsertDesign(p.id, { page: 'tab1 首页', name: '首页-审核状态', image: homeDesign }, 'AI agent')
    expect(d.module).toBe('tab1')
    expect(d.width).toBe(750)
    const b = await store.addBug(p.id, { module: 'tab1', page: '首页-审核状态', text: '字号偏大', mode: '', design: { id: d.id, score: 0.92 } })
    expect(b.design).toEqual({ id: d.id, score: 0.92 })
    const d2 = await store.upsertDesign(p.id, { page: 'tab1 首页', name: '首页-审核状态', image: darkDesign }, '小王')
    expect(d2.id).toBe(d.id)
    expect(d2.file).not.toBe(d.file)
    expect(store.get(p.id).designs).toHaveLength(1)
    expect(await store.readDesign(p.id, d2.file)).toEqual(darkDesign)
    await expect(store.readDesign(p.id, d.file)).rejects.toThrow()
  })

  it('不认识的设计稿不能关联，删除设计稿会取消关联', async () => {
    const p = await store.createProject({ name: 'x' })
    const b0 = await store.addBug(p.id, { module: 'tab1', page: '', text: 'a', mode: '', design: { id: 'nope', score: 1 } })
    expect(b0.design).toBeNull()
    const d = await store.upsertDesign(p.id, { page: '', name: '首页', image: homeDesign })
    const b = await store.updateBug(p.id, b0.id, { design: { id: d.id, score: null } })
    expect(b.design).toEqual({ id: d.id, score: null })
    await store.deleteDesign(p.id, d.id)
    expect(store.get(p.id).bugs[0].design).toBeNull()
  })

  it('不是图片时报错', async () => {
    const p = await store.createProject({ name: 'y' })
    await expect(store.upsertDesign(p.id, { page: '', name: 'a', image: Buffer.from('hello') })).rejects.toThrow('PNG 或 JPG')
  })

  it('导出 zip 带上设计稿，表格里有设计稿列', async () => {
    const p = await store.createProject({ name: '9-导出' })
    const d = await store.upsertDesign(p.id, { page: 'tab1 首页', name: '首页', image: homeDesign })
    await store.addBug(p.id, { module: 'tab1', page: '首页', text: '问题', mode: '', design: { id: d.id, score: null } }, { png: homeShot })
    const r = await exportZip(store, p.id, 'all', join(dir, 'out.zip'))
    expect(r).toEqual({ bugs: 1, shots: 1 })
    const { readFile } = await import('node:fs/promises')
    const zip = await readFile(join(dir, 'out.zip'))
    expect(zip.includes(Buffer.from('designs/tab1 首页_首页_'))).toBe(true)
    const pp = store.get(p.id)
    expect(bugsCsv(pp, pp.bugs, 1, new Map())).toContain('tab1 首页 / 首页')
  })

  it('复制给 AI 的提示词', async () => {
    const p = await store.createProject({ name: '16-违章查询' })
    const d = await store.upsertDesign(p.id, { page: 'tab1 首页', name: '首页', image: homeDesign })
    const b = await store.addBug(p.id, { module: 'tab1', page: '首页', text: '标题字号偏大', mode: '', design: { id: d.id, score: 0.9 } }, { png: homeShot })
    expect(aiPrompt(store.get(p.id), b)).toBe(
      '请修复项目“16-违章查询”的第 1 条问题：tab1 · 首页-标题字号偏大。用 BugShot MCP 的 get_bug 读取这条问题，里面有截图和对应的设计稿。对照设计稿修改代码，改完告诉我改了哪些文件。'
    )
    const t = await store.addBug(p.id, { module: '广告', page: '', text: '无插屏', mode: '' })
    expect(aiPrompt(store.get(p.id), t)).toBe('请修复项目“16-违章查询”的第 2 条问题：广告 · 无插屏。用 BugShot MCP 的 get_bug 读取这条问题。按描述修改代码，改完告诉我改了哪些文件。')
  })
})

describe('MCP', () => {
  let img: Server
  let imgPort: number

  beforeEach(async () => {
    // 模拟 Figma get_screenshot 返回的图片链接
    img = createServer((req, res) => {
      if (req.url === '/home.png') {
        res.writeHead(200, { 'content-type': 'image/png' })
        return res.end(homeDesign)
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => img.listen(0, '127.0.0.1', () => r()))
    imgPort = (img.address() as { port: number }).port
  })
  afterEach(() => new Promise<void>((r) => img.close(() => r())))

  async function mcp() {
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }))
    return client
  }
  const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]).text)

  it('AI 不能改反馈、复测结果和轮次', async () => {
    const c = await mcp()
    const names = (await c.listTools()).tools.map((t) => t.name)
    for (const n of ['add_bug', 'update_bug', 'set_retest_result', 'start_round', 'end_round']) expect(names).not.toContain(n)
    for (const n of ['upload_designs', 'list_designs', 'get_design', 'delete_design', 'mark_ai_fixed', 'get_bug']) expect(names).toContain(n)
    await c.close()
  })

  it('上传设计稿：链接和 base64 都行，失败的单独列出', async () => {
    const p = await store.createProject({ name: '16-违章查询' })
    const c = await mcp()
    const r = text(
      await c.callTool({
        name: 'upload_designs',
        arguments: {
          project: '16-违章查询',
          figma_file: '违章查询 V2',
          figma_url: 'https://www.figma.com/design/abc/x',
          designs: [
            { page: 'tab1 首页', name: '首页-审核状态', image_url: `http://127.0.0.1:${imgPort}/home.png` },
            { page: 'tab4 我的', name: '我的', image_base64: darkDesign.toString('base64') },
            { page: 'tab2', name: '过期链接', image_url: `http://127.0.0.1:${imgPort}/gone.png` }
          ]
        }
      })
    )
    expect(r.uploaded).toBe(2)
    expect(r.failed).toBe(1)
    expect(r.results[2].error).toContain('404')
    const pp = store.get(p.id)
    expect(pp.figma).toEqual({ name: '违章查询 V2', url: 'https://www.figma.com/design/abc/x' })
    expect(pp.designs!.map((d) => [d.name, d.module, d.uploadedBy])).toEqual([
      ['首页-审核状态', 'tab1', 'AI agent'],
      ['我的', 'tab4', 'AI agent']
    ])

    const list = text(await c.callTool({ name: 'list_designs', arguments: { project: p.id } }))
    expect(list.designs).toHaveLength(2)
    const one = (await c.callTool({ name: 'get_design', arguments: { project: p.id, design: 'tab4 我的/我的' } })) as { content: { type: string }[] }
    expect(one.content[1].type).toBe('image')
    await c.callTool({ name: 'delete_design', arguments: { project: p.id, design: '我的' } })
    expect(store.get(p.id).designs).toHaveLength(1)
    await c.close()
  })

  it('get_bug 附带设计稿，mark_ai_fixed 只加标记不改复测结果', async () => {
    const p = await store.createProject({ name: '6-高速ETC' })
    const d = await store.upsertDesign(p.id, { page: 'tab1', name: '首页', image: homeDesign })
    const b = await store.addBug(p.id, { module: 'tab1', page: '首页', text: '标题偏大', mode: '', design: { id: d.id, score: 0.9 } }, { png: homeShot })
    const c = await mcp()
    const r = (await c.callTool({ name: 'get_bug', arguments: { project: p.name, bug: 1 } })) as { content: { type: string; text?: string }[] }
    expect(r.content.map((x) => x.type)).toEqual(['text', 'image', 'image'])
    expect(JSON.parse(r.content[0].text!).design).toMatchObject({ name: '首页', similarity: 0.9 })
    const before = store.get(p.id).bugs[0].updatedAt
    const m = text(await c.callTool({ name: 'mark_ai_fixed', arguments: { project: p.name, bug: b.id, summary: '标题改成 17px，改了 Home.kt' } }))
    expect(m.aiFix.summary).toBe('标题改成 17px，改了 Home.kt')
    const saved = store.get(p.id).bugs[0]
    expect(saved.aiFix).toMatchObject({ by: 'AI agent', round: 1 })
    expect(saved.checks).toEqual({})
    expect(saved.updatedAt).toBe(before)
    await c.close()
  })

  it('只读时 AI 不能上传', async () => {
    await store.createProject({ name: 'r' })
    await config.update({ readOnly: true })
    const c = await mcp()
    const r = (await c.callTool({ name: 'upload_designs', arguments: { project: 'r', designs: [{ page: '', name: 'a', image_base64: homeDesign.toString('base64') }] } })) as { isError?: boolean }
    expect(r.isError).toBe(true)
    await c.close()
  })
})

describe('用 curl 上传设计稿', () => {
  it('POST /api/designs', async () => {
    const p = await store.createProject({ name: '16-违章查询' })
    const q = new URLSearchParams({ project: '16-违章查询', page: 'tab1 首页', name: '首页' })
    const res = await fetch(`http://127.0.0.1:${port}/api/designs?${q}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'image/png' }, body: new Uint8Array(homeDesign) })
    expect(res.status).toBe(200)
    const d = store.get(p.id).designs![0]
    expect(d.name).toBe('首页')
    const got = await fetch(`http://127.0.0.1:${port}/designs/${p.id}/${d.file}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(Buffer.from(await got.arrayBuffer())).toEqual(homeDesign)
    const bad = await fetch(`http://127.0.0.1:${port}/api/designs?${q}`, { method: 'POST', body: new Uint8Array(homeDesign) })
    expect(bad.status).toBe(401)
  })
})
