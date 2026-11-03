import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, nativeImage, protocol, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { CheckResult, ConnSettings, DeviceInfo, Mark, NewBug, RoundResult, Settings } from '../shared/types'
import { exportBaseName, type ExportScope } from '../server/exporter'
import { decodeImage } from '../server/image'
import { bugShareUrl } from '../shared/logic'
import { makeSig, rankDesigns, type Sig } from '../shared/match'
import { discover } from '../server/discovery'
import { deviceInfo, findAdb, listDevices, screencap } from './adb'
import { Legacy } from './legacy'
import { RemoteError, RemoteStore } from './remote'
import { SettingsStore } from './settings'
import { Updater } from './updater'

// 同一台电脑只开一个客户端，再打开时切回已有窗口
if (!app.requestSingleInstanceLock()) app.exit(0)

const dataRoot = join(app.getPath('userData'), 'BugShot')
const store = new RemoteStore(join(dataRoot, 'client'))
const legacy = new Legacy(dataRoot, store)
const settings = new SettingsStore(dataRoot)
let main: BrowserWindow | null = null
let mini: BrowserWindow | null = null
let currentSerial = ''
/** 对标机：装着对标应用的第二台手机，可以不设 */
let refSerial = ''

/** 截好但还没保存的图，保存反馈时再写入项目目录 */
const pending = new Map<string, { png: Buffer; device: DeviceInfo; sig?: Sig }>()

const broadcast = (channel: string, ...args: unknown[]) => {
  for (const w of [main, mini]) if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
}

const updater = new Updater((s) => broadcast('update-status', s))

const adb = () => findAdb(settings.value.adbPath, process.resourcesPath ?? '')

/** 服务端装在本机时地址是 127.0.0.1，发给别人要换成局域网 IP */
function reachableUrl(url: string): string {
  const u = new URL(url)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return url
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')) {
        u.hostname = ni.address
        return u.toString()
      }
    }
  }
  return url
}

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

/** 快捷键或悬浮窗触发：先截图再把主窗口带到前台。项目开了对标并选了对标机时，两台一起截 */
async function hotkeyCapture(withShot: boolean) {
  if (!withShot) {
    focusMain()
    broadcast('compose', { capture: null })
    return
  }
  try {
    const [cap, refCapture] = await Promise.all([takeCapture(), refSerial ? takeCapture(refSerial).catch(() => null) : null])
    focusMain()
    broadcast('compose', { capture: cap, refCapture })
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

  h('state', () => ({
    projects: store.list(),
    selftests: store.selfList(),
    settings: settings.value,
    conn: { ...store.state, legacy: legacy.count },
    version: app.getVersion(),
    update: updater.status,
    adb: adb()
  }))
  h('devices', () => listDevices(adb()))
  h('set-device', async (serial: string) => {
    currentSerial = serial
    const d = serial ? await deviceInfo(adb(), serial).catch(() => null) : null
    store.setDevice(d ? `${d.brand} ${d.model}`.trim() : '')
  })

  // 只有当前项目打开了“对标应用”开关时，界面才会传对标机过来
  h('set-ref-device', (serial: string) => {
    refSerial = serial
  })
  h('conn:discover', () => discover())
  h('conn:probe', (conn: ConnSettings) => store.probe(conn))
  h('conn:save', async (conn: ConnSettings) => {
    const s = await settings.update({ server: conn })
    store.configure(s.server)
    broadcast('state-changed')
  })
  h('conn:retry', () => store.connect())
  h('legacy:upload', () => legacy.upload(settings.value.server.name))
  h('capture', (serial?: string) => takeCapture(serial))
  h('discard-capture', (id: string) => {
    pending.delete(id)
  })
  // 截图和项目里的设计稿比对，返回最像的 3 个；不用连服务端
  h('design:match', (projectId: string, captureId: string) => {
    const cap = pending.get(captureId)
    const designs = store.get(projectId).designs ?? []
    if (!cap || !designs.length) return []
    cap.sig ??= makeSig(decodeImage(cap.png))
    return rankDesigns(cap.sig, designs)
  })
  h('design:add', async (projectId: string) => {
    const { filePaths } = await dialog.showOpenDialog(main!, {
      title: '选择设计稿图片（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }]
    })
    for (const f of filePaths) {
      await store.mutate(projectId, 'upsertDesign', projectId, { page: '手动添加', name: basename(f, extname(f)), image: await readFile(f) })
    }
    return filePaths.length
  })
  h('design:delete', (projectId: string, designId: string) => store.mutate(projectId, 'deleteDesign', projectId, designId))

  // 开发自测：只有填了自测令牌才用得了，服务端也会再检查一次
  h('self:enable', (projectId: string, on: boolean) => store.selfMutate(projectId, 'selfEnable', on))
  h('self:comment', (projectId: string, pageId: string, text: string, marks: Mark[], markedDataUrl: string | null) =>
    store.selfMutate(projectId, 'selfComment', pageId, { text, marks, markedPng: markedDataUrl ? Buffer.from(markedDataUrl.replace(/^data:[^,]+,/, ''), 'base64') : null })
  )
  h('self:pass', (projectId: string, pageId: string, passed: boolean) => store.selfMutate(projectId, 'selfPass', pageId, passed))
  h('self:design', (projectId: string, pageId: string, designId: string | null) => store.selfMutate(projectId, 'selfDesign', pageId, designId))
  h('self:delete', async (projectId: string, pageId: string, name: string) => {
    const { response } = await dialog.showMessageBox(main!, { type: 'warning', buttons: ['删除', '取消'], defaultId: 1, cancelId: 1, message: `删除开发自测里的“${name}”？`, detail: '这一页所有版本的截图和评论都会删掉。AI 之后再传同名页面会重新出现。' })
    if (response !== 0) return false
    await store.selfMutate(projectId, 'selfDelete', pageId)
    return true
  })

  h('project:create', async (name: string, developer: string, type: string) => {
    const p = await store.mutate<{ id: string }>(null, 'createProject', { name, developer, type })
    return store.get(p.id)
  })
  h('project:update', (id: string, patch: { name?: string; developer?: string; type?: string; refApp?: boolean }) => store.mutate(id, 'updateProject', id, patch))
  h('project:delete', async (id: string) => {
    const { response } = await dialog.showMessageBox(main!, {
      type: 'warning',
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: `删除项目“${store.get(id).name}”？`,
      detail: '项目里的反馈和截图会一起删除，无法恢复。'
    })
    if (response === 0) await store.mutate(id, 'deleteProject', id)
    return response === 0
  })
  h('round:start', (id: string) => store.mutate(id, 'startRound', id))
  h('round:end', (id: string, result: RoundResult) => store.mutate(id, 'endRound', id, result))
  h('round:result', (id: string, no: number, result: RoundResult) => store.mutate(id, 'setRoundResult', id, no, result))

  h('bug:add', async (projectId: string, input: NewBug, captureId: string | null, annot?: { marks: Mark[]; png: string }, refCaptureId?: string | null) => {
    const cap = takePending(captureId)
    const ref = takePending(refCaptureId)
    const marked = cap && annot?.marks.length ? { marks: annot.marks, markedPng: pngFromDataUrl(annot.png) } : {}
    const b = await store.addBug(projectId, input, { png: cap?.png, device: cap?.device ?? null, ...marked, refPng: ref?.png, refDevice: ref?.device ?? null })
    if (b.pending) broadcast('toast', '服务端连不上，已先存在本机，连上后自动上传')
    return b
  })
  h('bug:update', async (projectId: string, bugId: string, patch: Partial<NewBug>) => {
    try {
      return await store.updateBug(projectId, bugId, patch)
    } catch (err) {
      if (!(err instanceof RemoteError) || err.code !== 'conflict') throw err
      const { response } = await dialog.showMessageBox(main!, {
        type: 'question',
        buttons: ['用我的覆盖', '取消'],
        defaultId: 1,
        cancelId: 1,
        message: `这条反馈刚被${err.by || '别人'}修改过`,
        detail: '覆盖会用你填的内容替换掉对方的修改。取消后可以先看看对方改了什么。'
      })
      if (response !== 0) throw new Error('已取消，列表里是最新的内容')
      return store.updateBug(projectId, bugId, patch, true)
    }
  })
  h('bug:delete', (projectId: string, bugId: string) => store.deleteBug(projectId, bugId))
  h('bug:check', (projectId: string, bugId: string, result: CheckResult | null) => store.mutate(projectId, 'setCheck', projectId, bugId, result))
  h('shot:add', async (projectId: string, bugId: string, ref = false) => {
    if (!ref) return store.shotOp('addShot', projectId, bugId, await screencap(adb(), requireSerial()))
    if (!refSerial) throw new Error('还没有选对标机，在顶部“对标机”里选第二台手机')
    const [png, device] = await Promise.all([screencap(adb(), refSerial), deviceInfo(adb(), refSerial)])
    return store.shotOp('addShot', projectId, bugId, png, { ref: true, device })
  })
  h('shot:replace', async (projectId: string, bugId: string, index: number) => {
    const isRef = !!store.get(projectId).bugs.find((b) => b.id === bugId)?.shots[index]?.ref
    if (isRef && !refSerial) throw new Error('这是对标机的截图，先在顶部“对标机”里选第二台手机')
    return store.shotOp('replaceShot', projectId, bugId, index, await screencap(adb(), isRef ? refSerial : requireSerial()))
  })
  h('shot:mark', (projectId: string, bugId: string, index: number, marks: Mark[], png: string | null) =>
    store.shotOp('markShot', projectId, bugId, index, marks, png ? pngFromDataUrl(png) : null)
  )
  h('shot:delete', (projectId: string, bugId: string, index: number) => store.shotOp('deleteShot', projectId, bugId, index))

  h('copy', (text: string) => (clipboard.writeText(text), true))
  h('copy:image', (dataUrl: string) => (clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)), true))
  h('bug:link', (projectId: string, seq: number) => {
    // plain 不带令牌，印在图片上；打开过网页的浏览器记得令牌，直接能看
    const { url, token } = settings.value.server
    if (!url) return { full: '', plain: '' }
    const base = reachableUrl(url)
    return { full: bugShareUrl(base, token, projectId, seq), plain: bugShareUrl(base, '', projectId, seq) }
  })
  h('export', async (projectId: string, scope: ExportScope) => {
    const p = store.get(projectId)
    const { filePath, canceled } = await dialog.showSaveDialog(main!, {
      defaultPath: join(app.getPath('downloads'), `${exportBaseName(p, scope)}.zip`),
      filters: [{ name: 'Zip', extensions: ['zip'] }]
    })
    if (canceled || !filePath) return null
    const r = await store.exportZip(projectId, scope, filePath)
    shell.showItemInFolder(filePath)
    return { ...r, filePath }
  })

  h('settings:update', async (patch: Partial<Settings>) => {
    const s = await settings.update(patch)
    if (patch.server) store.configure(s.server)
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

app.on('second-instance', () => focusMain())

app.whenReady().then(async () => {
  protocol.handle('bugshot', async (req) => {
    // bugshot://shot|design|selftest/<projectId>/<file>，从服务端取，取过的存在本机缓存
    const u = new URL(req.url)
    const [projectId, file] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (!['shot', 'design', 'selftest'].includes(u.hostname) || !projectId || !file || /[\\/]/.test(file)) return new Response('not found', { status: 404 })
    try {
      const data = u.hostname === 'design' ? await store.readDesign(projectId, file) : u.hostname === 'selftest' ? await store.readSelfShot(projectId, file) : await store.readShot(projectId, file)
      return new Response(new Uint8Array(data), { headers: { 'content-type': file.endsWith('.jpg') ? 'image/jpeg' : 'image/png' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
  await Promise.all([store.load(), settings.load(), legacy.load()])
  store.on('changed', () => broadcast('state-changed'))
  store.on('activity', (msg: string) => broadcast('agent-activity', msg))
  // 记住服务端名称，或者服务端换了 IP 后自动找到的新地址
  store.on('conn', (conn: ConnSettings) => void settings.update({ server: conn }).then(() => broadcast('state-changed')))
  store.configure(settings.value.server)
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
