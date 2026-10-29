// 从 CHANGELOG.md 取出某个版本那一段，发版时写进 GitHub Release 说明（客户端“检查更新”里显示的就是它）。
// 用法：node scripts/release-notes.mjs [输出文件]，版本号取 package.json。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** @param {string} text CHANGELOG.md 的内容 @param {string} version 例如 0.5.0 @returns {string} 没有这一版时返回空字符串 */
export function releaseNotes(text, version) {
  const v = version.replace(/^v/, '')
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => new RegExp(`^##\\s+v?${v.replace(/\./g, '\\.')}(\\s|$)`).test(l))
  if (start < 0) return ''
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end).join('\n').trim()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = new URL('../', import.meta.url)
  const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  const notes = releaseNotes(readFileSync(new URL('CHANGELOG.md', root), 'utf8'), version)
  if (!notes) {
    console.error(`CHANGELOG.md 里没有 v${version} 这一段，先补上再发版`)
    process.exit(1)
  }
  const out = process.argv[2]
  if (out) writeFileSync(out, notes + '\n')
  else console.log(notes)
}
