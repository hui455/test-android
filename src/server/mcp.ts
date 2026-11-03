import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { shotFile } from '../shared/annotate'
import { bugLine, bugStatusInRound, marksBefore, feedbackText, projectStatus, roundReport, searchProject, STATUS_LABEL, summarize } from '../shared/logic'
import { MODULES, type Bug, type Design, type DesignBox, type Project, type SelfTestPage, type SelfTestStatus } from '../shared/types'
import { exportBaseName, exportZip } from './exporter'
import { fetchImage } from './image'
import type { SelfTestStore } from './selftest'
import { StoreError, type ProjectStore } from './store'

/** AI agent 记的反馈，记录人写这个 */
export const AGENT = 'AI agent'

export interface McpContext {
  store: ProjectStore
  /** 用自测令牌接入时才有，开发自测的工具只在这时出现 */
  selftest: SelfTestStore | null
  exportDir: string
  version: string
  readOnly: () => boolean
  webUrl: () => string
  /** 下载链接要带的口令，不需要口令时为 null */
  token: () => string | null
  activity: (msg: string, devOnly?: boolean) => void
}

type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }

const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] })
const fail = (err: unknown): ToolResult => ({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true })

const boxShape = {
  x: z.number().optional().describe('画板在 Figma 页面上的 x'),
  y: z.number().optional().describe('画板在 Figma 页面上的 y'),
  width: z.number().optional().describe('画板在 Figma 里的宽'),
  height: z.number().optional().describe('画板在 Figma 里的高')
}
const toBox = (d: { x?: number; y?: number; width?: number; height?: number }): DesignBox | undefined =>
  d.x != null && d.y != null && d.width && d.height && d.width > 0 && d.height > 0 ? { x: d.x, y: d.y, w: d.width, h: d.height } : undefined
const designView = (d: Design) => ({ id: d.id, page: d.page, name: d.name, module: d.module, width: d.width, height: d.height, figmaUrl: d.figmaUrl, box: d.box ?? null, uploadedBy: d.uploadedBy, updatedAt: d.updatedAt })

const imageMime = (file: string) => (file.endsWith('.jpg') ? 'image/jpeg' : 'image/png')

const SELF_LABEL: Record<SelfTestStatus, string> = { todo: '待验收', issue: '有问题，等你修改', pass: '已通过' }

/** 开发自测的一个页面给 AI 看的样子：评论点编号和截图上画的一致 */
export const selfPageView = (pg: SelfTestPage, p: Project) => {
  const d = pg.design && p.designs?.find((x) => x.id === pg.design!.id)
  const last = pg.shots[pg.shots.length - 1]
  return {
    id: pg.id,
    name: pg.name,
    module: pg.module,
    status: pg.status,
    statusLabel: SELF_LABEL[pg.status],
    version: pg.shots.length,
    uploadedAt: last?.at ?? '',
    design: d ? { ...designView(d), similarity: pg.design!.score } : null,
    thread: pg.thread.map((m) => {
      const base = m.who === 'me' ? marksBefore(pg, m).length : 0
      return {
        from: m.who === 'me' ? `验收人 ${m.by}` : `AI ${m.by}`,
        onVersion: m.ver,
        text: m.text,
        ...(m.marks?.length ? { marks: m.marks.map((k, i) => ({ no: base + i + 1, kind: k.kind === 'pin' ? '评论点' : k.kind === 'rect' ? '框' : k.kind, note: k.note })) } : {}),
        at: m.at
      }
    })
  }
}

export const bugView = (b: Bug, r: number, p?: Project) => ({
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
  screenshots: b.shots.map((s) => ({
    file: shotFile(s),
    original: s.file,
    /** true 表示对标应用（竞品）的截图，不是自家 App */
    reference: !!s.ref,
    ...(s.ref ? { device: s.device ?? null } : {}),
    marks: (s.marks ?? []).map((m, i) => ({ no: i + 1, kind: m.kind, note: m.note }))
  })),
  device: b.device,
  reporter: b.reporter ?? '',
  aiFix: b.aiFix ?? null,
  design: (() => {
    const d = b.design && p?.designs?.find((x) => x.id === b.design!.id)
    return d ? { ...designView(d), similarity: b.design!.score } : null
  })(),
  createdAt: b.createdAt
})

/** 每个 MCP 请求新建一个（无状态模式） */
export function buildMcp(ctx: McpContext): McpServer {
  const resolve = (ref: string): Project => {
    const byId = ctx.store.list().find((p) => p.id === ref)
    const p = byId ?? ctx.store.findByName(ref.trim())
    if (!p) throw new StoreError(`找不到项目：${ref}（可以传项目 id 或完整项目名）`)
    return p
  }

  const findBug = (p: Project, ref: string | number): Bug => {
    const b = p.bugs.find((x) => x.id === String(ref) || x.seq === Number(ref))
    if (!b) throw new StoreError(`找不到反馈：${ref}`)
    return b
  }

  const guardWrite = (action: string, devOnly = false) => {
    if (ctx.readOnly()) throw new StoreError('BugShot 服务端设置为只读，AI agent 不能修改数据')
    ctx.activity(action, devOnly)
  }

    const mcp = new McpServer({ name: 'bugshot', version: ctx.version })
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
          ctx.store
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
        guardWrite(`创建项目“${name}”`)
        return ok(summarize(await ctx.store.createProject({ name, developer, type, createdBy: 'agent' })))
      })
    )

    mcp.registerTool(
      'get_project',
      { description: '读取项目信息和每一轮的统计（复测已修复 / 仍存在 / 待复测 / 新增）。', inputSchema: { project } },
      wrap(async (a) => {
        const p = resolve(a.project)
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
        const p = resolve(a.project)
        const r = a.round ?? p.rounds.length
        if (!p.rounds[r - 1]) throw new StoreError(`没有第${r}轮`)
        const rep = roundReport(p, r)
        let list = a.all ? p.bugs : [...rep.carried, ...rep.fresh]
        if (a.module) list = list.filter((b) => b.module === a.module)
        if (a.keyword) list = list.filter((b) => `${b.page} ${b.text}`.includes(a.keyword!))
        return ok({ project: p.name, round: r, bugs: list.map((b) => bugView(b, r, p)) })
      })
    )

    mcp.registerTool(
      'search_bugs',
      { description: '按关键字跨项目搜索反馈（页面和问题描述）。', inputSchema: { keyword: z.string() } },
      wrap(async ({ keyword }) =>
        ok(
          ctx.store.list().flatMap((p) =>
            p.bugs.filter((b) => `${b.module} ${b.page} ${b.text}`.includes(keyword)).map((b) => ({ project: p.name, projectId: p.id, ...bugView(b, p.rounds.length, p) }))
          )
        )
      )
    )

    mcp.registerTool(
      'get_bug',
      {
        description:
          '读取一条反馈，默认附带截图图片，可直接查看画面。截图上有测试人员的圈画时，返回的是画好编号标注的图，各编号的评论在 screenshots[].marks 里。图片按 screenshots 的顺序返回，reference=true 的是测试人员用另一台手机截的对标应用（竞品）画面，用来参考，不是自家 App 的问题截图。关联了设计稿时，最后一张图是对应的设计稿画板（design 字段是画板信息），修 UI 问题时以设计稿为准。修完后调用 mark_ai_fixed 标记这条。',
        inputSchema: { project, bug: z.union([z.string(), z.number()]).describe('反馈 id 或编号 seq'), include_screenshots: z.boolean().optional() }
      },
      wrap(async (a) => {
        const p = resolve(a.project)
        const b = findBug(p, a.bug)
        const result = ok(bugView(b, p.rounds.length, p))
        if (a.include_screenshots !== false) {
          for (const s of b.shots) {
            const png = await ctx.store.readShot(p.id, shotFile(s))
            result.content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
          }
          const d = b.design && p.designs?.find((x) => x.id === b.design!.id)
          if (d) result.content.push({ type: 'image', data: (await ctx.store.readDesign(p.id, d.file)).toString('base64'), mimeType: imageMime(d.file) })
        }
        return result
      })
    )

    // 反馈的增删改、复测结果和项目状态（开始 / 结束一轮）要由测试人员负责，不开放给 AI agent
    mcp.registerTool(
      'ai_feedback',
      {
        description:
          '处理完一条反馈后调用，告诉测试人员结果。status：fixed 已修复（改了代码）、confirm 待确认修复（改了但不确定，或需要真机 / 后台数据确认）、unclear 无法判断（看不出是不是问题）、notfound 查不到问题（代码里找不到对应页面或逻辑）。note 必填：fixed 写改了什么、哪些文件；其他写清楚原因、查了哪里、需要测试补充或确认什么。再写一次会替换上一条。只是提示，复测结果（已修复 / 仍存在）和反馈内容由测试人员负责，AI 不能改。',
        inputSchema: {
          project,
          bug: z.union([z.string(), z.number()]).describe('反馈 id 或编号 seq'),
          status: z.enum(['fixed', 'confirm', 'unclear', 'notfound']),
          note: z.string().min(1).describe('改了什么，或者为什么无法判断 / 查不到、需要确认什么')
        }
      },
      wrap(async (a) => {
        const p = resolve(a.project)
        const b = findBug(p, a.bug)
        guardWrite(`给“${p.name}”#${b.seq} 写 AI 反馈`)
        return ok(bugView(await ctx.store.markAiFixed(p.id, b.id, a.note, AGENT, a.status), p.rounds.length, p))
      })
    )

    mcp.registerTool(
      'mark_ai_fixed',
      {
        description:
          '等同 ai_feedback 的 status=fixed（保留给旧的用法）。你改完代码修复了一条反馈后调用：在这条反馈上标“AI 已修复”，summary 写清楚改了什么、改了哪些文件。只是提示测试人员去复测，复测结果（已修复 / 仍存在）由测试人员确认，AI 不能改。',
        inputSchema: { project, bug: z.union([z.string(), z.number()]).describe('反馈 id 或编号 seq'), summary: z.string().min(1).describe('改了什么、改了哪些文件') }
      },
      wrap(async (a) => {
        const p = resolve(a.project)
        const b = findBug(p, a.bug)
        guardWrite(`标记“${p.name}”#${b.seq} AI 已修复`)
        return ok(bugView(await ctx.store.markAiFixed(p.id, b.id, a.summary, AGENT), p.rounds.length, p))
      })
    )

    mcp.registerTool(
      'get_feedback_text',
      { description: '取得与“复制文本”相同的纯文本反馈（按 tab / 广告分组编号）。', inputSchema: { project, round: z.number().int().positive().optional() } },
      wrap(async (a) => {
        const p = resolve(a.project)
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
        const p = resolve(a.project)
        const scope = a.all ? ('all' as const) : { round: a.round ?? p.rounds.length }
        const file = `${exportBaseName(p, scope)}.zip`
        const r = await exportZip(ctx.store, p.id, scope, join(ctx.exportDir, file))
        const token = ctx.token()
        return ok({ ...r, url: `${ctx.webUrl()}/exports/${encodeURIComponent(file)}${token ? `?token=${encodeURIComponent(token)}` : ''}` })
      })
    )

    const designRef = (p: Project, ref: string): Design => {
      const list = p.designs ?? []
      const d = list.find((x) => x.id === ref) ?? list.find((x) => x.name === ref.trim()) ?? list.find((x) => `${x.page}/${x.name}` === ref.trim())
      if (!d) throw new StoreError(`找不到设计稿：${ref}（可以传 id、画板名，或“页面名/画板名”）`)
      return d
    }

    mcp.registerTool(
      'upload_designs',
      {
        description: [
          '把设计稿画板上传到项目，测试人员截图记 bug 时会自动匹配最像的画板，并把画板名填进“页面”。',
          '用法：先用 Figma MCP 列出文件的页面和每个页面下的顶层画板（get_metadata），对每个画板调用 get_screenshot，把返回的图片链接填进 image_url（BugShot 服务端会自己下载），一次最多 40 个。',
          'page 用 Figma 的页面名，name 用画板名，都照 Figma 原样填。同一页面下同名的画板再次上传会更新图片，适合设计稿改版后重新同步。',
          '只传手机界面的整屏画板，组件、切图、说明画板不要传。module 不填时按页面名推断（页面名里有 tab1/tab2/广告 等）。',
          'x/y/width/height 填 get_metadata 里这个画板的位置和大小（Figma 坐标），设计稿画布会照 Figma 里的排版摆放；不填就按顺序排成网格。'
        ].join(''),
        inputSchema: {
          project,
          figma_file: z.string().optional().describe('Figma 文件名，显示在设计稿页顶部'),
          figma_url: z.string().optional().describe('Figma 文件链接'),
          designs: z
            .array(
              z.object({
                page: z.string().describe('Figma 页面名，如 "tab1 首页"'),
                name: z.string().describe('画板名，如 "首页-审核状态"'),
                image_url: z.string().optional().describe('画板图片的下载地址（PNG/JPG），如 Figma get_screenshot 返回的链接'),
                image_base64: z.string().optional().describe('没有 image_url 时直接传图片的 base64'),
                module: z.enum(MODULES).optional(),
                figma_url: z.string().optional().describe('这个画板在 Figma 里的链接（带 node-id）'),
                ...boxShape
              })
            )
            .min(1)
            .max(40)
        }
      },
      wrap(async (a) => {
        const p = resolve(a.project)
        guardWrite(`给“${p.name}”上传 ${a.designs.length} 张设计稿`)
        if (a.figma_file !== undefined || a.figma_url !== undefined) await ctx.store.setFigma(p.id, { name: a.figma_file ?? p.figma?.name ?? '', url: a.figma_url ?? p.figma?.url ?? '' })
        const results: { page: string; name: string; ok: boolean; id?: string; module?: string; error?: string }[] = []
        // 并发下载，按顺序写入
        const images = await Promise.all(
          a.designs.map(async (d) => {
            try {
              if (d.image_url) return await fetchImage(d.image_url)
              if (d.image_base64) return Buffer.from(d.image_base64.replace(/^data:[^,]+,/, ''), 'base64')
              throw new StoreError('缺少 image_url 或 image_base64')
            } catch (err) {
              return err as Error
            }
          })
        )
        for (const [i, d] of a.designs.entries()) {
          const img = images[i]
          try {
            if (img instanceof Error) throw img
            const nd = await ctx.store.upsertDesign(p.id, { page: d.page, name: d.name, image: img, module: d.module, figmaUrl: d.figma_url, box: toBox(d) }, AGENT)
            results.push({ page: nd.page, name: nd.name, ok: true, id: nd.id, module: nd.module })
          } catch (err) {
            results.push({ page: d.page, name: d.name, ok: false, error: (err as Error).message })
          }
        }
        const failed = results.filter((r) => !r.ok).length
        return ok({ project: p.name, uploaded: results.length - failed, failed, total: ctx.store.get(p.id).designs?.length ?? 0, results })
      })
    )

    mcp.registerTool(
      'set_design_positions',
      {
        description:
          '只更新已上传画板在 Figma 里的位置和大小，不重新传图。设计稿画布按这个位置还原 Figma 里的排版。用 Figma MCP 的 get_metadata 拿到每个顶层画板的 x/y/width/height 后一次传进来，最多 200 个。',
        inputSchema: {
          project,
          designs: z
            .array(z.object({ design: z.string().describe('设计稿 id、画板名，或“页面名/画板名”'), x: z.number(), y: z.number(), width: z.number(), height: z.number() }))
            .min(1)
            .max(200)
        }
      },
      wrap(async (a) => {
        const p = resolve(a.project)
        guardWrite(`更新“${p.name}”${a.designs.length} 张设计稿的位置`)
        const results: { design: string; ok: boolean; error?: string }[] = []
        const items: { id: string; box: DesignBox }[] = []
        for (const d of a.designs) {
          try {
            const box = toBox(d)
            if (!box) throw new StoreError('宽高要大于 0')
            items.push({ id: designRef(p, d.design).id, box })
            results.push({ design: d.design, ok: true })
          } catch (err) {
            results.push({ design: d.design, ok: false, error: (err as Error).message })
          }
        }
        const updated = items.length ? await ctx.store.setDesignBoxes(p.id, items) : 0
        return ok({ project: p.name, updated, failed: results.length - updated, results: results.filter((r) => !r.ok) })
      })
    )

    mcp.registerTool(
      'list_designs',
      { description: '列出项目里的设计稿画板，以及各自关联了几条反馈。', inputSchema: { project } },
      wrap(async (a) => {
        const p = resolve(a.project)
        return ok({
          project: p.name,
          figma: p.figma ?? null,
          designs: (p.designs ?? []).map((d) => ({ ...designView(d), bugs: p.bugs.filter((b) => b.design?.id === d.id).map((b) => b.seq) }))
        })
      })
    )

    mcp.registerTool(
      'get_design',
      { description: '读取一个设计稿画板和它的图片。', inputSchema: { project, design: z.string().describe('设计稿 id、画板名，或“页面名/画板名”') } },
      wrap(async (a) => {
        const p = resolve(a.project)
        const d = designRef(p, a.design)
        const result = ok(designView(d))
        result.content.push({ type: 'image', data: (await ctx.store.readDesign(p.id, d.file)).toString('base64'), mimeType: imageMime(d.file) })
        return result
      })
    )

    mcp.registerTool(
      'delete_design',
      { description: '删除一个设计稿画板，已关联的反馈会取消关联。', inputSchema: { project, design: z.string().describe('设计稿 id、画板名，或“页面名/画板名”') } },
      wrap(async (a) => {
        const p = resolve(a.project)
        const d = designRef(p, a.design)
        guardWrite(`删除“${p.name}”的设计稿“${d.name}”`)
        await ctx.store.deleteDesign(p.id, d.id)
        return ok({ deleted: d.name, remaining: ctx.store.get(p.id).designs?.length ?? 0 })
      })
    )

    if (ctx.selftest) registerSelfTest(mcp, ctx, ctx.selftest, { project, wrap, resolve, guardWrite: (a: string) => guardWrite(a, true) })

    return mcp
}

/** 开发自测：AI 能上传截图、读评论、回复；“通过”只能由验收人在客户端里点 */
function registerSelfTest(
  mcp: McpServer,
  ctx: McpContext,
  st: SelfTestStore,
  h: {
    project: z.ZodString
    wrap: <A>(fn: (a: A) => Promise<ToolResult> | ToolResult) => (a: A) => Promise<ToolResult>
    resolve: (ref: string) => Project
    guardWrite: (action: string) => void
  }
) {
  const { project, wrap, resolve } = h
  const pageRef = z.string().describe('页面名或页面 id')
  const curl = `adb exec-out screencap -p | curl -sS -X POST --data-binary @- -H "Authorization: Bearer <接入 MCP 用的自测令牌>" "${ctx.webUrl()}/api/selftest?project=<项目名>&name=<页面名>&note=<说明>"`

  mcp.registerTool(
    'selftest_upload',
    {
      description: [
        '开发自测：把 App 页面的实时截图上传到项目的“开发自测”，给验收人逐页对照设计稿检查。和正式测试的反馈完全分开。',
        'name 用页面名，最好和设计稿画板名一致（如“首页-审核状态”，可以先用 list_designs 看有哪些画板）；同一个 name 再传一次就是这页的新版本，页面回到“待验收”。',
        'note 写一句说明，改评论后重新上传时写清楚改了什么、哪些文件。设计稿会自动匹配，也可以用 design 指定画板名。',
        `截图在手机或模拟器上，用命令行直接传更省事（URL 里的中文要编码）：${curl}`,
        '也可以在这里用 image_base64 传，一次最多 20 页。'
      ].join(''),
      inputSchema: {
        project,
        pages: z
          .array(
            z.object({
              name: z.string(),
              image_base64: z.string().optional().describe('PNG/JPG 的 base64'),
              image_url: z.string().optional().describe('服务端能下载到的图片地址'),
              note: z.string().optional(),
              module: z.enum(MODULES).optional(),
              design: z.string().optional().describe('设计稿 id、画板名或“页面名/画板名”，不填自动匹配'),
              activity: z.string().optional().describe('前台 Activity，如 com.demo/.HomeActivity'),
              device: z.string().optional().describe('设备，如 Pixel 8 模拟器 · Android 14')
            })
          )
          .min(1)
          .max(20)
      }
    },
    wrap(async (a) => {
      const p = resolve(a.project)
      h.guardWrite(`给“${p.name}”的开发自测上传 ${a.pages.length} 页截图`)
      const results: { name: string; ok: boolean; version?: number; design?: string | null; error?: string }[] = []
      for (const pg of a.pages) {
        try {
          const image = pg.image_url ? await fetchImage(pg.image_url) : pg.image_base64 ? Buffer.from(pg.image_base64.replace(/^data:[^,]+,/, ''), 'base64') : null
          if (!image) throw new StoreError('缺少 image_base64 或 image_url')
          const np = await st.upload(p.id, { name: pg.name, image, note: pg.note, module: pg.module, design: pg.design, activity: pg.activity, device: pg.device }, AGENT)
          const d = np.design && ctx.store.get(p.id).designs?.find((x) => x.id === np.design!.id)
          results.push({ name: np.name, ok: true, version: np.shots.length, design: d ? d.name : null })
        } catch (err) {
          results.push({ name: pg.name, ok: false, error: (err as Error).message })
        }
      }
      return ok({ project: p.name, uploaded: results.filter((r) => r.ok).length, results })
    })
  )

  mcp.registerTool(
    'selftest_list',
    {
      description: '列出项目开发自测里的页面：状态（待验收 / 有问题 / 已通过）、第几版、对应的设计稿和评论。status=issue 只看验收人提了问题、等你修改的页面。',
      inputSchema: { project, status: z.enum(['todo', 'issue', 'pass']).optional() }
    },
    wrap(async (a) => {
      const p = resolve(a.project)
      const t = await st.get(p.id)
      const pages = t.pages.filter((x) => !a.status || x.status === a.status)
      return ok({
        project: p.name,
        counts: { total: t.pages.length, todo: t.pages.filter((x) => x.status === 'todo').length, issue: t.pages.filter((x) => x.status === 'issue').length, pass: t.pages.filter((x) => x.status === 'pass').length },
        pages: pages.map((x) => selfPageView(x, p)),
        next: '有问题的页面用 selftest_get 看截图上的评论点和设计稿，改完代码重新截这一页，用 selftest_upload 按同一个页面名上传，并在 note 里写改了什么。'
      })
    })
  )

  mcp.registerTool(
    'selftest_get',
    {
      description:
        '读取开发自测的一个页面：评论和最新一版截图。截图上有验收人的评论点时，返回的是画好编号的图，各编号的评论在 thread[].marks 里；关联了设计稿时，最后一张图是设计稿，以设计稿为准修改。',
      inputSchema: { project, page: pageRef, include_images: z.boolean().optional() }
    },
    wrap(async (a) => {
      const p = resolve(a.project)
      const pg = st.findPage(await st.get(p.id), a.page)
      const result = ok(selfPageView(pg, p))
      if (a.include_images !== false && pg.shots.length) {
        const ver = pg.shots.length
        const marked = [...pg.thread].reverse().find((m) => m.who === 'me' && m.ver === ver && m.marked)?.marked
        const file = marked ?? pg.shots[ver - 1].file
        result.content.push({ type: 'image', data: (await st.readFile(p.id, file)).toString('base64'), mimeType: imageMime(file) })
        const d = pg.design && p.designs?.find((x) => x.id === pg.design!.id)
        if (d) result.content.push({ type: 'image', data: (await ctx.store.readDesign(p.id, d.file)).toString('base64'), mimeType: imageMime(d.file) })
      }
      return result
    })
  )

  mcp.registerTool(
    'selftest_reply',
    {
      description: '在开发自测的页面下回复验收人，比如看不懂评论先问清楚、或者说明为什么没按评论改。不传新截图，页面状态不变。改完代码请直接用 selftest_upload 传新截图并写 note。',
      inputSchema: { project, page: pageRef, text: z.string().min(1) }
    },
    wrap(async (a) => {
      const p = resolve(a.project)
      h.guardWrite(`在“${p.name}”的开发自测“${a.page}”下回复`)
      return ok(selfPageView(await st.reply(p.id, a.page, a.text, AGENT), p))
    })
  )
}
