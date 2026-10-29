import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'none'; version: string }
  | { state: 'available'; version: string; notes: string; date: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

/** 从 GitHub Releases（electron-builder.yml 里的 publish 配置）检查并安装新版本 */
export class Updater {
  status: UpdateStatus = { state: 'idle' }

  constructor(private notify: (s: UpdateStatus) => void) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'none', version: app.getVersion() }))
    autoUpdater.on('update-available', (info) =>
      this.set({
        state: 'available',
        version: info.version,
        date: info.releaseDate,
        notes: typeof info.releaseNotes === 'string' ? info.releaseNotes.replace(/<[^>]+>/g, '') : (info.releaseNotes ?? []).map((n) => n.note ?? '').join('\n')
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
