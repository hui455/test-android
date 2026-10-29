import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { feedbackText } from '../src/shared/logic'
import { ProjectStore } from '../src/server/store'
import { exportZip } from '../src/server/exporter'

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

  it('圈画标注：保存、导出用标注图、清除时删掉标注图', async () => {
    const p = await store.createProject({ name: '标注' })
    const b = await store.addBug(p.id, { module: 'tab1', page: '首页', text: '对照原型修改', mode: '' }, { png: PNG })
    const marks = [{ kind: 'rect' as const, color: '#ff3b30', pts: [0, 0, 50, 50], note: '标题偏大' }]
    await expect(store.markShot(p.id, b.id, 0, marks, null)).rejects.toThrow()
    const marked = await store.markShot(p.id, b.id, 0, marks, Buffer.from('MARKED'))
    const s = marked.shots[0]
    expect(s.marks).toEqual(marks)
    expect((await store.readShot(p.id, s.marked!)).toString()).toBe('MARKED')
    const out = join(dir, 'm.zip')
    await exportZip(store, p.id, { round: 1 }, out)
    const zip = readFileSync(out)
    expect(zipRead(zip, '/screenshots/tab1_001_1.png').toString()).toBe('MARKED')
    expect(zipRead(zip, '/bugs.csv').toString()).toContain('①标题偏大')
    const old = s.marked!
    await store.markShot(p.id, b.id, 0, [], null)
    expect(store.get(p.id).bugs[0].shots[0].marked).toBeUndefined()
    expect(await readdir(store.shotDir(p.id))).not.toContain(old)
  })

  it('对标截图单独标记，导出时文件名带“对标”', async () => {
    const p = await store.createProject({ name: '16-违章查询' })
    const vivo = { serial: 'REF456', model: 'vivo X100', brand: 'vivo', androidVersion: '14', sdk: '34', resolution: '1260x2800', foreground: '' }
    const b = await store.addBug(p.id, { module: 'tab1', page: '首页', text: '信息比对标少', mode: '' }, { png: PNG, refPng: Buffer.from('REF1'), refDevice: vivo })
    await store.addShot(p.id, b.id, Buffer.from('OWN2'))
    await store.addShot(p.id, b.id, Buffer.from('REF2'), { ref: true, device: vivo })
    const shots = store.get(p.id).bugs[0].shots
    expect(shots.map((s) => !!s.ref)).toEqual([false, true, false, true])
    expect(shots[1].device?.model).toBe('vivo X100')
    await store.replaceShot(p.id, b.id, 1, Buffer.from('REF1B'))
    expect(store.get(p.id).bugs[0].shots[1]).toMatchObject({ ref: true, device: { model: 'vivo X100' } })
    const out = join(dir, 'ref.zip')
    await exportZip(store, p.id, { round: 1 }, out)
    const zip = readFileSync(out)
    expect(zipRead(zip, '/screenshots/tab1_001_2.png').toString()).toBe('OWN2')
    expect(zipRead(zip, '/screenshots/tab1_001_对标1.png').toString()).toBe('REF1B')
    expect(zipRead(zip, '/screenshots/tab1_001_对标2.png').toString()).toBe('REF2')
  })

  it('导出 zip 包含文本、表格和截图', async () => {
    const p = await store.createProject({ name: '登录/测试' })
    await store.addBug(p.id, { module: '登录/支付', page: '', text: '验证码发送失败', mode: '' }, { png: PNG })
    const out = join(dir, 'out.zip')
    const r = await exportZip(store, p.id, { round: 1 }, out)
    expect(r).toEqual({ bugs: 1, shots: 1 })
    const list = zipEntries(readFileSync(out)).join('\n')
    expect(list).toMatch(/登录_测试_第1轮_\d{4}-\d{2}-\d{2}\/反馈原文\.txt/)
    expect(list).toContain('/bugs.csv')
    expect(list).toContain('/report.html')
    expect(list).toContain('/screenshots/登录_支付_001_1.png')
  })
})

/** 读 zip 中央目录（不依赖外部工具） */
function zipDir(buf: Buffer) {
  const list: { name: string; method: number; size: number; local: number }[] = []
  for (let i = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), off = buf.readUInt32LE(i + 16), n = buf.readUInt16LE(i + 10); n > 0; n--) {
    const len = buf.readUInt16LE(off + 28)
    list.push({ name: buf.toString('utf8', off + 46, off + 46 + len), method: buf.readUInt16LE(off + 10), size: buf.readUInt32LE(off + 20), local: buf.readUInt32LE(off + 42) })
    off += 46 + len + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32)
  }
  return list
}
const zipEntries = (buf: Buffer) => zipDir(buf).map((e) => e.name)

/** 取出名字以 suffix 结尾的文件内容 */
function zipRead(buf: Buffer, suffix: string): Buffer {
  const e = zipDir(buf).find((x) => x.name.endsWith(suffix))
  if (!e) throw new Error(`zip 里没有 ${suffix}`)
  const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28)
  const data = buf.subarray(start, start + e.size)
  return e.method === 8 ? inflateRawSync(data) : data
}
