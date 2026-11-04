import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerConfig } from '../shared/types'
import { newDevToken, newToken } from '../server/config'
import { startServer, type RunningServer } from '../server/run'
import { Updater } from './updater'

/**
 * BugShot 服务端（带窗口的版本）：装在局域网里一台常开的电脑上。
 * 关掉窗口后在托盘继续运行，可以设置开机自动启动。
 */
app.setName('BugShot Server')
app.setPath('userData', join(app.getPath('appData'), 'BugShot Server'))
if (!app.requestSingleInstanceLock()) app.exit(0)

const ICON =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAa0lEQVR42mNgwAOeevj+pwZmIAVQy1KyHENry/E6gl6WY3UEvS3HcMTIdsBAWQ53xKgDyNWIDujmAEKApg4gFgxPB5AKRh0w/BwwmgsGRUE0KIri0dpwWLWKRhulg6djMii6ZoOiczoQ3XMAYm7R7M7UkfoAAAAASUVORK5CYII='

declare const __SERVER_VERSION__: string
/** 服务端有自己的版本号（package.json 的 serverVersion），和客户端分开 */
const VERSION = __SERVER_VERSION__

const locationFile = join(app.getPath('userData'), 'location.json')
let srv: RunningServer
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
const startedAt = Date.now()

async function dataRoot(): Promise<string> {
  try {
    const { dataDir } = JSON.parse(await readFile(locationFile, 'utf8')) as { dataDir?: string }
    if (dataDir) return dataDir
  } catch {
    /* 用默认位置 */
  }
  return join(app.getPath('userData'), 'data')
}

const push = () => {
  if (win && !win.isDestroyed()) win.webContents.send('state-changed')
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    title: 'BugShot 服务端',
    backgroundColor: '#f7f8fa',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL + '#server')
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'server' })
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win?.hide()
  })
}

function showWindow() {
  if (!win) createWindow()
  win!.show()
  win!.focus()
}

const webUrl = () => {
  const c = srv.config.value
  return `${srv.http.status.webUrl}/${c.requireToken ? `?token=${encodeURIComponent(c.token)}` : ''}`
}

function createTray() {
  tray = new Tray(nativeImage.createFromDataURL(`data:image/png;base64,${ICON}`).resize({ width: 16, height: 16 }))
  tray.setToolTip('BugShot 服务端')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开窗口', click: showWindow },
      { label: '打开网页', click: () => shell.openExternal(webUrl()) },
      { type: 'separator' },
      {
        label: '退出服务端',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showWindow)
}

function ipc() {
  const h = <A extends unknown[], R>(name: string, fn: (...a: A) => R | Promise<R>) =>
    ipcMain.handle(name, async (_e, ...args) => {
      try {
        return { ok: true, value: await fn(...(args as A)) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    })

  h('srv:state', async () => ({
    version: VERSION,
    status: srv.http.status,
    config: srv.config.value,
    clients: srv.http.clients(),
    stats: await srv.stats(),
    dataRoot: srv.dataRoot,
    lastBackup: srv.backup.last,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    uptime: Date.now() - startedAt
  }))
  h('srv:update', async (patch: Partial<ServerConfig>) => {
    await srv.update(patch)
    push()
  })
  h('srv:new-token', async () => {
    await srv.update({ token: newToken() })
    push()
  })
  h('srv:new-dev-token', async () => {
    await srv.update({ devToken: newDevToken() })
    push()
  })
  h('srv:backup', async () => {
    const dest = await srv.backup.run()
    push()
    return dest
  })
  h('srv:login', (open: boolean) => {
    app.setLoginItemSettings({ openAtLogin: open, openAsHidden: true, args: ['--hidden'] })
    push()
  })
  h('srv:open-web', () => shell.openExternal(webUrl()))
  h('srv:open-dir', () => shell.openPath(srv.dataRoot))
  h('srv:change-dir', async () => {
    const { filePaths } = await dialog.showOpenDialog(win!, { title: '选择数据目录', properties: ['openDirectory', 'createDirectory'] })
    const dir = filePaths[0]
    if (!dir || dir === srv.dataRoot) return false
    const hasData = existsSync(join(dir, 'server.json'))
    const { response } = await dialog.showMessageBox(win!, {
      type: 'question',
      buttons: [hasData ? '改用那里的数据' : '复制过去并切换', '取消'],
      defaultId: 0,
      cancelId: 1,
      message: hasData ? '这个目录里已经有 BugShot 数据' : `把现在的数据复制到 ${dir}？`,
      detail: hasData ? '切换后会使用那里的项目和设置，现在这份数据保留不动。' : '复制完成后服务端会重新启动，客户端会自动重连。原来的数据保留不动。'
    })
    if (response !== 0) return false
    if (!hasData) {
      await mkdir(dir, { recursive: true })
      for (const name of await readdir(srv.dataRoot)) if (name !== 'backups') await cp(join(srv.dataRoot, name), join(dir, name), { recursive: true })
    }
    await writeFile(locationFile, JSON.stringify({ dataDir: dir }))
    quitting = true
    app.relaunch()
    app.exit(0)
    return true
  })
  h('copy', (text: string) => clipboard.writeText(text))
  // 服务端走自己的更新通道（Release 里的 server.yml / server-mac.yml），和客户端的 latest.yml 互不影响
  h('srv:update-state', () => updater.status)
  h('srv:update-check', () => updater.check())
  h('srv:update-download', () => updater.download())
  h('srv:update-install', () => {
    quitting = true
    updater.install()
  })
  // 自动更新失败时的退路：打开 Release 页手动下载
  h('srv:open-url', (url: string) => {
    if (url.startsWith('https://github.com/hui455/test-android/')) void shell.openExternal(url)
  })
}

const updater = new Updater((s) => {
  if (win && !win.isDestroyed()) win.webContents.send('update-status', s)
}, 'server')

app.on('second-instance', showWindow)
app.on('before-quit', () => {
  quitting = true
})

app.whenReady().then(async () => {
  srv = await startServer({ dataRoot: await dataRoot(), version: VERSION })
  srv.store.on('changed', push)
  srv.http.on('clients', push)
  ipc()
  createTray()
  if (!process.argv.includes('--hidden')) createWindow()
  app.on('activate', showWindow)
  // 服务端常年开着：启动后查一次，之后每 6 小时查一次，有新版本在窗口标题栏提示
  if (app.isPackaged) {
    setTimeout(() => void updater.check(), 5000)
    setInterval(() => {
      if (updater.status.state !== 'downloading' && updater.status.state !== 'ready') void updater.check()
    }, 6 * 3_600_000)
  }
})

// 窗口全关了也继续跑，只有托盘里点“退出服务端”才退出
app.on('window-all-closed', () => {})
app.on('will-quit', () => void srv?.stop())
