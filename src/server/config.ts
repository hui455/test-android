import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import type { ServerConfig } from '../shared/types'

export const newToken = () => 'bs_' + randomBytes(9).toString('base64url')

export const DEFAULT_PORT = 17800

export const defaultConfig = (): ServerConfig => ({
  name: hostname().replace(/\.local$/, '') || 'BugShot 服务端',
  port: DEFAULT_PORT,
  token: newToken(),
  requireToken: true,
  readOnly: false,
  autoBackup: true
})

/** 服务端设置，和数据放在同一个目录，搬数据目录时一起带走 */
export class ConfigStore {
  private file: string
  value: ServerConfig = defaultConfig()

  constructor(root: string) {
    this.file = join(root, 'server.json')
  }

  async load(overrides: Partial<ServerConfig> = {}): Promise<ServerConfig> {
    if (existsSync(this.file)) {
      try {
        this.value = { ...defaultConfig(), ...(JSON.parse(await readFile(this.file, 'utf8')) as Partial<ServerConfig>) }
      } catch (err) {
        console.error('server.json 损坏，使用默认设置:', err)
      }
    }
    this.value = { ...this.value, ...overrides }
    await this.save()
    return this.value
  }

  async update(patch: Partial<ServerConfig>): Promise<ServerConfig> {
    this.value = { ...this.value, ...patch }
    await this.save()
    return this.value
  }

  private async save() {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(this.value, null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}
