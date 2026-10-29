import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/server/config'
import { Beacon, discover } from '../src/server/discovery'
import { BugShotServer } from '../src/server/http'
import { ProjectStore } from '../src/server/store'
import { RemoteError, RemoteStore } from '../src/main/remote'
import type { Project } from '../src/shared/types'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const TOKEN = 'bs_test'

let dir: string
let port: number
let store: ProjectStore
let server: BugShotServer
const clients: RemoteStore[] = []

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function client(name: string, token = TOKEN) {
  const c = new RemoteStore(join(dir, `client-${name}`))
  await c.load()
  c.configure({ url: `http://127.0.0.1:${port}`, token, name })
  clients.push(c)
  return c
}

async function online(name: string) {
  const c = await client(name)
  await until(() => c.state.status === 'online')
  return c
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugshot-srv-'))
  port = 18000 + Math.floor(Math.random() * 2000)
  store = new ProjectStore(join(dir, 'server'))
  const config = new ConfigStore(join(dir, 'server'))
  await Promise.all([store.load(), config.load({ port, token: TOKEN })])
  server = new BugShotServer(store, config, join(dir, 'server', 'exports'), '0.0.0-test')
  await server.start()
})

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop()
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

describe('服务端 + 客户端', () => {
  it('令牌不对时提示，不会一直重试', async () => {
    const c = await client('小王', 'wrong')
    await until(() => c.state.status === 'auth')
  })

  it('记反馈带上记录人和标注，另一个客户端马上能看到', async () => {
    const a = await online('小王')
    const b = await online('小李')
    const p = await a.mutate<Project>(null, 'createProject', { name: '16-违章查询' })
    await until(() => b.list().some((x) => x.id === p.id))
    const mark = { kind: 'rect' as const, color: '#ff3b30', pts: [0, 0, 1, 1], note: '字号偏大' }
    const bug = await a.addBug(p.id, { module: 'tab1', page: '首页', text: '标题字号偏大', mode: '' }, { png: PNG, marks: [mark], markedPng: PNG })
    expect(bug.reporter).toBe('小王')
    expect(store.get(p.id).bugs[0].shots[0].marks).toHaveLength(1)
    await until(() => b.get(p.id).bugs.length === 1)
    expect(await b.readShot(p.id, b.get(p.id).bugs[0].shots[0].marked!)).toEqual(PNG)
    expect(server.clients().map((x) => x.name).sort()).toEqual(['小李', '小王'])
  })

  it('连不上时先存本机，恢复后补传并分配编号', async () => {
    const a = await online('小王')
    const p = await a.mutate<Project>(null, 'createProject', { name: '10-外卖' })
    await server.stop()
    await until(() => a.state.status === 'offline')
    const local = await a.addBug(p.id, { module: 'tab2', page: '', text: '缺数据', mode: '' }, { png: PNG })
    expect(local.pending).toBe(true)
    expect(a.state.outbox).toBe(1)
    expect(a.get(p.id).bugs).toHaveLength(1)
    expect(await a.readShot(p.id, local.shots[0].file)).toEqual(PNG)
    await expect(a.mutate(p.id, 'endRound', p.id, 'fail')).rejects.toThrow('连不上')

    // 重启客户端也不会丢
    a.stop()
    const again = await client('小王')
    expect(again.state.outbox).toBe(1)
    await server.start()
    await again.connect()
    await until(() => again.state.outbox === 0 && store.get(p.id).bugs.length === 1)
    const saved = store.get(p.id).bugs[0]
    expect(saved.seq).toBe(1)
    expect(saved.reporter).toBe('小王')
    expect(saved.shots).toHaveLength(1)
    await until(() => again.get(p.id).bugs.length === 1 && !again.get(p.id).bugs[0].pending)
  })

  it('离线期间那一轮被结束了也能补传，归到记录时的轮次', async () => {
    const a = await online('小王')
    const p = await a.mutate<Project>(null, 'createProject', { name: '6-高速ETC' })
    await server.stop()
    await until(() => a.state.status === 'offline')
    await a.addBug(p.id, { module: '广告', page: '', text: '无插屏', mode: '' }, {})
    await new Promise((r) => setTimeout(r, 5))
    await store.endRound(p.id, 'fail')
    await store.startRound(p.id)
    await server.start()
    await a.connect()
    await until(() => store.get(p.id).bugs.length === 1)
    expect(store.get(p.id).bugs[0].round).toBe(1)
  })

  it('补传失败的反馈留在本机并标出原因', async () => {
    const a = await online('小王')
    const p = await a.mutate<Project>(null, 'createProject', { name: '11-快递' })
    await server.stop()
    await until(() => a.state.status === 'offline')
    await a.addBug(p.id, { module: 'tab1', page: '', text: '会失败', mode: '' }, {})
    await store.deleteProject(p.id)
    await server.start()
    await a.connect()
    await until(() => a.outboxErrors().length === 1)
    expect(a.state.outbox).toBe(1)
  })

  it('基于旧版本保存会提示冲突，确认后可以覆盖', async () => {
    const p = await store.createProject({ name: 'x' })
    const bug = await store.addBug(p.id, { module: 'tab1', page: '', text: '原文', mode: '' })
    const old = bug.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await store.updateBug(p.id, bug.id, { text: '小王改的' }, { by: '小王', base: old })
    await expect(store.updateBug(p.id, bug.id, { text: '小李改的' }, { by: '小李', base: old })).rejects.toThrow('小王')
    await store.updateBug(p.id, bug.id, { text: '小李改的' }, { by: '小李', base: old, force: true })
    expect(store.get(p.id).bugs[0].text).toBe('小李改的')
    expect(store.get(p.id).bugs[0].updatedBy).toBe('小李')
  })

  it('客户端收到的冲突错误带着对方名字', async () => {
    const a = await online('小王')
    const p = await a.mutate<Project>(null, 'createProject', { name: '8-天气' })
    const bug = await a.addBug(p.id, { module: 'tab1', page: '', text: '原文', mode: '' }, {})
    await new Promise((r) => setTimeout(r, 5))
    await store.updateBug(p.id, bug.id, { text: '后台改的' }, { by: '小李' })
    const err = await a.rpc('updateBug', p.id, bug.id, { text: '我的' }, { base: bug.updatedAt }).catch((e) => e)
    expect(err).toBeInstanceOf(RemoteError)
    expect((err as RemoteError).code).toBe('conflict')
    expect((err as RemoteError).by).toBe('小李')
  })

  it('旧版本数据上传时重名会改名', async () => {
    const a = await online('小王')
    await a.mutate(null, 'createProject', { name: '16-违章查询' })
    const old = new ProjectStore(join(dir, 'old'))
    await old.load()
    const op = await old.createProject({ name: '16-违章查询' })
    await old.addBug(op.id, { module: 'tab1', page: '', text: '旧的', mode: '' }, { png: PNG })
    const file = old.get(op.id).bugs[0].shots[0].file
    const np = await a.mutate<Project>(null, 'importProject', old.get(op.id), { [file]: await old.readShot(op.id, file) })
    expect(np.name).toBe('16-违章查询（小王）')
    expect(np.bugs[0].reporter).toBe('小王')
    expect(await store.readShot(np.id, file)).toEqual(PNG)
  })

  it('导出 zip 下载到客户端', async () => {
    const a = await online('小王')
    const p = await a.mutate<Project>(null, 'createProject', { name: '9-导出' })
    await a.addBug(p.id, { module: 'tab1', page: '', text: '问题', mode: '' }, { png: PNG })
    expect(await a.exportZip(p.id, 'all', join(dir, 'out.zip'))).toEqual({ bugs: 1, shots: 1 })
  })
})

describe('局域网自动发现', () => {
  it('能找到服务端', async () => {
    const udp = 19000 + Math.floor(Math.random() * 1000)
    const beacon = new Beacon(() => server.info(), udp)
    await beacon.start()
    try {
      const found = await discover(500, udp)
      expect(found.filter((f) => f.url.endsWith(`:${port}`))).toHaveLength(1)
    } finally {
      beacon.stop()
    }
  })
})
