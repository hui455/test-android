import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { releaseNotesText } from '../shared/logic'
import { TaggedGitHubProvider } from './tagged-provider'

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'none'; version: string }
  | { state: 'available'; version: string; notes: string; date: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

/**
 * 从 GitHub Releases 检查并安装新版本。
 * 客户端用 electron-builder.yml 里的 publish 配置（GitHub 上标成“最新”的 v* Release）；
 * 服务端传 server，只看 server-v* 的 Release，里面的更新文件叫 server.yml / server-mac.yml。
 */
export class Updater {
  status: UpdateStatus = { state: 'idle' }

  constructor(
    private notify: (s: UpdateStatus) => void,
    kind: 'client' | 'server' = 'client'
  ) {
    if (kind === 'server') {
      autoUpdater.setFeedURL({
        provider: 'custom',
        updateProvider: TaggedGitHubProvider,
        owner: 'hui455',
        repo: 'test-android',
        tagPrefix: 'server-v',
        channel: 'server'
      } as Parameters<typeof autoUpdater.setFeedURL>[0])
    }
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'none', version: app.getVersion() }))
    autoUpdater.on('update-available', (info) =>
      this.set({
        state: 'available',
        version: info.version,
        date: info.releaseDate,
        notes: typeof info.releaseNotes === 'string' ? releaseNotesText(info.releaseNotes) : (info.releaseNotes ?? []).map((n) => n.note ?? '').join('\n')
      })
    )
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version }))
    autoUpdater.on('error', (err) => this.set({ state: 'error', message: err?.message ?? String(err) }))
  }

  private set(s: UpdateStatus) {
    this.status = s
    this.notify(s)
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.set({ state: 'error', message: '开发模式下不检查更新，请使用打包后的版本' })
      return this.status
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ state: 'error', message: (err as Error).message })
    }
    return this.status
  }

  async download() {
    await autoUpdater.downloadUpdate()
  }

  install() {
    autoUpdater.quitAndInstall()
  }
}
