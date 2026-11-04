// 打包不带窗口的服务端（Docker / NAS / Linux 用）：out/server/bugshot-server.cjs，单个文件，不需要 node_modules
// 版本号用 package.json 的 serverVersion（服务端和客户端分开发版）
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const { serverVersion: version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: ['src/server/cli.ts'],
  outfile: 'out/server/bugshot-server.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  define: { __VERSION__: JSON.stringify(version) },
  logLevel: 'info'
})
