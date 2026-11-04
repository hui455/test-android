import { URL } from 'node:url'
import { Provider, type UpdateInfo } from 'electron-updater'
import { parseUpdateInfo, resolveFiles, type ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'
import { getChannelFilename } from 'electron-updater/out/util'
import { latestTagged } from '../shared/logic'

export interface TaggedOptions {
  provider: 'custom'
  owner: string
  repo: string
  /** 只看这个前缀的标签，如 server-v */
  tagPrefix: string
  /** 更新文件名，如 server → server.yml / server-mac.yml */
  channel: string
}

type TaggedInfo = UpdateInfo & { tag: string }

/**
 * 服务端和客户端放在同一个仓库、分开发 Release。GitHub 的“最新版本”永远是客户端，
 * 所以服务端不能用自带的 github 方式（它只看“最新版本”），改成在 Release 列表里找 server-v 开头的最新一个。
 */
export class TaggedGitHubProvider extends Provider<TaggedInfo> {
  private base = new URL('https://github.com')

  constructor(
    private options: TaggedOptions,
    _updater: unknown,
    runtime: ProviderRuntimeOptions
  ) {
    // GitHub 的下载走 S3，不支持一次请求多个分段
    super({ ...runtime, isUseMultipleRangeRequest: false })
  }

  async getLatestVersion(): Promise<TaggedInfo> {
    const { owner, repo, tagPrefix } = this.options
    const list = await this.httpRequest(new URL(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`), { accept: 'application/vnd.github+json' })
    const release = latestTagged(JSON.parse(list ?? '[]') as { tag_name: string; draft: boolean; prerelease: boolean; body?: string }[], tagPrefix)
    if (!release) throw new Error(`GitHub Releases 里还没有 ${tagPrefix} 开头的版本`)
    const file = getChannelFilename(this.getCustomChannelName(this.options.channel))
    const url = this.downloadUrl(release.tag_name, file)
    let raw: string | null
    try {
      raw = await this.httpRequest(url)
    } catch (err) {
      throw new Error(`${release.tag_name} 里没有更新文件 ${file}：${(err as Error).message}`)
    }
    const info = parseUpdateInfo(raw, file, url)
    if (info.releaseNotes == null && release.body) info.releaseNotes = release.body
    return { ...info, tag: release.tag_name }
  }

  resolveFiles(info: TaggedInfo) {
    return resolveFiles(info, this.base, (p) => this.downloadUrl(info.tag, p.replace(/ /g, '-')).pathname)
  }

  private downloadUrl(tag: string, file: string) {
    return new URL(`/${this.options.owner}/${this.options.repo}/releases/download/${tag}/${file}`, this.base)
  }
}
