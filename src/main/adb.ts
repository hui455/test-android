import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DeviceInfo } from '../shared/types'

export type DeviceState = 'device' | 'unauthorized' | 'offline' | string

export interface DeviceEntry {
  serial: string
  state: DeviceState
  model: string
  transport: 'usb' | 'tcp'
}

export class AdbError extends Error {}

const exe = process.platform === 'win32' ? 'adb.exe' : 'adb'

/** 依次查找：设置里指定的路径、安装包内置的 platform-tools、ANDROID_HOME、系统 PATH */
export function findAdb(configured: string, resourcesDir: string): string {
  const candidates = [
    configured,
    join(resourcesDir, 'platform-tools', exe),
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', exe),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'platform-tools', exe)
  ].filter((x): x is string => !!x)
  return candidates.find((p) => existsSync(p)) ?? exe
}

function run(adb: string, args: string[], binary = false, timeout = 15000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(adb, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.toString().trim() || err.message
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') reject(new AdbError('找不到 adb，请在设置里指定 adb 路径'))
        else reject(new AdbError(msg))
        return
      }
      resolve(binary ? stdout : Buffer.from(stdout.toString()))
    })
  })
}

const text = async (adb: string, args: string[]) => (await run(adb, args)).toString().trim()

export function parseDevices(out: string): DeviceEntry[] {
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/)
      const model = rest.find((x) => x.startsWith('model:'))?.slice(6).replace(/_/g, ' ') ?? serial
      return { serial, state, model, transport: serial.includes(':') ? 'tcp' : 'usb' } as DeviceEntry
    })
}

export async function listDevices(adb: string): Promise<DeviceEntry[]> {
  return parseDevices(await text(adb, ['devices', '-l']))
}

/** 截取设备当前画面，返回 PNG 数据 */
export async function screencap(adb: string, serial: string): Promise<Buffer> {
  const png = await run(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], true, 20000)
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new AdbError('截图失败：设备没有返回图片，请确认手机已解锁并授权 USB 调试')
  return png
}

export function parseForeground(dumpsys: string): string {
  const m = dumpsys.match(/mCurrentFocus=Window\{[^}]*\s([\w.]+\/[\w.$]+)\}/) ?? dumpsys.match(/mFocusedApp=.*?\s([\w.]+\/[\w.$]+)/)
  return m?.[1] ?? ''
}

export async function deviceInfo(adb: string, serial: string): Promise<DeviceInfo> {
  const prop = (k: string) => text(adb, ['-s', serial, 'shell', 'getprop', k]).catch(() => '')
  const [model, brand, androidVersion, sdk, size, focus] = await Promise.all([
    prop('ro.product.model'),
    prop('ro.product.brand'),
    prop('ro.build.version.release'),
    prop('ro.build.version.sdk'),
    text(adb, ['-s', serial, 'shell', 'wm', 'size']).catch(() => ''),
    text(adb, ['-s', serial, 'shell', 'dumpsys', 'window']).catch(() => '')
  ])
  const res = size.match(/Override size:\s*(\d+x\d+)/)?.[1] ?? size.match(/Physical size:\s*(\d+x\d+)/)?.[1] ?? ''
  return { serial, model, brand, androidVersion, sdk, resolution: res.replace('x', '×'), foreground: parseForeground(focus) }
}
