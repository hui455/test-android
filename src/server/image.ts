import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import { encodeSig, makeSig, type Rgba } from '../shared/match'
import { StoreError } from './errors'

export type ImageType = 'png' | 'jpg'

export function imageType(buf: Buffer): ImageType | null {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  return null
}

/** 纯 JS 解码，服务端（Docker 里没有 Electron）和客户端主进程都能用 */
export function decodeImage(buf: Buffer): Rgba {
  const type = imageType(buf)
  try {
    if (type === 'png') {
      const png = PNG.sync.read(buf)
      return { width: png.width, height: png.height, data: png.data }
    }
    if (type === 'jpg') {
      const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 })
      return { width: img.width, height: img.height, data: img.data }
    }
  } catch (err) {
    throw new StoreError(`图片无法读取：${(err as Error).message}`)
  }
  throw new StoreError('只支持 PNG 或 JPG 图片')
}

/** 图片的尺寸和用来比对的特征 */
export function imageSig(buf: Buffer): { width: number; height: number; sig: string } {
  const img = decodeImage(buf)
  return { width: img.width, height: img.height, sig: encodeSig(makeSig(img)) }
}

const MAX_IMAGE = 30 * 1024 * 1024

/** 下载设计稿图片（AI agent 传来的 Figma 截图链接） */
export async function fetchImage(url: string): Promise<Buffer> {
  if (!/^https?:\/\//i.test(url)) throw new StoreError('image_url 要以 http:// 或 https:// 开头')
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' })
  } catch (err) {
    const cause = (err as Error).cause as Error | undefined
    throw new StoreError(`服务端下载图片失败（${cause?.message ?? (err as Error).message}），可以改传 image_base64`)
  }
  if (!res.ok) throw new StoreError(`服务端下载图片失败（HTTP ${res.status}），链接可能已过期`)
  if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE) throw new StoreError('图片超过 30MB')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_IMAGE) throw new StoreError('图片超过 30MB')
  return buf
}

/** 统一存成 PNG（反馈截图都是 .png） */
export function toPng(buf: Buffer): Buffer {
  if (imageType(buf) === 'png') {
    decodeImage(buf)
    return buf
  }
  const img = decodeImage(buf)
  const png = new PNG({ width: img.width, height: img.height })
  png.data = Buffer.from(img.data)
  return PNG.sync.write(png)
}

/** 3×5 点阵数字，给编号圆点用（服务端没有字体，中文评论不画在图上） */
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111']

const hex = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c)
  const v = m ? parseInt(m[1], 16) : 0xff3b30
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

/**
 * 在截图上画 AI 标的框和编号圆点（编号和 marks 的顺序一致）。
 * 测试人员之后在客户端里改标注时，会用客户端的样式重新画一遍。
 */
export function drawBoxes(buf: Buffer, boxes: { pts: number[]; color: string }[]): Buffer {
  const img = decodeImage(buf)
  const { width: W, height: H } = img
  const data = Buffer.from(img.data)
  const put = (x: number, y: number, [r, g, b]: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = (y * W + x) * 4
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
    data[i + 3] = 255
  }
  const fill = (x1: number, y1: number, x2: number, y2: number, c: [number, number, number]) => {
    for (let y = Math.max(0, Math.round(y1)); y < Math.min(H, Math.round(y2)); y++) for (let x = Math.max(0, Math.round(x1)); x < Math.min(W, Math.round(x2)); x++) put(x, y, c)
  }
  const base = Math.min(W, H)
  const sw = Math.max(3, Math.round(base / 130))
  const r = Math.round(sw * 2.8)
  boxes.forEach((b, i) => {
    const c = hex(b.color)
    const [x1, y1, x2, y2] = b.pts
    fill(x1, y1, x2, y1 + sw, c)
    fill(x1, y2 - sw, x2, y2, c)
    fill(x1, y1, x1 + sw, y2, c)
    fill(x2 - sw, y1, x2, y2, c)
    // 编号圆点画在左上角
    const cx = Math.round(x1)
    const cy = Math.round(y1)
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) put(cx + x, cy + y, c)
    const text = String(i + 1)
    const px = Math.max(1, Math.floor((r * 1.1) / 5))
    const tw = text.length * 4 * px - px
    let ox = cx - Math.floor(tw / 2)
    const oy = cy - Math.floor((5 * px) / 2)
    for (const ch of text) {
      const bits = DIGITS[Number(ch)]
      for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) if (bits[row * 3 + col] === '1') fill(ox + col * px, oy + row * px, ox + (col + 1) * px, oy + (row + 1) * px, [255, 255, 255])
      ox += 4 * px
    }
  })
  const png = new PNG({ width: W, height: H })
  png.data = data
  return PNG.sync.write(png)
}
