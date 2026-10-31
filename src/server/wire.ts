/** 客户端和服务端之间的 JSON：Buffer 写成 {"$b64": "..."} */

export function encode(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return { $b64: v.toString('base64') }
  if (Array.isArray(v)) return v.map(encode)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]))
  return v
}

export function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.$b64 === 'string' && Object.keys(o).length === 1) return Buffer.from(o.$b64, 'base64')
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decode(x)]))
  }
  return v
}

export const CLIENT_HEADER = 'x-bugshot-client'

/** 客户端带上自测令牌的请求头，团队令牌仍然放在 Authorization 里 */
export const DEV_HEADER = 'x-bugshot-dev'
