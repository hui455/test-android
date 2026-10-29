import { resolve } from 'node:path'
import { startServer } from './run'

/**
 * 不带窗口的服务端，给 Docker / NAS / Linux 用：
 *   node bugshot-server.cjs [--data ./data] [--port 17800]
 * 也可以用环境变量 BUGSHOT_DATA、BUGSHOT_PORT、BUGSHOT_TOKEN、BUGSHOT_NAME。
 */
declare const __VERSION__: string

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const env = process.env
  const port = Number(arg('port') ?? env.BUGSHOT_PORT ?? 0)
  const overrides = {
    ...(port ? { port } : {}),
    ...(env.BUGSHOT_TOKEN ? { token: env.BUGSHOT_TOKEN } : {}),
    ...(env.BUGSHOT_NAME ? { name: env.BUGSHOT_NAME } : {})
  }
  const srv = await startServer({ dataRoot: resolve(arg('data') ?? env.BUGSHOT_DATA ?? 'data'), version: __VERSION__, overrides })
  const s = srv.http.status
  if (!s.running) {
    console.error(s.error)
    process.exit(1)
  }
  const c = srv.config.value
  console.log(`BugShot 服务端 v${__VERSION__}「${c.name}」已启动`)
  console.log(`  数据目录  ${srv.dataRoot}`)
  console.log(`  网页      ${s.webUrl}/?token=${c.token}`)
  console.log(`  MCP       ${s.mcpUrl}`)
  console.log(`  团队令牌  ${c.requireToken ? c.token : '（不需要）'}`)
  const quit = () => void srv.stop().then(() => process.exit(0))
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
