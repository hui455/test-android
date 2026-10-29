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
