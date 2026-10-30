import { marksText, shotFile } from '@shared/annotate'
import { AI_COLOR, aiLabel, bugDesign, bugLine, deviceName } from '@shared/logic'
import type { Bug, Project } from '@shared/types'
import { designUrl, shotUrl } from '../api'
import { loadImage, toDataUrl } from './Annotator'
import { fmtTime } from './util'

const FONT = 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif'
const PAD = 28
const GAP = 14
const IMG_H = 520
const SCALE = 2

interface Pic {
  img: HTMLImageElement
  label: string
  w: number
}

/** 按字符折行，中文没有空格，不能按词断 */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const ch of para) {
      if (line && ctx.measureText(line + ch).width > max) {
        lines.push(line)
        line = ch
      } else line += ch
    }
    lines.push(line)
  }
  return lines
}

/**
 * “发给开发”：把一条反馈画成一张 PNG（data URL），粘到飞书 / 微信里开发不用装 BugShot 也能看。
 * 截图用画好圈画的那张；打开对标时带上对标截图；withDesign 时带上关联的设计稿。
 */
export async function renderShareCard(p: Project, b: Bug, opts: { link: string; withDesign: boolean }): Promise<string> {
  const load = async (src: string) => loadImage(await toDataUrl(src))
  const shots = b.shots.filter((s) => p.refApp || !s.ref)
  const pics: Pic[] = []
  for (const [i, s] of shots.entries()) {
    const img = await load(shotUrl(p.id, shotFile(s)))
    const own = shots.filter((x) => !x.ref).length
    pics.push({ img, label: s.ref ? '对标应用' : own > 1 ? `截图 ${i + 1}` : '截图', w: 0 })
  }
  const design = bugDesign(p, b)
  if (opts.withDesign && design) {
    try {
      pics.push({ img: await load(designUrl(p.id, design.file)), label: '设计稿', w: 0 })
    } catch {
      // 设计稿取不到就不放
    }
  }
  for (const x of pics) x.w = Math.min(Math.round((x.img.naturalWidth / x.img.naturalHeight) * IMG_H), 420)

  const picsW = pics.reduce((a, x) => a + x.w, 0) + GAP * Math.max(0, pics.length - 1)
  const W = Math.max(600, picsW + PAD * 2)
  const textW = W - PAD * 2

  const measure = document.createElement('canvas').getContext('2d')!
  const font = (size: number, bold = false) => `${bold ? 600 : 400} ${size}px ${FONT}`
  measure.font = font(22, true)
  const title = wrap(measure, bugLine(b), textW)
  measure.font = font(14)
  const meta = [
    [b.module, b.page].filter(Boolean).join(' · '),
    [b.reporter, fmtTime(b.createdAt), b.device ? deviceName(b.device) : ''].filter(Boolean).join(' · ')
  ].filter(Boolean)
  const notes = shots.map((s) => marksText(s.marks)).filter(Boolean).join('　')
  const noteLines = notes ? wrap(measure, `图注：${notes}`, textW) : []
  const aiLines = b.aiFix ? wrap(measure, `${aiLabel(b.aiFix)} · ${b.aiFix.summary}`, textW) : []
  measure.font = font(13)
  const linkLines = opts.link ? wrap(measure, `网页查看：${opts.link}`, textW) : []

  // 先算高度
  let H = PAD + 24 + 12 + title.length * 32 + 8 + meta.length * 22
  if (pics.length) H += 16 + 20 + IMG_H
  if (noteLines.length) H += 12 + noteLines.length * 22
  if (aiLines.length) H += 8 + aiLines.length * 22
  if (linkLines.length) H += 18 + 1 + 12 + linkLines.length * 20
  H += PAD

  const canvas = document.createElement('canvas')
  canvas.width = W * SCALE
  canvas.height = H * SCALE
  const ctx = canvas.getContext('2d')!
  ctx.scale(SCALE, SCALE)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  ctx.textBaseline = 'top'

  let y = PAD
  // 编号 + 项目
  ctx.font = font(13, true)
  const no = `#${b.seq}`
  const noW = ctx.measureText(no).width + 14
  ctx.fillStyle = '#e6effc'
  ctx.beginPath()
  ctx.roundRect(PAD, y, noW, 22, 5)
  ctx.fill()
  ctx.fillStyle = '#175cd3'
  ctx.fillText(no, PAD + 7, y + 4)
  ctx.font = font(13)
  ctx.fillStyle = '#8c96a3'
  ctx.fillText(`${p.name} · 第${b.round}轮发现`, PAD + noW + 10, y + 4)
  y += 24 + 12

  ctx.font = font(22, true)
  ctx.fillStyle = '#1b2129'
  for (const l of title) {
    ctx.fillText(l, PAD, y)
    y += 32
  }
  y += 8
  ctx.font = font(14)
  ctx.fillStyle = '#5f6b7a'
  for (const l of meta) {
    ctx.fillText(l, PAD, y)
    y += 22
  }

  if (pics.length) {
    y += 16
    let x = PAD
    for (const pic of pics) {
      ctx.font = font(12.5)
      ctx.fillStyle = pic.label === '对标应用' ? '#b54708' : '#8c96a3'
      ctx.fillText(pic.label, x, y)
      const top = y + 20
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(x, top, pic.w, IMG_H, 10)
      ctx.clip()
      // 宽图（设计稿）按宽度缩放后比框矮，从顶部开始放
      ctx.fillStyle = '#f3f5f8'
      ctx.fillRect(x, top, pic.w, IMG_H)
      ctx.drawImage(pic.img, x, top, pic.w, pic.img.naturalHeight * (pic.w / pic.img.naturalWidth))
      ctx.restore()
      ctx.strokeStyle = '#dde1e7'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(x + 0.5, top + 0.5, pic.w - 1, IMG_H - 1, 10)
      ctx.stroke()
      x += pic.w + GAP
    }
    y += 20 + IMG_H
  }

  ctx.font = font(14)
  if (noteLines.length) {
    y += 12
    ctx.fillStyle = '#1b2129'
    for (const l of noteLines) {
      ctx.fillText(l, PAD, y)
      y += 22
    }
  }
  if (aiLines.length) {
    y += 8
    ctx.fillStyle = AI_COLOR[b.aiFix?.status ?? 'fixed']
    for (const l of aiLines) {
      ctx.fillText(l, PAD, y)
      y += 22
    }
  }
  if (linkLines.length) {
    y += 18
    ctx.fillStyle = '#eef0f3'
    ctx.fillRect(PAD, y, textW, 1)
    y += 13
    ctx.font = font(13)
    ctx.fillStyle = '#8c96a3'
    for (const l of linkLines) {
      ctx.fillText(l, PAD, y)
      y += 20
    }
  }
  return canvas.toDataURL('image/png')
}
