import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import type { ServerInfo } from '../shared/types'

/** 局域网自动发现：客户端广播一句询问，服务端用 UDP 回复自己的名称和端口 */
export const DISCOVERY_PORT = 17801
const ASK = 'BUGSHOT_DISCOVER_1'

export interface Found {
  name: string
  url: string
  version: string
}

export class Beacon {
  private sock: Socket | null = null

  constructor(
    private info: () => ServerInfo,
    private port = DISCOVERY_PORT
  ) {}

  start(): Promise<void> {
    this.stop()
    const sock = createSocket({ type: 'udp4', reuseAddr: true })
    this.sock = sock
    sock.on('message', (msg, rinfo) => {
      if (msg.toString() !== ASK) return
      sock.send(JSON.stringify(this.info()), rinfo.port, rinfo.address)
    })
    return new Promise((resolve) => {
      // 端口被占用时只是不能被自动发现，手填地址仍然可以连
      sock.on('error', (err) => {
        console.warn('局域网自动发现不可用:', err.message)
        this.stop()
        resolve()
      })
      sock.bind(this.port, () => resolve())
    })
  }

  stop() {
    try {
      this.sock?.close()
    } catch {
      /* 已经关了 */
    }
    this.sock = null
  }
}

/** 每块网卡的广播地址，再加上 255.255.255.255 */
function broadcastAddresses(): string[] {
  const out = new Set(['255.255.255.255'])
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      const ip = ni.address.split('.').map(Number)
      const mask = ni.netmask.split('.').map(Number)
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'))
    }
  }
  return [...out]
}

export function discover(timeoutMs = 1500, port = DISCOVERY_PORT): Promise<Found[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Found>()
    const sock = createSocket('udp4')
    const done = () => {
      try {
        sock.close()
      } catch {
        /* 已经关了 */
      }
      resolve([...found.values()])
    }
    sock.on('error', done)
    sock.on('message', (msg, rinfo) => {
      try {
        const info = JSON.parse(msg.toString()) as ServerInfo
        if (info.app !== 'bugshot-server') return
        // 用服务端自己报的局域网 IP：同一台服务端从几块网卡回复时只列一次
        const url = `http://${info.address || rinfo.address}:${info.port}`
        found.set(url, { name: info.name, url, version: info.version })
      } catch {
        /* 不是 BugShot 的回复 */
      }
    })
    sock.bind(0, () => {
      sock.setBroadcast(true)
      for (const addr of [...broadcastAddresses(), '127.0.0.1']) sock.send(ASK, port, addr, () => {})
      setTimeout(done, timeoutMs)
    })
  })
}
