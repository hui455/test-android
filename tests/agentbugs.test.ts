import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { PNG } from 'pngjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/server/config'
import { BugShotServer } from '../src/server/http'
import { ProjectStore } from '../src/server/store'

const TOKEN = 'bs_team'
const DEV = 'bsd_dev'

/** 上面一块色块的手机界面，top 不同就是不同的页面 */
function screen(color: string, top = 160): Buffer {
  const w = 375
  const h = 812
  const png = new PNG({ width: w, height: h })
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const on = y < top || (y > 300 && y < 420 && x > 12 && x < 363)
      png.data[i] = on ? r : 245
      png.data[i + 1] = on ? g : 246
      png.data[i + 2] = on ? b : 248
      png.data[i + 3] = 255
    }
  return PNG.sync.write(png)
}


let dir: string
let port: number
let store: ProjectStore
let server: BugShotServer

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugshot-agent-'))
  port = 22000 + Math.floor(Math.random() * 2000)
  store = new ProjectStore(join(dir, 'server'))
  const config = new ConfigStore(join(dir, 'server'))
  await Promise.all([store.load(), config.load({ port, token: TOKEN, devToken: DEV })])
  server = new BugShotServer(store, config, join(dir, 'server', 'exports'), '0.0.0-test')
  await server.start()
})

afterEach(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

const base = () => `http://127.0.0.1:${port}`

async function mcp(token: string) {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  return client
}
const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text)

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('AI 记 Bug（create_bugs / update_bug）', () => {
  it('curl 先传截图，create_bugs 一次记几条：原话、AI 截图、框、自动匹配设计稿、纯文字', async () => {
    const p = await store.createProject({ name: '9-小计划' })
    await store.upsertDesign(p.id, { page: 'tab1', name: '创建计划页', image: screen('#2f6fed') }, 'AI agent')
    const res = await fetch(`${base()}/api/agent-shot`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: new Uint8Array(screen('#2f6fed')) })
    const { shot_id } = (await res.json()) as { shot_id: string }
    expect(shot_id).toMatch(/^shot_/)

    const ai = await mcp(TOKEN)
    const r = text(
      await ai.callTool({
        name: 'create_bugs',
        arguments: {
          project: p.name,
          reporter: '小王',
          bugs: [
            { module: 'tab1', page: '创建计划页', text: '下拉标识以及位置与UI不符，顶部背景不应有两种颜色', screenshots: [{ shot_id, boxes: [{ x: 20, y: 30, width: 120, height: 40, note: '下拉箭头' }] }] },
            { module: 'tab2', page: '开始步行', text: '前面的步行标识与UI不符', screenshots: [{ image_base64: screen('#30d158', 80).toString('base64') }] },
            { module: '广告', page: 'tab4', text: '无插屏', note: '插屏没出现，截不到' }
          ]
        }
      })
    )
    expect(r).toMatchObject({ created: 3, round: 1 })
    expect(r.results.map((x: { seq: number }) => x.seq)).toEqual([1, 2, 3])
    expect(r.results[0].design).toBe('创建计划页')

    const bugs = store.get(p.id).bugs
    expect(bugs[0]).toMatchObject({ reporter: '小王', aiBy: 'AI agent', text: '下拉标识以及位置与UI不符，顶部背景不应有两种颜色', round: 1 })
    expect(bugs[0].shots[0]).toMatchObject({ ai: true, marks: [{ kind: 'rect', note: '下拉箭头', pts: [20, 30, 140, 70] }] })
    // 框画在单独的一张图上，原图不动
    const marked = await store.readShot(p.id, bugs[0].shots[0].marked!)
    const orig = await store.readShot(p.id, bugs[0].shots[0].file)
    expect(marked.equals(orig)).toBe(false)
    const px = PNG.sync.read(marked)
    const i = (31 * px.width + 80) * 4 // 框的上边
    expect([px.data[i], px.data[i + 1], px.data[i + 2]]).toEqual([255, 59, 48])
    expect(bugs[2]).toMatchObject({ shots: [], aiNote: '插屏没出现，截不到' })

    const got = text(await ai.callTool({ name: 'get_bug', arguments: { project: p.name, bug: 1, include_screenshots: false } }))
    expect(got).toMatchObject({ recordedByAi: 'AI agent', screenshots: [{ byAi: true, marks: [{ no: 1, note: '下拉箭头' }] }] })
  })

  it('update_bug 只能改 AI 自己记的；复测轮不能记也不能改', async () => {
    const p = await store.createProject({ name: '10-计步' })
    const mine = await store.addBug(p.id, { module: 'tab1', page: '首页', text: '测试人员自己记的', mode: '' }, { reporter: '小李' })
    const ai = await mcp(TOKEN)
    text(await ai.callTool({ name: 'create_bugs', arguments: { project: p.name, reporter: '小王', bugs: [{ module: 'tab4', text: '版本信息' }] } }))

    const denied = (await ai.callTool({ name: 'update_bug', arguments: { project: p.name, bug: mine.seq, text: '改掉' } })) as { isError?: boolean; content: { text: string }[] }
    expect(denied.isError).toBe(true)
    expect(denied.content[0].text).toContain('测试人员自己记的')

    const up = text(await ai.callTool({ name: 'update_bug', arguments: { project: p.name, bug: 2, page: '我的', text: '版本信息显示不对', screenshots: [{ image_base64: screen('#ff9500').toString('base64') }] } }))
    expect(up).toMatchObject({ page: '我的', text: '版本信息显示不对', screenshots: [{ byAi: true }] })
    expect(store.get(p.id).bugs[1].updatedBy).toBe('AI agent')

    await store.endRound(p.id, 'fail')
    await store.startRound(p.id)
    const late = text(await ai.callTool({ name: 'create_bugs', arguments: { project: p.name, reporter: '小王', bugs: [{ module: 'tab1', text: 'a' }, { module: 'tab1', text: 'b' }] } }))
    expect(late.created).toBe(0)
    expect(late.results).toHaveLength(1)
    expect(late.results[0].error).toContain('第1轮')
    const noEdit = (await ai.callTool({ name: 'update_bug', arguments: { project: p.name, bug: 2, text: 'x' } })) as { isError?: boolean }
    expect(noEdit.isError).toBe(true)
    expect(store.get(p.id).bugs).toHaveLength(2)
  })

  it('shot_id 不存在时提示重新上传', async () => {
    const p = await store.createProject({ name: '11-测试' })
    const ai = await mcp(TOKEN)
    const r = text(await ai.callTool({ name: 'create_bugs', arguments: { project: p.name, reporter: '小王', bugs: [{ module: 'tab1', text: 'x', screenshots: [{ shot_id: 'shot_nope' }] }] } }))
    expect(r.created).toBe(0)
    expect(r.results[0].error).toContain('过期')
  })
})
