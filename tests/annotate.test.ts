import { describe, expect, it } from 'vitest'
import { annotatedSvg, cleanMarks, dragHandle, hitMark, markAnchor, markHandles, moveMark, normalizeMark, marksSvg, marksText, markTooSmall, shotFile, wrapNote } from '../src/shared/annotate'
import type { Mark } from '../src/shared/types'

const rect: Mark = { kind: 'rect', color: '#ff3b30', pts: [300, 400, 100, 200], note: '标题字号偏大' }
const arrow: Mark = { kind: 'arrow', color: '#0a84ff', pts: [10, 10, 500, 600], note: '' }

describe('圈画标注', () => {
  it('编号放在框的左上角、箭头的尾部', () => {
    expect(markAnchor(rect)).toEqual([100, 200])
    expect(markAnchor(arrow)).toEqual([10, 10])
  })

  it('SVG 里有图形、编号和转义后的评论', () => {
    const svg = marksSvg([rect, arrow, { ...rect, note: '<b>&' }], 1080, 2340)
    expect(svg).toContain('<rect x="100" y="200" width="200" height="200"')
    expect(svg).toContain('<polygon')
    expect(svg).toContain('>3</text>')
    expect(svg).toContain('标题字号偏大')
    expect(svg).toContain('&lt;b&gt;&amp;')
    expect(annotatedSvg('data:image/png;base64,AA', [rect], 1080, 2340)).toMatch(/^<svg [^>]*width="1080" height="2340"/)
  })

  it('评论按宽度折行，最多 3 行', () => {
    expect(wrapNote('短评论', 20, 200)).toEqual(['短评论'])
    const lines = wrapNote('这是一条很长很长的评论'.repeat(5), 20, 100)
    expect(lines).toHaveLength(3)
    expect(lines[2].endsWith('…')).toBe(true)
  })

  it('图注文本只列有评论的编号', () => {
    expect(marksText([rect, arrow, { ...arrow, note: '按钮颜色不对' }])).toBe('①标题字号偏大 ③按钮颜色不对')
    expect(marksText(undefined)).toBe('')
  })

  it('有标注时展示标注图', () => {
    expect(shotFile({ file: 'a.png', takenAt: '' })).toBe('a.png')
    expect(shotFile({ file: 'a.png', takenAt: '', marked: 'a_m.png' })).toBe('a_m.png')
  })

  it('太小的图形当误触，外部数据会被校验', () => {
    expect(markTooSmall({ ...rect, pts: [10, 10, 12, 13] }, 6)).toBe(true)
    expect(markTooSmall(rect, 6)).toBe(false)
    expect(cleanMarks([{ kind: 'pen', color: 'red', pts: [1, 2, 3, 4], note: 1 }])).toEqual([{ kind: 'pen', color: '#ff3b30', pts: [1, 2, 3, 4], note: '1' }])
    expect(() => cleanMarks([{ kind: 'star', pts: [1, 2, 3, 4] }])).toThrow()
    expect(() => cleanMarks([{ kind: 'rect', pts: [1, 2, 3] }])).toThrow()
  })
})

describe('选中、拖动和调大小', () => {
  const box: Mark = { kind: 'rect', color: '#ff3b30', pts: [100, 100, 300, 200], note: '' }
  const line: Mark = { kind: 'arrow', color: '#ff3b30', pts: [0, 0, 100, 100], note: '' }

  it('框只认边线，选中后内部也能拖', () => {
    expect(hitMark([box], 100, 150, 6)).toBe(0)
    expect(hitMark([box], 200, 150, 6)).toBe(-1)
    expect(hitMark([box], 200, 150, 6, 0)).toBe(0)
    expect(hitMark([box, line], 50, 52, 6)).toBe(1)
    expect(hitMark([box, line], 400, 400, 6)).toBe(-1)
  })

  it('拖角调大小、拖箭头端点、整体移动', () => {
    expect(markHandles(box)).toEqual([[100, 100], [300, 100], [100, 200], [300, 200]])
    expect(dragHandle(box, 3, 400, 260).pts).toEqual([100, 100, 400, 260])
    expect(dragHandle(box, 0, 50, 60).pts).toEqual([50, 60, 300, 200])
    expect(dragHandle(line, 1, 10, 20).pts).toEqual([0, 0, 10, 20])
    expect(moveMark(box, 5, -5).pts).toEqual([105, 95, 305, 195])
    expect(normalizeMark({ ...box, pts: [300, 200, 100, 100] }).pts).toEqual([100, 100, 300, 200])
    expect(markHandles({ ...line, kind: 'pen' })).toEqual([])
  })
})
