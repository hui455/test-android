import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { basename, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { shotFile } from '../shared/annotate'
import { bugLine, bugStatusInRound, feedbackText, latestRound, projectStatus, roundReport, searchProject, STATUS_LABEL, summarize } from '../shared/logic'
import { MODULES, type Bug, type LanSettings, type Project } from '../shared/types'
import { exportBaseName, exportZip } from './exporter'
import { StoreError, type ProjectStore } from './store'
import { webPage } from './webpage'

export function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')) return ni.address
    }
  }
  return '127.0.0.1'
}

export interface LanInfo {
  running: boolean
  address: string
  port: number
  webUrl: string
  mcpUrl: string
  error: string
  lastClient: string
}

type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }

const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] })
const fail = (err: unknown): ToolResult => ({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true })

const bugView = (b: Bug, r: number) => ({
  id: b.id,
  seq: b.seq,
  module: b.module,
  page: b.page,
  text: b.text,
  mode: b.mode,
  line: bugLine(b),
  foundInRound: b.round,
  statusInRound: bugStatusInRound(b, r),
  checks: b.checks,
  screenshots: b.shots.map((s) => ({ file: shotFile(s), original: s.file, marks: (s.marks ?? []).map((m, i) => ({ no: i + 1, kind: m.kind, note: m.note })) })),
  device: b.device,
  createdAt: b.createdAt
})

export class LanServer {
  private server: Server | null = null
  info: LanInfo = { running: false, address: '', port: 0, webUrl: '', mcpUrl: '', error: '', lastClient: '' }

  constructor(
    private store: ProjectStore,
    private exportDir: string,
    private onAgentActivity: (msg: string) => void
  ) {}

  private settings!: LanSettings

  async apply(settings: LanSettings): Promise<LanInfo> {
    this.settings = settings
    await this.stop()
    if (!settings.enabled) return this.info
    await mkdir(this.exportDir, { recursive: true })
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error(err)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('服务器错误')
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(settings.port, '0.0.0.0', () => resolve())
      })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      this.info = { ...this.info, running: false, error: e.code === 'EADDRINUSE' ? `端口 ${settings.port} 已被占用，请换一个端口` : e.message }
      return this.info
    }
    this.server = server
    const address = lanAddress()
    const base = `http://${address}:${settings.port}`
    this.info = { running: true, address, port: settings.port, webUrl: base, mcpUrl: `${base}/mcp`, error: '', lastClient: this.info.lastClient }
    return this.info
  }

  async stop() {
    const s = this.server
    this.server = null
    this.info = { ...this.info, running: false }
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    if (!this.settings.requireToken) return true
    const t = this.settings.token
    const header = req.headers.authorization ?? ''
    const cookie = /(?:^|;\s*)bugshot_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    return header === `Bearer ${t}` || url.searchParams.get('token') === t || cookie === t
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local')
    if (!this.authorized(req, url)) {
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        res.end(webPage({ needToken: true }))
      } else {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: '需要访问口令' }))
      }
      return
    }
    const json = (code: number, data: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(data))
    }

    if (url.pathname === '/mcp') return this.handleMcp(req, res)

    if (req.method !== 'GET') return json(405, { error: '网页只读' })

    if (url.pathname === '/') {
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }
      if (url.searchParams.get('token')) headers['set-cookie'] = `bugshot_token=${url.searchParams.get('token')}; Path=/; HttpOnly; SameSite=Lax`
      res.writeHead(200, headers)
      return res.end(webPage({ needToken: false }))
    }
    if (url.pathname === '/api/projects') {
      return json(200, this.store.list().map(summarize))
    }
    let m = /^\/api\/projects\/([^/]+)$/.exec(url.pathname)
    if (m) {
      try {
        return json(200, this.store.get(decodeURIComponent(m[1])))
      } catch {
        return json(404, { error: '项目不存在' })
      }
    }
    m = /^\/shots\/([^/]+)\/([^/]+\.png)$/.exec(url.pathname)
    if (m) {
      try {
        const png = await this.store.readShot(decodeURIComponent(m[1]), decodeURIComponent(m[2]))
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=31536000, immutable' })
        return res.end(png)
      } catch {
        return json(404, { error: '截图不存在' })
      }
    }
    m = /^\/exports\/([^/]+\.zip)$/.exec(url.pathname)
    if (m) {
      const file = join(this.exportDir, basename(decodeURIComponent(m[1])))
      if (!existsSync(file)) return json(404, { error: '文件不存在' })
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(file))}` })
      return createReadStream(file).pipe(res)
    }
    json(404, { error: '未找到' })
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse) {
    this.info.lastClient = `${req.socket.remoteAddress ?? ''} ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
    let body: unknown
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }))
      }
    }
    // 无状态模式：每个请求一个独立的 server + transport
    const server = this.buildMcp()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  private resolve(ref: string): Project {
    const byId = this.store.list().find((p) => p.id === ref)
    const p = byId ?? this.store.findByName(ref.trim())
    if (!p) throw new StoreError(`找不到项目：${ref}（可以传项目 id 或完整项目名）`)
    return p
  }

  private findBug(p: Project, ref: string | number): Bug {
    const b = p.bugs.find((x) => x.id === String(ref) || x.seq === Number(ref))
    if (!b) throw new StoreError(`找不到反馈：${ref}`)
    return b
  }

  private guardWrite(action: string) {
    if (this.settings.readOnly) throw new StoreError('BugShot 设置为只读，AI agent 不能修改数据')
    this.onAgentActivity(action)
  }

  private buildMcp(): McpServer {
    const mcp = new McpServer({ name: 'bugshot', version: '0.1.0' })
    const project = z.string().describe('项目 id 或完整项目名，如 "16-违章查询"')
    const wrap =
      <A>(fn: (a: A) => Promise<ToolResult> | ToolResult) =>
      async (a: A): Promise<ToolResult> => {
        try {
          return await fn(a)
        } catch (err) {
          return fail(err)
        }
      }

    mcp.registerTool(
      'list_projects',
      {
        description: '列出测试项目：轮次、状态（测试中 / 待复测 / 已通过）、未修复数。可按关键字（项目名或反馈内容）和状态筛选。',
        inputSchema: { keyword: z.string().optional(), status: z.enum(['testing', 'waiting', 'passed']).optional() }
      },
      wrap(async ({ keyword, status }) =>
        ok(
          this.store
            .list()
            .filter((p) => (!status || projectStatus(p) === status) && searchProject(p, keyword ?? '').match)
            .map((p) => ({ ...summarize(p), statusLabel: STATUS_LABEL[projectStatus(p)], keywordHits: keyword ? searchProject(p, keyword).hits : undefined }))
        )
      )
    )

    mcp.registerTool(
      'create_project',
      {
        description: '新建测试项目，自动开始第 1 轮测试。项目名沿用“编号-名称”，如 "7-二维码"。',
        inputSchema: { name: z.string(), developer: z.string().optional(), type: z.string().optional().describe('如 马甲、马甲-换皮') }
      },
      wrap(async ({ name, developer, type }) => {
        this.guardWrite(`创建项目“${name}”`)
        return ok(summarize(await this.store.createProject({ name, developer, type, createdBy: 'agent' })))
      })
    )

    mcp.registerTool(
      'get_project',
      { description: '读取项目信息和每一轮的统计（复测已修复 / 仍存在 / 待复测 / 新增）。', inputSchema: { project } },
      wrap(async (a) => {
        const p = this.resolve(a.project)
        return ok({
          ...summarize(p),
          rounds: p.rounds.map((r) => {
            const rep = roundReport(p, r.no)
            return { ...r, retest: rep.carried.length, fixed: rep.fixed.length, still: rep.still.length, pending: rep.pending.length, new: rep.fresh.length }
          })
        })
      })
    )

    mcp.registerTool(
      'list_bugs',
      {
        description: '读取项目的反馈。round 不填为最新一轮：返回该轮复测清单 + 新增问题；all=true 返回全部反馈。',
        inputSchema: { project, round: z.number().int().positive().optional(), all: z.boolean().optional(), module: z.enum(MODULES).optional(), keyword: z.string().optional() }
      },
      wrap(async (a) => {
        const p = this.resolve(a.project)
        const r = a.round ?? p.rounds.length
        if (!p.rounds[r - 1]) throw new StoreError(`没有第${r}轮`)
        const rep = roundReport(p, r)
        let list = a.all ? p.bugs : [...rep.carried, ...rep.fresh]
        if (a.module) list = list.filter((b) => b.module === a.module)
        if (a.keyword) list = list.filter((b) => `${b.page} ${b.text}`.includes(a.keyword!))
        return ok({ project: p.name, round: r, bugs: list.map((b) => bugView(b, r)) })
      })
    )

    mcp.registerTool(
      'search_bugs',
      { description: '按关键字跨项目搜索反馈（页面和问题描述）。', inputSchema: { keyword: z.string() } },
      wrap(async ({ keyword }) =>
        ok(
          this.store.list().flatMap((p) =>
            p.bugs.filter((b) => `${b.module} ${b.page} ${b.text}`.includes(keyword)).map((b) => ({ project: p.name, projectId: p.id, ...bugView(b, p.rounds.length) }))
          )
        )
      )
    )

    mcp.registerTool(
      'get_bug',
      {
        description: '读取一条反馈，默认附带截图图片，可直接查看画面。截图上有测试人员的圈画时，返回的是画好编号标注的图，各编号的评论在 screenshots[].marks 里。',
        inputSchema: { project, bug: z.union([z.string(), z.number()]).describe('反馈 id 或编号 seq'), include_screenshots: z.boolean().optional() }
      },
      wrap(async (a) => {
        const p = this.resolve(a.project)
        const b = this.findBug(p, a.bug)
        const result = ok(bugView(b, p.rounds.length))
        if (a.include_screenshots !== false) {
          for (const s of b.shots) {
            const png = await this.store.readShot(p.id, shotFile(s))
            result.content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
          }
        }
        return result
      })
    )

    mcp.registerTool(
      'add_bug',
      {
        description: '给项目当前轮追加一条文字反馈（不带截图）。',
        inputSchema: {
          project,
          module: z.enum(MODULES),
          page: z.string().optional(),
          text: z.string(),
          mode: z.enum(['', 'audit', 'online']).optional().describe('audit=审核状态，online=上线模式')
        }
      },
      wrap(async (a) => {
        const p = this.resolve(a.project)
        this.guardWrite(`给“${p.name}”添加反馈`)
        const b = await this.store.addBug(p.id, { module: a.module, page: a.page ?? '', text: a.text, mode: a.mode ?? '' })
        return ok(bugView(b, p.rounds.length))
      })
    )

    mcp.registerTool(
      'update_bug',
      {
        description: '修改一条反馈的模块、页面、内容或环境。',
        inputSchema: {
          project,
          bug: z.union([z.string(), z.number()]),
          module: z.enum(MODULES).optional(),
          page: z.string().optional(),
          text: z.string().optional(),
          mode: z.enum(['', 'audit', 'online']).optional()
        }
      },
      wrap(async (a) => {
        const p = this.resolve(a.project)
        const b = this.findBug(p, a.bug)
        this.guardWrite(`修改“${p.name}”的反馈 #${b.seq}`)
        const nb = await this.store.updateBug(p.id, b.id, { module: a.module, page: a.page, text: a.text, mode: a.mode })
        return ok(bugView(nb, p.rounds.length))
      })
    )

    mcp.registerTool(
      'set_retest_result',
      {
        description: '在当前复测轮标记上轮遗留问题：fixed=已修复，still=仍存在，null=清除。',
        inputSchema: { project, bug: z.union([z.string(), z.number()]), result: z.enum(['fixed', 'still']).nullable() }
      },
      wrap(async (a) => {
        const p = this.resolve(a.project)
        const b = this.findBug(p, a.bug)
        this.guardWrite(`复测“${p.name}”#${b.seq}`)
        return ok(bugView(await this.store.setCheck(p.id, b.id, a.result), p.rounds.length))
      })
    )

    mcp.registerTool(
      'start_round',
      { description: '开始新一轮复测（上一轮必须已结束），返回带出的未修复问题。', inputSchema: { project } },
      wrap(async (a) => {
        const p = this.resolve(a.project)
        this.guardWrite(`“${p.name}”开始第${p.rounds.length + 1}轮复测`)
        await this.store.startRound(p.id)
        const r = p.rounds.length
        return ok({ round: r, retest: roundReport(p, r).carried.map((b) => bugView(b, r)) })
      })
    )

    mcp.registerTool(
      'end_round',
      { description: '结束当前轮测试并记录结果。', inputSchema: { project, result: z.enum(['pass', 'fail']) } },
      wrap(async (a) => {
        const p = this.resolve(a.project)
        this.guardWrite(`结束“${p.name}”第${p.rounds.length}轮测试`)
        await this.store.endRound(p.id, a.result)
        return ok({ round: latestRound(p), status: STATUS_LABEL[projectStatus(p)] })
      })
    )

    mcp.registerTool(
      'get_feedback_text',
      { description: '取得与“复制文本”相同的纯文本反馈（按 tab / 广告分组编号）。', inputSchema: { project, round: z.number().int().positive().optional() } },
      wrap(async (a) => {
        const p = this.resolve(a.project)
        return ok(feedbackText(p, a.round ?? p.rounds.length))
      })
    )

    mcp.registerTool(
      'export_project_zip',
      {
        description: '导出项目 zip（反馈原文、report.html、bugs.csv、bugs.json、截图），返回局域网下载地址。round 不填为最新一轮，all=true 导出全部轮次。',
        inputSchema: { project, round: z.number().int().positive().optional(), all: z.boolean().optional() }
      },
      wrap(async (a) => {
        const p = this.resolve(a.project)
        const scope = a.all ? ('all' as const) : { round: a.round ?? p.rounds.length }
        const file = `${exportBaseName(p, scope)}.zip`
        const r = await exportZip(this.store, p.id, scope, join(this.exportDir, file))
        const token = this.settings.requireToken ? `?token=${encodeURIComponent(this.settings.token)}` : ''
        return ok({ ...r, url: `${this.info.webUrl}/exports/${encodeURIComponent(file)}${token}` })
      })
    )

    return mcp
  }
}
