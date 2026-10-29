import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { feedbackText } from '../src/shared/logic'
import { ProjectStore } from '../src/main/store'
import { exportZip } from '../src/main/exporter'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
let dir: string
let store: ProjectStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugshot-'))
  store = new ProjectStore(dir)
  await store.load()
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('ProjectStore', () => {
  it('保存后能重新读出', async () => {
    const p = await store.createProject({ name: '10-外卖', developer: 'Jack' })
    await store.addBug(p.id, { module: 'tab2', page: '地图', text: '换电柜没显示', mode: '' }, { png: PNG })
    const again = new ProjectStore(dir)
    await again.load()
    const q = again.get(p.id)
    expect(q.bugs).toHaveLength(1)
    expect(q.bugs[0].shots).toHaveLength(1)
    expect(await again.readShot(p.id, q.bugs[0].shots[0].file)).toEqual(PNG)
  })

  it('不允许重名项目', async () => {
    await store.createProject({ name: '7-铃声' })
    await expect(store.createProject({ name: '7-铃声' })).rejects.toThrow('已有同名项目')
  })

  it('删除和替换截图会清理旧文件', async () => {
    const p = await store.createProject({ name: 'x' })
    const b = await store.addBug(p.id, { module: 'tab1', page: '', text: 't', mode: '' }, { png: PNG })
    await store.addShot(p.id, b.id, PNG)
    await store.replaceShot(p.id, b.id, 0, PNG)
    expect(await readdir(store.shotDir(p.id))).toHaveLength(2)
    await store.deleteShot(p.id, b.id, 1)
    expect(await readdir(store.shotDir(p.id))).toHaveLength(1)
    expect(store.get(p.id).bugs[0].shots).toHaveLength(1)
  })

  it('一轮结束后不能再记，开新一轮可以复测', async () => {
    const p = await store.createProject({ name: 'y', developer: 'Jack' })
    const a = await store.addBug(p.id, { module: 'tab1', page: '首页', text: '只有一张图片', mode: '' })
    const b = await store.addBug(p.id, { module: '广告', page: '', text: '缺信息流', mode: '' })
    await store.endRound(p.id, 'fail')
    await expect(store.addBug(p.id, { module: 'tab1', page: '', text: 'z', mode: '' })).rejects.toThrow('已结束')
    await expect(store.setCheck(p.id, a.id, 'fixed')).rejects.toThrow()
    await store.startRound(p.id)
    await store.setCheck(p.id, a.id, 'fixed')
    await store.setCheck(p.id, b.id, 'still')
    await store.addBug(p.id, { module: 'tab2', page: '', text: '新问题', mode: '' })
    const text = feedbackText(store.get(p.id))
    expect(text).toContain('第2轮复测')
    expect(text).toContain('缺信息流（复测仍存在）')
    expect(text).not.toContain('只有一张图片')
  })

  it('导出 zip 包含文本、表格和截图', async () => {
    const p = await store.createProject({ name: '登录/测试' })
    await store.addBug(p.id, { module: '登录/支付', page: '', text: '验证码发送失败', mode: '' }, { png: PNG })
    const out = join(dir, 'out.zip')
    const r = await exportZip(store, p.id, { round: 1 }, out)
    expect(r).toEqual({ bugs: 1, shots: 1 })
    const list = execFileSync('python3', ['-c', 'import sys,zipfile;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', out]).toString()
    expect(list).toMatch(/登录_测试_第1轮_\d{4}-\d{2}-\d{2}\/反馈原文\.txt/)
    expect(list).toContain('/bugs.csv')
    expect(list).toContain('/report.html')
    expect(list).toContain('/screenshots/登录_支付_001_1.png')
  })
})
