// 下载当前系统的 Android platform-tools 到 resources/platform-tools，打包时内置进安装包
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform]
if (!os) throw new Error(`不支持的系统：${process.platform}`)

const dir = join(process.cwd(), 'resources')
const zip = join(dir, 'platform-tools.zip')
const url = `https://dl.google.com/android/repository/platform-tools-latest-${os}.zip`

mkdirSync(dir, { recursive: true })
rmSync(join(dir, 'platform-tools'), { recursive: true, force: true })
console.log(`下载 ${url}`)
const res = await fetch(url)
if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
// Windows 自带的 tar 能解 zip，macOS / Linux 用 unzip
if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', dir], { stdio: 'inherit' })
else execFileSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'inherit' })
rmSync(zip)
const adb = join(dir, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
if (!existsSync(adb)) throw new Error('解压后没有找到 adb')
console.log(`已就绪：${adb}`)
