import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/server/store'

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
let store: ProjectStore
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugshot-shotdesign-'))
  store = new ProjectStore(dir)
  await store.load()
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function setup() {
  const p = await store.createProject({ name: '9-小计划' })
  const blue = await store.upsertDesign(p.id, { page: 'tab1', name: '创建计划页', image: screen('#2f6fed'), module: 'tab1' })
  const red = await store.upsertDesign(p.id, { page: 'tab2', name: '违章列表', image: screen('#d92d20', 520), module: 'tab2' })
  return { p, blue, red }
}

describe('详情里补截图也自动匹配设计稿', () => {
  it('没截图的反馈追加截图后，自动关联设计稿，页面和模块跟着填', async () => {
    const { p, blue } = await setup()
    const b = await store.addBug(p.id, { module: '广告', page: '', text: 'AI 记的，没截图', mode: '' })
    const after = await store.addShot(p.id, b.id, screen('#2f6fed'))
    expect(after.design?.id).toBe(blue.id)
    expect(after.design?.score).toBeGreaterThan(0.75)
    expect(after).toMatchObject({ page: '创建计划页', module: 'tab1' })
  })

  it('测试人员自己写的页面不覆盖', async () => {
    const { p, blue } = await setup()
    const b = await store.addBug(p.id, { module: 'tab2', page: '我写的页面', text: 't', mode: '' })
    const after = await store.addShot(p.id, b.id, screen('#2f6fed'))
    expect(after.design?.id).toBe(blue.id)
    expect(after).toMatchObject({ page: '我写的页面', module: 'tab2' })
  })

  it('重截第一张会按新图重新匹配；手动选的设计稿不动', async () => {
    const { p, blue, red } = await setup()
    const b = await store.addBug(p.id, { module: 'tab1', page: '', text: 't', mode: '' }, { png: screen('#2f6fed') })
    await store.addShot(p.id, b.id, screen('#2f6fed'))
    expect(store.get(p.id).bugs[0].page).toBe('创建计划页')
    const r = await store.replaceShot(p.id, b.id, 0, screen('#d92d20', 520))
    expect(r.design?.id).toBe(red.id)
    expect(r).toMatchObject({ page: '违章列表', module: 'tab2' })

    await store.updateBug(p.id, b.id, { design: { id: blue.id, score: null } })
    const m = await store.replaceShot(p.id, b.id, 0, screen('#d92d20', 520))
    expect(m.design).toEqual({ id: blue.id, score: null })
  })

  it('已自动匹配时追加第二张不改设计稿；对标截图不参与', async () => {
    const { p, blue } = await setup()
    const b = await store.addBug(p.id, { module: 'tab1', page: '', text: 't', mode: '' })
    await store.addShot(p.id, b.id, screen('#2f6fed'))
    const two = await store.addShot(p.id, b.id, screen('#d92d20', 520))
    expect(two.design?.id).toBe(blue.id)
    const c = await store.addBug(p.id, { module: 'tab1', page: '', text: 'ref', mode: '' })
    const ref = await store.addShot(p.id, c.id, screen('#2f6fed'), { ref: true })
    expect(ref.design).toBeNull()
  })

  it('详情里手动选设计稿：空页面填成画板名，模块跟着设计稿', async () => {
    const { p, red } = await setup()
    const b = await store.addBug(p.id, { module: 'tab1', page: '', text: 't', mode: '' })
    const after = await store.updateBug(p.id, b.id, { design: { id: red.id, score: null } })
    expect(after).toMatchObject({ page: '违章列表', module: 'tab2', design: { id: red.id, score: null } })
  })
})
