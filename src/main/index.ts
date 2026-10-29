import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, net, protocol, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CheckResult, DeviceInfo, Mark, NewBug, RoundResult, Settings } from '../shared/types'
import { deviceInfo, findAdb, listDevices, screencap } from './adb'
import { exportBaseName, exportZip, type ExportScope } from './exporter'
import { LanServer } from './server'
import { newToken, SettingsStore } from './settings'
import { ProjectStore } from './store'
import { Updater } from './updater'

const dataRoot = join(app.getPath('userData'), 'BugShot')
const store = new ProjectStore(dataRoot)
const settings = new SettingsStore(dataRoot)
let main: BrowserWindow | null = null
let mini: BrowserWindow | null = null
let currentSerial = ''

/** 截好但还没保存的图，保存反馈时再写入项目目录 */
const pending = new Map<string, { png: Buffer; device: DeviceInfo }>()

const broadcast = (channel: string, ...args: unknown[]) => {
  for (const w of [main, mini]) if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
}

const lan = new LanServer(store, join(dataRoot, 'exports'), (msg) => broadcast('agent-activity', msg))
const updater = new Updater((s) => broadcast('update-status', s))

const adb = () => findAdb(settings.value.adbPath, process.resourcesPath ?? '')

protocol.registerSchemesAsPrivileged([{ scheme: 'bugshot', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

function loadRenderer(w: BrowserWindow, hash = '') {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) w.loadURL(process.env.ELECTRON_RENDERER_URL + hash)
  else w.loadFile(join(__dirname, '../renderer/index.html'), { hash: hash.replace('#', '') })
}

function createMain() {
  main = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'BugShot',
    backgroundColor: '#f7f8fa',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  main.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  loadRenderer(main)
  main.on('closed', () => {
    main = null
    mini?.close()
  })
}

function toggleMini(show: boolean) {
  if (!show) {
    mini?.close()
    return
  }
  if (mini) return mini.show()
  mini = new BrowserWindow({
    width: 300,
    height: 64,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    backgroundColor: '#ffffff',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  mini.setAlwaysOnTop(true, 'floating')
  loadRenderer(mini, '#mini')
  mini.on('closed', () => {
    mini = null
    broadcast('mini-closed')
  })
}

function focusMain() {
  if (!main) createMain()
  if (main!.isMinimized()) main!.restore()
  main!.show()
  main!.focus()
}

function requireSerial(serial = currentSerial) {
  if (!serial) throw new Error('没有连接设备，请用 USB 连上手机并打开 USB 调试')
  return serial
}

async function takeCapture(serial = currentSerial) {
  requireSerial(serial)
  const a = adb()
  const [png, device] = await Promise.all([screencap(a, serial), deviceInfo(a, serial)])
  const id = randomUUID()
  pending.set(id, { png, device })
  return { id, dataUrl: `data:image/png;base64,${png.toString('base64')}`, device }
}

/** 快捷键或悬浮窗触发：先截图再把主窗口带到前台 */
async function hotkeyCapture(withShot: boolean) {
  if (!withShot) {
    focusMain()
    broadcast('compose', { capture: null })
    return
  }
  try {
    const cap = await takeCapture()
    focusMain()
    broadcast('compose', { capture: cap })
  } catch (err) {
    focusMain()
    broadcast('toast', (err as Error).message)
  }
}

function pngFromDataUrl(url: string): Buffer {
  const m = /^data:image\/png;base64,(.+)$/.exec(url)
  if (!m) throw new Error('标注图片格式不对')
  return Buffer.from(m[1], 'base64')
}

function takePending(id: string | null | undefined) {
  if (!id) return null
  const p = pending.get(id)
  if (!p) throw new Error('截图已失效，请重新截图')
  pending.delete(id)
  return p
}

function registerShortcuts() {
  globalShortcut.unregisterAll()
  const ok1 = globalShortcut.register('CommandOrControl+Shift+B', () => void hotkeyCapture(true))
  const ok2 = globalShortcut.register('CommandOrControl+Shift+T', () => void hotkeyCapture(false))
  if (!ok1 || !ok2) console.warn('快捷键被其他程序占用')
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

  h('state', () => ({ projects: store.list(), settings: settings.value, lan: lan.info, version: app.getVersion(), update: updater.status, adb: adb() }))
  h('devices', () => listDevices(adb()))
  h('set-device', (serial: string) => {
    currentSerial = serial
  })
  h('capture', (serial?: string) => takeCapture(serial))
  h('discard-capture', (id: string) => {
    pending.delete(id)
  })

  h('project:create', (name: string, developer: string, type: string) => store.createProject({ name, developer, type }))
  h('project:update', (id: string, patch: { name?: string; developer?: string; type?: string }) => store.updateProject(id, patch))
  h('project:delete', async (id: string) => {
    const { response } = await dialog.showMessageBox(main!, {
      type: 'warning',
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: `删除项目“${store.get(id).name}”？`,
      detail: '项目里的反馈和截图会一起删除，无法恢复。'
    })
    if (response === 0) await store.deleteProject(id)
    return response === 0
  })
  h('round:start', (id: string) => store.startRound(id))
  h('round:end', (id: string, result: RoundResult) => store.endRound(id, result))
  h('round:result', (id: string, no: number, result: RoundResult) => store.setRoundResult(id, no, result))

  h('bug:add', async (projectId: string, input: NewBug, captureId: string | null, annot?: { marks: Mark[]; png: string }) => {
    const cap = takePending(captureId)
    const b = await store.addBug(projectId, input, { png: cap?.png, device: cap?.device ?? null })
    if (cap && annot?.marks.length) return store.markShot(projectId, b.id, 0, annot.marks, pngFromDataUrl(annot.png))
    return b
  })
  h('bug:update', (projectId: string, bugId: string, patch: Partial<NewBug>) => store.updateBug(projectId, bugId, patch))
  h('bug:delete', (projectId: string, bugId: string) => store.deleteBug(projectId, bugId))
  h('bug:check', (projectId: string, bugId: string, result: CheckResult | null) => store.setCheck(projectId, bugId, result))
  h('shot:add', async (projectId: string, bugId: string) => store.addShot(projectId, bugId, await screencap(adb(), requireSerial())))
  h('shot:replace', async (projectId: string, bugId: string, index: number) => store.replaceShot(projectId, bugId, index, await screencap(adb(), requireSerial())))
  h('shot:mark', (projectId: string, bugId: string, index: number, marks: Mark[], png: string | null) =>
    store.markShot(projectId, bugId, index, marks, png ? pngFromDataUrl(png) : null)
  )
  h('shot:delete', (projectId: string, bugId: string, index: number) => store.deleteShot(projectId, bugId, index))

  h('copy', (text: string) => clipboard.writeText(text))
  h('export', async (projectId: string, scope: ExportScope) => {
    const p = store.get(projectId)
    const { filePath, canceled } = await dialog.showSaveDialog(main!, {
      defaultPath: join(app.getPath('downloads'), `${exportBaseName(p, scope)}.zip`),
      filters: [{ name: 'Zip', extensions: ['zip'] }]
    })
    if (canceled || !filePath) return null
    const r = await exportZip(store, projectId, scope, filePath)
    shell.showItemInFolder(filePath)
    return { ...r, filePath }
  })

  h('settings:update', async (patch: Partial<Settings>) => {
    const s = await settings.update(patch)
    if (patch.lan) await lan.apply(s.lan)
    broadcast('state-changed')
    return s
  })
  h('settings:new-token', async () => {
    const s = await settings.update({ lan: { ...settings.value.lan, token: newToken() } })
    await lan.apply(s.lan)
    broadcast('state-changed')
    return s
  })
  h('phrase:used', (text: string) => settings.notePhraseUsed(text))
  h('choose-adb', async () => {
    const { filePaths } = await dialog.showOpenDialog(main!, { title: '选择 adb 程序', properties: ['openFile'] })
    if (filePaths[0]) await settings.update({ adbPath: filePaths[0] })
    return adb()
  })

  h('mini', (show: boolean) => toggleMini(show))
  h('mini:compose', (withShot: boolean) => hotkeyCapture(withShot))

  h('update:check', () => updater.check())
  h('update:download', () => updater.download())
  h('update:install', () => updater.install())
}

app.whenReady().then(async () => {
  protocol.handle('bugshot', (req) => {
    // bugshot://shot/<projectId>/<file>
    const u = new URL(req.url)
    const [projectId, file] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (u.hostname !== 'shot' || !projectId || !file || /[\\/]/.test(file)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(store.shotPath(projectId, file)).toString())
  })
  await Promise.all([store.load(), settings.load()])
  store.on('changed', () => broadcast('state-changed'))
  await lan.apply(settings.value.lan)
  ipc()
  registerShortcuts()
  createMain()
  if (settings.value.autoCheckUpdate && app.isPackaged) setTimeout(() => void updater.check(), 5000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMain()
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
