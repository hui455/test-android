import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const KEEP = 7
const HOUR = 3

const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 把 projects/ 整份复制到 backups/<日期>/，只保留最近 7 份 */
export class Backup {
  private timer: NodeJS.Timeout | null = null
  last = ''

  constructor(private root: string) {}

  private dir = () => join(this.root, 'backups')

  async refresh() {
    const list = await this.list()
    this.last = list.at(-1) ?? ''
  }

  async list(): Promise<string[]> {
    if (!existsSync(this.dir())) return []
    return (await readdir(this.dir())).filter((n) => /^\d{4}-\d{2}-\d{2}/.test(n)).sort()
  }

  async run(name = day()): Promise<string> {
    const src = join(this.root, 'projects')
    await mkdir(this.dir(), { recursive: true })
    const dest = join(this.dir(), name)
    await rm(dest, { recursive: true, force: true })
    if (existsSync(src)) await cp(src, dest, { recursive: true })
    else await mkdir(dest)
    const all = await this.list()
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) await rm(join(this.dir(), old), { recursive: true, force: true })
    this.last = name
    return dest
  }

  /** 每 10 分钟看一次：过了 3 点且今天还没备份就备份 */
  schedule(enabled: () => boolean) {
    this.stop()
    const tick = async () => {
      if (!enabled() || new Date().getHours() < HOUR) return
      if ((await this.list()).some((n) => n.startsWith(day()))) return
      await this.run().catch((err) => console.error('自动备份失败:', err))
    }
    void this.refresh().then(tick)
    this.timer = setInterval(() => void tick(), 10 * 60 * 1000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/** 数据目录大小（字节），服务端窗口里显示 */
export async function dirSize(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(p)
    else total += (await stat(p)).size
  }
  return total
}
