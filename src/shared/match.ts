import type { Design, Module } from './types'
import { MODULES } from './types'

/**
 * 截图和设计稿的相似度：两张图都缩成 16 格宽的色块图（按宽度对齐，从顶部算起），
 * 比较每格的颜色和明暗变化的走向。只看整体布局和配色，不认文字。
 */
export const SIG_W = 16
/** 最多取宽度 6 倍高的部分：长页面截图只能截到顶部那一屏 */
const MAX_RATIO = 6
/** 达到这个相似度就自动选上 */
export const AUTO_MATCH = 0.75

export interface Rgba {
  width: number
  height: number
  /** RGBA，每像素 4 字节 */
  data: Uint8Array
}

export interface Sig {
  w: number
  h: number
  /** RGB，每格 3 字节 */
  px: Uint8Array
}

export function makeSig(img: Rgba): Sig {
  const { width: W, data } = img
  const H = Math.min(img.height, Math.round(W * MAX_RATIO))
  const w = SIG_W
  const h = Math.max(1, Math.round((w * H) / W))
  const px = new Uint8Array(w * h * 3)
  for (let cy = 0; cy < h; cy++) {
    const y0 = Math.floor((cy * H) / h)
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * H) / h))
    const sy = Math.max(1, Math.floor((y1 - y0) / 8))
    for (let cx = 0; cx < w; cx++) {
      const x0 = Math.floor((cx * W) / w)
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * W) / w))
      const sx = Math.max(1, Math.floor((x1 - x0) / 8))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = y0; y < y1; y += sy) {
        for (let x = x0; x < x1; x += sx) {
          const i = (y * W + x) * 4
          // 透明的地方当成白色
          const a = data[i + 3] / 255
          r += data[i] * a + 255 * (1 - a)
          g += data[i + 1] * a + 255 * (1 - a)
          b += data[i + 2] * a + 255 * (1 - a)
          n++
        }
      }
      const o = (cy * w + cx) * 3
      px[o] = r / n
      px[o + 1] = g / n
      px[o + 2] = b / n
    }
  }
  return { w, h, px }
}

const toB64 = (u: Uint8Array) => (typeof Buffer !== 'undefined' ? Buffer.from(u).toString('base64') : btoa(String.fromCharCode(...u)))
const fromB64 = (s: string) => (typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(s, 'base64')) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))

export const encodeSig = (s: Sig) => `${s.w}x${s.h}:${toB64(s.px)}`

export function decodeSig(s: string): Sig | null {
  const m = /^(\d+)x(\d+):(.+)$/.exec(s)
  if (!m) return null
  const sig = { w: Number(m[1]), h: Number(m[2]), px: fromB64(m[3]) }
  return sig.px.length === sig.w * sig.h * 3 ? sig : null
}

/** 把设计稿的行数拉到和截图一样（设计稿比一屏短时用，比如弹窗画板） */
function rowsOf(s: Sig, rows: number): Uint8Array {
  if (s.h === rows) return s.px
  const out = new Uint8Array(s.w * rows * 3)
  for (let y = 0; y < rows; y++) {
    const sy = Math.min(s.h - 1, Math.floor((y * s.h) / rows))
    out.set(s.px.subarray(sy * s.w * 3, (sy + 1) * s.w * 3), y * s.w * 3)
  }
  return out
}

const lum = (px: Uint8Array, i: number) => 0.299 * px[i * 3] + 0.587 * px[i * 3 + 1] + 0.114 * px[i * 3 + 2]

function pearson(a: number[], b: number[]): number {
  const n = a.length
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb)
    saa += (a[i] - ma) ** 2
    sbb += (b[i] - mb) ** 2
  }
  // 两张都几乎是纯色：一样纯就算像
  if (saa < 1e-6 || sbb < 1e-6) return saa < 1e-6 && sbb < 1e-6 ? 1 : 0
  return sab / Math.sqrt(saa * sbb)
}

/** 0–1，1 表示几乎一样 */
export function similarity(shot: Sig, design: Sig): number {
  if (shot.w !== design.w) return 0
  const w = shot.w
  // 设计稿比截图长：只比顶部一屏；短得不多：只比重叠部分；短很多（弹窗）：拉伸后比
  const rows = design.h >= shot.h ? shot.h : design.h >= shot.h * 0.8 ? design.h : shot.h
  const a = shot.px
  const b = design.h >= shot.h || rows === design.h ? design.px : rowsOf(design, rows)
  const n = w * rows

  let dist = 0
  for (let i = 0; i < n; i++) {
    const dr = a[i * 3] - b[i * 3]
    const dg = a[i * 3 + 1] - b[i * 3 + 1]
    const db = a[i * 3 + 2] - b[i * 3 + 2]
    dist += Math.sqrt(dr * dr + dg * dg + db * db) / 441.7
  }
  const color = 1 - dist / n

  // 明暗变化的走向：相邻格子的亮度差
  const ga: number[] = []
  const gb: number[] = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (x + 1 < w) {
        ga.push(lum(a, i + 1) - lum(a, i))
        gb.push(lum(b, i + 1) - lum(b, i))
      }
      if (y + 1 < rows) {
        ga.push(lum(a, i + w) - lum(a, i))
        gb.push(lum(b, i + w) - lum(b, i))
      }
    }
  }
  const shape = Math.max(0, pearson(ga, gb))
  // 白底的页面颜色差天然就小，颜色分从 0.7 起算
  const colorScore = Math.min(1, Math.max(0, (color - 0.7) / 0.3))
  return Math.round((0.55 * colorScore + 0.45 * shape) * 100) / 100
}

export interface Candidate {
  id: string
  score: number
}

/** 按相似度从高到低，最多 n 个 */
export function rankDesigns(shot: Sig, designs: Design[], n = 3): Candidate[] {
  return designs
    .map((d) => {
      const s = decodeSig(d.sig)
      return { id: d.id, score: s ? similarity(shot, s) : 0 }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
}

/** 从 Figma 页面名推断模块，如“tab1 首页”→ tab1，“广告位”→ 广告 */
export function moduleFromPage(page: string): Module | '' {
  const p = page.toLowerCase()
  const hit = MODULES.find((m) => m !== '其他' && p.includes(m.toLowerCase()))
  if (hit) return hit
  if (/登录|支付|login|pay/.test(p)) return '登录/支付'
  if (/悬浮/.test(p)) return '悬浮窗'
  if (/广告|\bad\b|ads/.test(p)) return '广告'
  return ''
}
