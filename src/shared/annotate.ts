import type { Mark, Screenshot } from './types'

/** 红、黄、蓝、绿，截图上都看得清 */
export const MARK_COLORS = ['#ff3b30', '#ffcc00', '#0a84ff', '#30d158']

const NUMS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
export const markNo = (i: number) => NUMS[i] ?? `(${i + 1})`

/** 展示和导出用的图片：有标注时用画好标注的那张 */
export const shotFile = (s: Screenshot) => s.marked ?? s.file

/** 这张图上所有带评论的标注，写成“①… ②…” */
export const marksText = (marks: Mark[] | undefined): string =>
  (marks ?? [])
    .map((m, i) => (m.note.trim() ? `${markNo(i)}${m.note.trim()}` : ''))
    .filter(Boolean)
    .join(' ')

/** 线宽、编号圆点、评论字号都跟着图片尺寸走，手机原图和缩略图看起来比例一致 */
export function markStyle(w: number, h: number) {
  const base = Math.min(w, h)
  const sw = Math.max(3, Math.round(base / 130))
  return { sw, r: sw * 2.8, fs: Math.max(14, Math.round(base / 27)) }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const n = (v: number) => Math.round(v * 10) / 10

/** 编号圆点的位置：框和圈在左上角，箭头在尾部，画笔在起笔处 */
export function markAnchor(m: Mark): [number, number] {
  const [x1, y1, x2, y2] = m.pts
  if (m.kind === 'rect' || m.kind === 'ellipse') return [Math.min(x1, x2), Math.min(y1, y2)]
  return [x1, y1]
}

/** 太小的框或太短的线当作误触 */
export function markTooSmall(m: Mark, sw: number): boolean {
  const xs = m.pts.filter((_, i) => i % 2 === 0)
  const ys = m.pts.filter((_, i) => i % 2 === 1)
  return Math.max(...xs) - Math.min(...xs) < sw * 3 && Math.max(...ys) - Math.min(...ys) < sw * 3
}

/** 框和圈的两个点整理成左上、右下，方便按角调整大小 */
export function normalizeMark(m: Mark): Mark {
  if (m.kind !== 'rect' && m.kind !== 'ellipse') return m
  const [x1, y1, x2, y2] = m.pts
  return { ...m, pts: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)] }
}

/** 可拖动的控制点：框和圈是四个角，箭头是两端，画笔不能调大小 */
export function markHandles(m: Mark): [number, number][] {
  const [x1, y1, x2, y2] = m.pts
  if (m.kind === 'rect' || m.kind === 'ellipse') return [[x1, y1], [x2, y1], [x1, y2], [x2, y2]]
  if (m.kind === 'arrow') return [[x1, y1], [x2, y2]]
  return []
}

/** 拖动第 h 个控制点到 (x, y) */
export function dragHandle(m: Mark, h: number, x: number, y: number): Mark {
  const pts = [...m.pts]
  if (m.kind === 'arrow') {
    pts[h * 2] = x
    pts[h * 2 + 1] = y
  } else {
    pts[h % 2 === 0 ? 0 : 2] = x
    pts[h < 2 ? 1 : 3] = y
  }
  return { ...m, pts }
}

export const moveMark = (m: Mark, dx: number, dy: number): Mark => ({ ...m, pts: m.pts.map((v, i) => v + (i % 2 === 0 ? dx : dy)) })

const segDist = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
  const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2
  const t = l2 ? Math.max(0, Math.min(1, ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2)) : 0
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)))
}

/**
 * 点中的是哪一处标注（后画的在上面优先），没点中返回 -1。
 * 框和圈只认边线附近，这样在大框里面还能画新的；已选中的那一处点内部也算，方便拖动。
 */
export function hitMark(marks: Mark[], x: number, y: number, tol: number, selected = -1): number {
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i]
    if (m.kind === 'rect' || m.kind === 'ellipse') {
      const [x1, y1, x2, y2] = normalizeMark(m).pts
      const inside = x >= x1 - tol && x <= x2 + tol && y >= y1 - tol && y <= y2 + tol
      if (!inside) continue
      if (i === selected) return i
      if (m.kind === 'rect') {
        if (Math.min(Math.abs(x - x1), Math.abs(x - x2), Math.abs(y - y1), Math.abs(y - y2)) <= tol) return i
      } else {
        const rx = (x2 - x1) / 2 || 1
        const ry = (y2 - y1) / 2 || 1
        const d = Math.hypot((x - x1 - rx) / rx, (y - y1 - ry) / ry)
        if (Math.abs(d - 1) * Math.min(rx, ry) <= tol) return i
      }
    } else {
      for (let k = 0; k + 3 < m.pts.length; k += 2) if (segDist(x, y, m.pts[k], m.pts[k + 1], m.pts[k + 2], m.pts[k + 3]) <= tol) return i
    }
  }
  return -1
}

function shape(m: Mark, sw: number): string {
  const [x1, y1, x2, y2] = m.pts
  const stroke = `fill="none" stroke="${m.color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"`
  if (m.kind === 'rect') return `<rect x="${n(Math.min(x1, x2))}" y="${n(Math.min(y1, y2))}" width="${n(Math.abs(x2 - x1))}" height="${n(Math.abs(y2 - y1))}" rx="${sw}" ${stroke}/>`
  if (m.kind === 'ellipse') return `<ellipse cx="${n((x1 + x2) / 2)}" cy="${n((y1 + y2) / 2)}" rx="${n(Math.abs(x2 - x1) / 2)}" ry="${n(Math.abs(y2 - y1) / 2)}" ${stroke}/>`
  if (m.kind === 'pen') {
    const pts = []
    for (let i = 0; i + 1 < m.pts.length; i += 2) pts.push(`${n(m.pts[i])},${n(m.pts[i + 1])}`)
    return `<polyline points="${pts.join(' ')}" ${stroke}/>`
  }
  // 箭头：线画到箭头底部，箭头用三角形
  const len = Math.hypot(x2 - x1, y2 - y1) || 1
  const ux = (x2 - x1) / len
  const uy = (y2 - y1) / len
  const hl = Math.min(sw * 4.5, len * 0.6)
  const hw = sw * 2.6
  const bx = x2 - ux * hl
  const by = y2 - uy * hl
  return (
    `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(bx)}" y2="${n(by)}" ${stroke}/>` +
    `<polygon points="${n(x2)},${n(y2)} ${n(bx - uy * hw)},${n(by + ux * hw)} ${n(bx + uy * hw)},${n(by - ux * hw)}" fill="${m.color}" stroke="${m.color}" stroke-width="${n(sw / 2)}" stroke-linejoin="round"/>`
  )
}

/** 中文按一个字宽，英文数字按半个多字宽估算 */
const textWidth = (s: string, fs: number) => [...s].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? fs : fs * 0.58), 0)

/** 按宽度把评论折成几行，最多 3 行，超出用省略号 */
export function wrapNote(text: string, fs: number, maxW: number): string[] {
  const lines: string[] = []
  let cur = ''
  for (const c of text.trim().replace(/\s+/g, ' ')) {
    if (textWidth(cur + c, fs) > maxW && cur) {
      lines.push(cur)
      cur = c.trim()
    } else cur += c
  }
  if (cur) lines.push(cur)
  if (lines.length > 3) return [...lines.slice(0, 2), lines[2].slice(0, -1) + '…']
  return lines
}

const textOn = (hex: string) => (['#ffcc00', '#30d158'].includes(hex) ? '#111' : '#fff')

/**
 * 所有标注的 SVG 内容（不含外层 svg），App 里实时显示和导出成图片用的是同一份，
 * 所以看到的就是导出的。selected 为选中的那一处，会加一圈白边。
 */
export function marksSvg(marks: Mark[], w: number, h: number, selected = -1): string {
  const { sw, r, fs } = markStyle(w, h)
  const out: string[] = []
  marks.forEach((m, i) => {
    // 先画一层半透明黑描边，浅色背景上也能看清
    out.push(`<g opacity=".35" transform="translate(${n(sw / 3)},${n(sw / 3)})">${shape({ ...m, color: '#000' }, sw)}</g>`)
    out.push(shape(m, sw))
    if (i === selected) out.push(`<g opacity=".9">${shape({ ...m, color: '#fff' }, Math.max(1, sw / 3))}</g>`)
  })
  marks.forEach((m, i) => {
    const [ax, ay] = markAnchor(m)
    const cx = Math.min(Math.max(ax, r + 2), w - r - 2)
    const cy = Math.min(Math.max(ay, r + 2), h - r - 2)
    out.push(
      `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${m.color}" stroke="#fff" stroke-width="${n(sw / 2)}"/>` +
        `<text x="${n(cx)}" y="${n(cy)}" fill="${textOn(m.color)}" font-size="${n(r * 1.25)}" font-weight="700" text-anchor="middle" dominant-baseline="central" font-family="Arial, sans-serif">${i + 1}</text>`
    )
    if (!m.note.trim()) return
    // 评论气泡放在图形下方（下面放不下就放上方），不挡住圈出来的地方
    const lines = wrapNote(`${markNo(i)} ${m.note}`, fs, w * 0.6)
    const pad = fs * 0.45
    const bw = Math.max(...lines.map((l) => textWidth(l, fs))) + pad * 2
    const bh = lines.length * fs * 1.3 + pad * 1.4
    const xs = m.pts.filter((_, k) => k % 2 === 0)
    const ys = m.pts.filter((_, k) => k % 2 === 1)
    const gap = sw * 2
    const bx = Math.min(Math.max(Math.min(...xs), 4), w - bw - 4)
    let by = Math.max(...ys) + gap
    if (by + bh > h - 4) by = Math.min(...ys) - gap - bh
    by = Math.min(Math.max(by, 4), h - bh - 4)
    out.push(
      `<rect x="${n(bx)}" y="${n(by)}" width="${n(bw)}" height="${n(bh)}" rx="${n(fs * 0.35)}" fill="#fff" fill-opacity=".94" stroke="${m.color}" stroke-width="${n(sw / 2)}"/>` +
        lines
          .map(
            (l, k) =>
              `<text x="${n(bx + pad)}" y="${n(by + pad * 0.7 + fs * 1.3 * k + fs * 0.65)}" fill="#111" font-size="${fs}" dominant-baseline="central" font-family="PingFang SC, Microsoft YaHei, sans-serif">${esc(l)}</text>`
          )
          .join('')
    )
  })
  return out.join('')
}

/** 原图 + 标注的完整 SVG，用来画到 canvas 上导出 PNG */
export const annotatedSvg = (imageHref: string, marks: Mark[], w: number, h: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
  `<image href="${esc(imageHref)}" xlink:href="${esc(imageHref)}" x="0" y="0" width="${w}" height="${h}"/>` +
  marksSvg(marks, w, h) +
  '</svg>'

/** 校验外部（如 MCP）传进来的标注 */
export function cleanMarks(input: unknown): Mark[] {
  if (!Array.isArray(input)) throw new Error('标注格式不对')
  return input.map((m) => {
    const x = m as Partial<Mark>
    if (!['rect', 'ellipse', 'arrow', 'pen'].includes(String(x.kind))) throw new Error(`未知标注类型：${x.kind}`)
    const pts = Array.isArray(x.pts) ? x.pts.map(Number) : []
    if (pts.length < 4 || pts.length % 2 || pts.some((v) => !Number.isFinite(v))) throw new Error('标注坐标不对')
    return { kind: x.kind!, color: /^#[0-9a-f]{6}$/i.test(String(x.color)) ? String(x.color) : MARK_COLORS[0], pts, note: String(x.note ?? '').slice(0, 200) }
  })
}
