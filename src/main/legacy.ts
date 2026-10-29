import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectStore } from '../server/store'
import type { Project } from '../shared/types'
import type { RemoteStore } from './remote'

/** v0.1 / v0.2 的数据存在本机 projects/ 下，连上服务端后可以一次性上传 */
export class Legacy {
  private local: ProjectStore
  count = 0

  constructor(
    private root: string,
    private remote: RemoteStore
  ) {
    this.local = new ProjectStore(root)
  }

  private doneFile = () => join(this.root, 'projects', 'uploaded.json')
  private uploaded = new Set<string>()

  async load() {
    if (!existsSync(join(this.root, 'projects'))) return
    await this.local.load()
    if (existsSync(this.doneFile())) this.uploaded = new Set(JSON.parse(await readFile(this.doneFile(), 'utf8')) as string[])
    this.count = this.local.list().filter((p) => !this.uploaded.has(p.id)).length
  }

  async upload(from: string): Promise<{ projects: Project[] }> {
    if (this.remote.state.status !== 'online') throw new Error('先连上服务端再上传')
    const done: Project[] = []
    for (const p of this.local.list().filter((x) => !this.uploaded.has(x.id))) {
      const files: Record<string, Buffer> = {}
      for (const b of p.bugs)
        for (const s of b.shots)
          for (const f of [s.file, s.marked])
            if (f && existsSync(this.local.shotPath(p.id, f))) files[f] = await readFile(this.local.shotPath(p.id, f))
      const np = await this.remote.mutate<Project>(null, 'importProject', p, files)
      done.push(np)
      // 中途断了下次只传剩下的
      this.uploaded.add(p.id)
      await writeFile(this.doneFile(), JSON.stringify([...this.uploaded]))
      this.count--
    }
    // 留一份原始目录，万一要找回
    const stamp = new Date().toISOString().slice(0, 10)
    await rename(join(this.root, 'projects'), join(this.root, `projects-uploaded-${stamp}`)).catch(() => {})
    this.count = 0
    return { projects: done }
  }
}
