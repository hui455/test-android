import { describe, expect, it } from 'vitest'
import { appendPhrase, bugShareUrl, carried, feedbackText, feedOrder, nextPending, pageSuggestions, projectStatus, rankedPhrases, remaining, roundReport, searchProject } from '../src/shared/logic'
import type { Bug, Project } from '../src/shared/types'

let seq = 0
const bug = (o: Partial<Bug>): Bug => ({
  id: `b${++seq}`, seq, module: 'tab1', page: '', text: '问题', mode: '', round: 1, checks: {}, shots: [], device: null,
  createdAt: `2026-10-29T10:00:${String(seq).padStart(2, '0')}Z`, updatedAt: '', ...o
})

const project = (): Project => ({
  id: 'p', name: '16-违章查询', developer: 'Jack', type: '马甲', createdAt: '', createdBy: 'user', nextSeq: 10,
  rounds: [
    { no: 1, start: 'a', end: 'b', result: 'fail' },
    { no: 2, start: 'c', end: null, result: 'fail' }
  ],
  bugs: [
    bug({ module: 'tab1', page: '扣分账本页', text: '跳转不对，对照原型修改', checks: { 2: 'fixed' } }),
    bug({ module: 'tab1', page: '爱车估值结果页', text: '缺一行字', checks: { 2: 'still' } }),
    bug({ module: '广告', page: 'tab2', text: '无插屏' }),
    bug({ module: 'tab3', page: '我的错题页', text: '错题数量不对', round: 2 }),
    bug({ module: 'tab1', text: '去掉vip标识', mode: 'audit', round: 2 })
  ]
})

describe('轮次', () => {
  it('复测清单只带出上一轮还没修复的问题', () => {
    const p = project()
    expect(carried(p, 2).map((b) => b.text)).toEqual(['跳转不对，对照原型修改', '缺一行字', '无插屏'])
    const rep = roundReport(p, 2)
    expect(rep.fixed).toHaveLength(1)
    expect(rep.still).toHaveLength(1)
    expect(rep.pending.map((b) => b.text)).toEqual(['无插屏'])
    expect(rep.issues).toHaveLength(3)
  })

  it('已修复的问题不会再进入下一轮', () => {
    const p = project()
    p.rounds.push({ no: 3, start: 'e', end: null, result: 'fail' })
    expect(carried(p, 3).map((b) => b.text)).toEqual(['缺一行字', '无插屏', '错题数量不对', '去掉vip标识'])
    expect(remaining(p)).toBe(4)
  })

  it('列表顺序：复测清单在前、本轮新增在后，各自按模块分组', () => {
    const p = project()
    expect(feedOrder(p, 2).map((b) => b.text)).toEqual(['跳转不对，对照原型修改', '缺一行字', '无插屏', '去掉vip标识', '错题数量不对'])
    expect(feedOrder(p, 1).map((b) => b.text)).toEqual(['跳转不对，对照原型修改', '缺一行字', '无插屏'])
  })

  it('标完复测结果跳到下一条没复测的，后面没有就从头找', () => {
    const p = project()
    p.bugs[0].checks = {}
    p.bugs[1].checks = {}
    const [a, b, c] = p.bugs
    expect(nextPending(p, 2, a.id)?.id).toBe(b.id)
    // 刚标的这条还没刷新进 checks，也不能再跳回它
    b.checks = { 2: 'still' }
    expect(nextPending(p, 2, a.id)?.id).toBe(c.id)
    expect(nextPending(p, 2, c.id)?.id).toBe(a.id)
    a.checks = { 2: 'fixed' }
    expect(nextPending(p, 2, c.id)).toBeNull()
  })

  it('项目状态取最新一轮', () => {
    const p = project()
    expect(projectStatus(p)).toBe('testing')
    p.rounds[1].end = 'x'
    expect(projectStatus(p)).toBe('waiting')
    p.rounds[1].result = 'pass'
    expect(projectStatus(p)).toBe('passed')
  })
})

describe('复制文本', () => {
  it('第一轮按模块分组编号', () => {
    const p = project()
    expect(feedbackText(p, 1)).toBe(
      ['16-违章查询', '开发人员：Jack　类型：马甲　测试结果：测试不通过', '', 'tab1:', '1.扣分账本页-跳转不对，对照原型修改', '2.爱车估值结果页-缺一行字', '广告：', '1.tab2-无插屏'].join('\n')
    )
  })

  it('复测轮只列仍存在和新增', () => {
    const text = feedbackText(project(), 2)
    expect(text).toContain('第2轮复测　测试结果：测试中')
    expect(text).toContain('1.爱车估值结果页-缺一行字（复测仍存在）')
    expect(text).toContain('2.审核状态下-去掉vip标识')
    expect(text).toContain('tab3:\n1.我的错题页-错题数量不对')
    expect(text).not.toContain('扣分账本页')
    expect(text).not.toContain('无插屏')
    expect(text.endsWith('上轮问题已修复 1 条')).toBe(true)
  })
})

describe('搜索与填充', () => {
  it('能搜到项目名和反馈内容', () => {
    const p = project()
    expect(searchProject(p, '插屏')).toEqual({ match: true, hits: 1 })
    expect(searchProject(p, '违章')).toEqual({ match: true, hits: 0 })
    expect(searchProject(p, '不存在的词').match).toBe(false)
  })

  it('短语按点击次数排序，自定义短语排在默认之后', () => {
    const r = rankedPhrases('ad', ['广告关不掉'], { 无插屏: 3, 广告关不掉: 1 })
    expect(r.map((x) => x.text)).toEqual(['无插屏', '广告关不掉', '缺插屏', '缺信息流', '信息流看不见'])
    expect(r[1].custom).toBe(true)
  })

  it('追加短语用中文逗号', () => {
    expect(appendPhrase('', '与UI不符')).toBe('与UI不符')
    expect(appendPhrase('标题颜色，', '与UI不符')).toBe('标题颜色，与UI不符')
  })

  it('页面建议优先当前模块、最近使用', () => {
    const p = project()
    expect(pageSuggestions(p, 'tab3')).toEqual(['我的错题页', 'tab2', '爱车估值结果页', '扣分账本页'])
  })
})

describe('bugShareUrl', () => {
  it('带令牌打开网页并定位到这一条', () => {
    expect(bugShareUrl('http://192.168.1.20:17800/', 'bs_a b', 'p1', 12)).toBe('http://192.168.1.20:17800/?token=bs_a%20b#bug=p1/12')
  })
  it('不带令牌时只有地址和定位', () => {
    expect(bugShareUrl('http://192.168.1.20:17800', '', 'p/1', 3)).toBe('http://192.168.1.20:17800/#bug=p%2F1/3')
  })
})
