import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { PNG } from 'pngjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { versionMarks } from '../src/shared/logic'
import type { Mark } from '../src/shared/types'
import { ConfigStore } from '../src/server/config'
import { BugShotServer } from '../src/server/http'
import { ProjectStore } from '../src/server/store'
import { RemoteStore } from '../src/main/remote'
import { DEV_HEADER } from '../src/server/wire'

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

const pin = (x: number, y: number, note: string): Mark => ({ kind: 'pin', color: '#ff3b30', pts: [x, y, x, y], note })

let dir: string
let port: number
let store: ProjectStore
let server: BugShotServer
const clients: RemoteStore[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugshot-self-'))
  port = 20000 + Math.floor(Math.random() * 2000)
  store = new ProjectStore(join(dir, 'server'))
  const config = new ConfigStore(join(dir, 'server'))
  await Promise.all([store.load(), config.load({ port, token: TOKEN, devToken: DEV })])
  server = new BugShotServer(store, config, join(dir, 'server', 'exports'), '0.0.0-test')
  await server.start()
})

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop()
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

describe('开发自测的数据', () => {
  it('同名页面再传是新版本，回到待验收；评论后是有问题，通过只能人点', async () => {
    const p = await store.createProject({ name: '16-违章查询' })
    const st = server.selftest
    expect((await st.get(p.id)).enabled).toBe(false)

    const v1 = await st.upload(p.id, { name: '违章列表', image: screen('#2f6fed') }, 'AI agent')
    expect(v1.shots).toHaveLength(1)
    expect(v1.status).toBe('todo')
    expect((await st.get(p.id)).enabled).toBe(true)

    // 评论点要带上画好编号的图
    await expect(st.comment(p.id, v1.id, { marks: [pin(300, 200, '筛选按钮应该在左边')] }, '主人')).rejects.toThrow('标注后的图片')
    await expect(st.comment(p.id, v1.id, {}, '主人')).rejects.toThrow()
    const c1 = await st.comment(p.id, v1.id, { text: '底部少了广告', marks: [pin(300, 200, '筛选按钮应该在左边')], markedPng: screen('#ff0000') }, '主人')
    expect(c1.status).toBe('issue')
    const c2 = await st.comment(p.id, v1.id, { marks: [pin(10, 10, '标题太大')], markedPng: screen('#ff0000') }, '主人')
    // 同一版上的评论点连着编号
    expect(versionMarks(c2, 1).map((m) => m.note)).toEqual(['筛选按钮应该在左边', '标题太大'])

    const r = await st.reply(p.id, '违章列表', '广告位要用哪个尺寸？', 'AI agent')
    expect(r.status).toBe('issue')

    const v2 = await st.upload(p.id, { name: '违章列表', image: screen('#2f6fed'), note: '筛选按钮移到左边' }, 'AI agent')
    expect(v2.id).toBe(v1.id)
    expect(v2.shots).toHaveLength(2)
    expect(v2.status).toBe('todo')
    expect(v2.thread.at(-1)).toMatchObject({ who: 'ai', ver: 2, text: '筛选按钮移到左边' })

    const ok = await st.setPassed(p.id, v2.id, true, '主人')
    expect(ok).toMatchObject({ status: 'pass', passedBy: '主人' })
    // 通过后 AI 又传一版，要重新验收
    expect((await st.upload(p.id, { name: '违章列表', image: screen('#2f6fed') }, 'AI agent')).status).toBe('todo')

    // 自测数据单独存，不出现在正式测试的项目里
    expect(store.get(p.id).bugs).toHaveLength(0)
    expect(JSON.stringify(store.get(p.id))).not.toContain('违章列表')

    await st.deletePage(p.id, v2.id)
    expect((await st.get(p.id)).pages).toHaveLength(0)
  })

  it('自动匹配设计稿，手动选过的新版本不再换', async () => {
    const p = await store.createProject({ name: '1-测试' })
    const blue = await store.upsertDesign(p.id, { page: 'tab1 首页', name: '首页-审核状态', image: screen('#2f6fed') })
    const red = await store.upsertDesign(p.id, { page: 'tab2', name: '违章列表', image: screen('#d92d20', 520) })
    const pg = await server.selftest.upload(p.id, { name: '首页-审核状态', image: screen('#2f6fed') }, 'AI agent')
    expect(pg.design?.id).toBe(blue.id)
    expect(pg.module).toBe('tab1')
    await server.selftest.setDesign(p.id, pg.id, red.id)
    const v2 = await server.selftest.upload(p.id, { name: '首页-审核状态', image: screen('#2f6fed') }, 'AI agent')
    expect(v2.design).toEqual({ id: red.id, score: null })
  })
})

describe('只有自测令牌能碰开发自测', () => {
  it('团队令牌看不到自测数据，也收不到自测的推送', async () => {
    const p = await store.createProject({ name: '2-测试' })
    await server.selftest.upload(p.id, { name: '首页', image: screen('#2f6fed') }, 'AI agent')
    const team = { authorization: `Bearer ${TOKEN}` }
    const dev = { authorization: `Bearer ${TOKEN}`, [DEV_HEADER]: DEV }

    expect((await fetch(`${base()}/api/selftest`, { headers: team })).status).toBe(403)
    expect((await fetch(`${base()}/api/selftest/${p.id}`, { headers: team })).status).toBe(403)
    const rpc = await fetch(`${base()}/rpc`, { method: 'POST', headers: { ...team, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'selfEnable', args: [p.id, false] }) })
    expect(rpc.status).toBe(403)
    const list = (await (await fetch(`${base()}/api/selftest`, { headers: dev })).json()) as { pages: { shots: { file: string }[] }[] }[]
    expect(list).toHaveLength(1)
    const file = list[0].pages[0].shots[0].file
    expect((await fetch(`${base()}/selftest/${p.id}/${file}`, { headers: team })).status).toBe(403)
    expect((await fetch(`${base()}/selftest/${p.id}/${file}`, { headers: dev })).status).toBe(200)
    // 自测令牌本身也能当团队令牌用
    expect((await fetch(`${base()}/api/projects`, { headers: { authorization: `Bearer ${DEV}` } })).status).toBe(200)
  })

  it('客户端填了自测令牌才拿到自测数据，测试人员的客户端什么都没有', async () => {
    const p = await store.createProject({ name: '3-测试' })
    await server.selftest.upload(p.id, { name: '首页', image: screen('#2f6fed') }, 'AI agent')
    const make = async (name: string, devToken?: string) => {
      const c = new RemoteStore(join(dir, `client-${name}`))
      await c.load()
      c.configure({ url: base(), token: TOKEN, name, devToken })
      clients.push(c)
      await until(() => c.state.status === 'online')
      return c
    }
    const tester = await make('小王')
    const boss = await make('主人', DEV)
    expect(tester.state.dev).toBe(false)
    expect(tester.selfList()).toEqual({})
    expect(boss.state.dev).toBe(true)
    expect(boss.selfList()[p.id].pages).toHaveLength(1)
    await expect(tester.selfMutate(p.id, 'selfEnable', false)).rejects.toThrow('自测令牌')
    await expect(tester.probe({ url: base(), token: TOKEN, name: 'x', devToken: 'bsd_wrong' })).rejects.toThrow('自测令牌不对')

    // AI 再传一版，填了自测令牌的客户端马上看到
    await server.selftest.upload(p.id, { name: '首页', image: screen('#2f6fed') }, 'AI agent')
    await until(() => boss.selfList()[p.id]?.pages[0].shots.length === 2)
    const page = boss.selfList()[p.id].pages[0]
    await boss.selfMutate(p.id, 'selfPass', page.id, true)
    expect(boss.selfList()[p.id].pages[0]).toMatchObject({ status: 'pass', passedBy: '主人' })
    expect((await boss.readSelfShot(p.id, page.shots[0].file)).length).toBeGreaterThan(100)
  })

  it('MCP：团队令牌没有自测工具，自测令牌能上传、读评论、回复，不能点通过', async () => {
    const p = await store.createProject({ name: '4-测试' })
    const team = await mcp(TOKEN)
    const names = (await team.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain('selftest_upload')

    const ai = await mcp(DEV)
    const tools = (await ai.listTools()).tools.map((t) => t.name)
    expect(tools).toEqual(expect.arrayContaining(['selftest_upload', 'selftest_list', 'selftest_get', 'selftest_reply']))
    expect(tools.some((n) => /pass|approve/.test(n))).toBe(false)

    const up = text(await ai.callTool({ name: 'selftest_upload', arguments: { project: p.name, pages: [{ name: '首页', image_base64: screen('#2f6fed').toString('base64') }] } }))
    expect(up.uploaded).toBe(1)
    const pg = (await server.selftest.get(p.id)).pages[0]
    await server.selftest.comment(p.id, pg.id, { text: '标题偏大', marks: [pin(20, 20, '这里')], markedPng: screen('#ff0000') }, '主人')

    const list = text(await ai.callTool({ name: 'selftest_list', arguments: { project: p.name, status: 'issue' } }))
    expect(list.pages).toHaveLength(1)
    expect(list.pages[0].thread[0]).toMatchObject({ text: '标题偏大', marks: [{ no: 1, kind: '评论点', note: '这里' }] })
    const got = (await ai.callTool({ name: 'selftest_get', arguments: { project: p.name, page: '首页' } })) as { content: { type: string }[] }
    expect(got.content.filter((c) => c.type === 'image')).toHaveLength(1)

    text(await ai.callTool({ name: 'selftest_reply', arguments: { project: p.name, page: '首页', text: '标题改成多大？' } }))
    expect((await server.selftest.get(p.id)).pages[0].status).toBe('issue')
  })

  it('curl 传截图要自测令牌', async () => {
    const p = await store.createProject({ name: '5-测试' })
    const url = `${base()}/api/selftest?project=${encodeURIComponent(p.name)}&name=${encodeURIComponent('我的')}&note=${encodeURIComponent('第一次上传')}`
    const denied = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: new Uint8Array(screen('#2f6fed')) })
    expect(denied.status).toBe(403)
    const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${DEV}` }, body: new Uint8Array(screen('#2f6fed')) })
    expect(await res.json()).toMatchObject({ ok: true, page: '我的', version: 1, status: 'todo' })
    expect((await server.selftest.get(p.id)).pages[0].thread[0].text).toBe('第一次上传')
  })
})
