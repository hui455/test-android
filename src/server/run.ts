import { join } from 'node:path'
import type { ServerConfig } from '../shared/types'
import { Backup, dirSize } from './backup'
import { ConfigStore } from './config'
import { Beacon } from './discovery'
import { BugShotServer } from './http'
import { ProjectStore } from './store'

export interface ServerStats {
  projects: number
  bugs: number
  bytes: number
}

/** 起一个完整的服务端：数据、HTTP（客户端接口 + MCP + 网页）、局域网自动发现、自动备份 */
export async function startServer(opts: { dataRoot: string; version: string; overrides?: Partial<ServerConfig> }) {
  const store = new ProjectStore(opts.dataRoot)
  const config = new ConfigStore(opts.dataRoot)
  await Promise.all([store.load(), config.load(opts.overrides)])
  const http = new BugShotServer(store, config, join(opts.dataRoot, 'exports'), opts.version)
  const beacon = new Beacon(() => http.info())
  const backup = new Backup(opts.dataRoot)
  await http.start()
  await beacon.start()
  backup.schedule(() => config.value.autoBackup)

  return {
    store,
    config,
    http,
    backup,
    dataRoot: opts.dataRoot,
    /** 改了端口或令牌后重启 HTTP，已连的客户端会自动重连 */
    async update(patch: Partial<ServerConfig>) {
      const before = config.value
      const after = await config.update(patch)
      if (after.port !== before.port || after.token !== before.token || after.requireToken !== before.requireToken) await http.start()
      return after
    },
    async stats(): Promise<ServerStats> {
      const list = store.list()
      return { projects: list.length, bugs: list.reduce((n, p) => n + p.bugs.length, 0), bytes: await dirSize(join(opts.dataRoot, 'projects')) }
    },
    async stop() {
      backup.stop()
      beacon.stop()
      await http.stop()
    }
  }
}

export type RunningServer = Awaited<ReturnType<typeof startServer>>
