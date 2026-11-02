import type { Design } from './types'

/** 画布上一个画板：x/y 是画板图片左上角，名字画在图片上面 NAME_H 高的地方 */
export interface CanvasBoard {
  d: Design
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasPage {
  page: string
  /** 页面名的位置 */
  x: number
  y: number
  boards: CanvasBoard[]
}

export const CANVAS = {
  /** 没有 Figma 位置时每个画板的宽，有位置时按画板中位宽度缩放到这个宽 */
  BW: 180,
  GAP: 36,
  ROW_GAP: 56,
  PAGE_GAP: 96,
  PAGE_H: 34,
  NAME_H: 22,
  COLS: 6
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

/**
 * 设计稿画布的排版。每个 Figma 页面一块，从上往下排：
 * - 画板带 Figma 位置（box）的，照 Figma 里的相对位置摆，整体缩放到常见画板宽 BW；
 * - 没有位置的（旧数据、手动添加的），一行 COLS 个排成网格，放在这一块的下面。
 */
export function layoutCanvas(groups: [string, Design[]][], c = CANVAS) {
  let top = 0
  let width = 0
  const pages: CanvasPage[] = groups.map(([page, list]) => {
    const boards: CanvasBoard[] = []
    let y0 = top + c.PAGE_H + c.NAME_H
    const placed = list.filter((d) => d.box)
    if (placed.length) {
      const s = c.BW / Math.max(1, median(placed.map((d) => d.box!.w)))
      const minX = Math.min(...placed.map((d) => d.box!.x))
      const minY = Math.min(...placed.map((d) => d.box!.y))
      let bottom = y0
      for (const d of placed) {
        const b = d.box!
        const box = { d, x: (b.x - minX) * s, y: y0 + (b.y - minY) * s, w: b.w * s, h: b.h * s }
        boards.push(box)
        bottom = Math.max(bottom, box.y + box.h)
        width = Math.max(width, box.x + box.w)
      }
      y0 = bottom + c.ROW_GAP + c.NAME_H
    }
    const rest = list.filter((d) => !d.box)
    for (let i = 0; i < rest.length; i += c.COLS) {
      const row = rest.slice(i, i + c.COLS).map((d, j) => ({ d, x: j * (c.BW + c.GAP), y: y0, w: c.BW, h: Math.min(c.BW * 2.6, (c.BW * d.height) / Math.max(1, d.width)) }))
      boards.push(...row)
      width = Math.max(width, row.length * (c.BW + c.GAP) - c.GAP)
      y0 += Math.max(...row.map((b) => b.h)) + c.ROW_GAP + c.NAME_H
    }
    const bottom = Math.max(top + c.PAGE_H, ...boards.map((b) => b.y + b.h))
    const p = { page, x: 0, y: top, boards }
    top = bottom + c.PAGE_GAP
    return p
  })
  return { pages, width, height: Math.max(0, top - c.PAGE_GAP) }
}
