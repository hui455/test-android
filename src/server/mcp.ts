import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { shotFile } from '../shared/annotate'
import { bugLine, bugStatusInRound, feedbackText, projectStatus, roundReport, searchProject, STATUS_LABEL, summarize } from '../shared/logic'
import { MODULES, type Bug, type Design, type Project } from '../shared/types'
import { exportBaseName, exportZip } from './exporter'
import { fetchImage } from './image'
import { StoreError, type ProjectStore } from './store'

/** AI agent 记的反馈，记录人写这个 */
export const AGENT = 'AI agent'

export interface McpContext {
  store: ProjectStore
  exportDir: string
  version: string
  readOnly: () => boolean
  webUrl: () => string
  /** 下载链接要带的口令，不需要口令时为 null */
  token: () => string | null
  activity: (msg: string) => void
}

type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }

const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] })
const fail = (err: unknown): ToolResult => ({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true })

const designView = (d: Design) => ({ id: d.id, page: d.page, name: d.name, module: d.module, width: d.width, height: d.height, figmaUrl: d.figmaUrl, uploadedBy: d.uploadedBy, updatedAt: d.updatedAt })

const imageMime = (file: string) => (file.endsWith('.jpg') ? 'image/jpeg' : 'image/png')

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
  screenshots: b.shots.map((s) => ({ file: shotFile(s), original: s.file, marks: (s.marks ?? []).map((m, i) => ({ no: i + 1, kind: m.kind, note: m.note })) })),
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

  const guardWrite = (action: string) => {
    if (ctx.readOnly()) throw new StoreError('BugShot 服务端设置为只读，AI agent 不能修改数据')
    ctx.activity(action)
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
          '读取一条反馈，默认附带截图图片，可直接查看画面。截图上有测试人员的圈画时，返回的是画好编号标注的图，各编号的评论在 screenshots[].marks 里。关联了设计稿时，最后一张图是对应的设计稿画板（design 字段是画板信息），修 UI 问题时以设计稿为准。修完后调用 mark_ai_fixed 标记这条。',
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
      'mark_ai_fixed',
      {
        description:
          '你改完代码修复了一条反馈后调用：在这条反馈上标“AI 已修复”，summary 写清楚改了什么、改了哪些文件。只是提示测试人员去复测，复测结果（已修复 / 仍存在）由测试人员确认，AI 不能改。',
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
          '只传手机界面的整屏画板，组件、切图、说明画板不要传。module 不填时按页面名推断（页面名里有 tab1/tab2/广告 等）。'
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
                figma_url: z.string().optional().describe('这个画板在 Figma 里的链接（带 node-id）')
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
            const nd = await ctx.store.upsertDesign(p.id, { page: d.page, name: d.name, image: img, module: d.module, figmaUrl: d.figma_url }, AGENT)
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

    return mcp
}
