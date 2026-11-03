import { marksText } from './annotate'
import { MODULES, type AiFix, type AiStatus, type Bug, type Design, type Mark, type Module, type Project, type ProjectStatus, type ProjectSummary, type Round, type SelfTestMsg, type SelfTestPage } from './types'

export const latestRound = (p: Project): Round => p.rounds[p.rounds.length - 1]

/** 一条问题在第 r 轮（含）之前是否被标记为已修复 */
export const fixedBy = (b: Bug, r: number): boolean =>
  Object.entries(b.checks).some(([k, v]) => Number(k) <= r && v === 'fixed')

/** 第 r 轮需要复测的问题：之前轮次发现、且到上一轮为止还没修复 */
export const carried = (p: Project, r: number): Bug[] => p.bugs.filter((b) => b.round < r && !fixedBy(b, r - 1))

/** 第 r 轮新发现的问题 */
export const fresh = (p: Project, r: number): Bug[] => p.bugs.filter((b) => b.round === r)

export const remaining = (p: Project): number => p.bugs.filter((b) => !fixedBy(b, Infinity)).length

export interface RoundReport {
  carried: Bug[]
  fixed: Bug[]
  still: Bug[]
  pending: Bug[]
  fresh: Bug[]
  /** 本轮要反馈给开发的：仍存在 + 新增 */
  issues: Bug[]
}

export function roundReport(p: Project, r: number): RoundReport {
  const car = carried(p, r)
  const still = car.filter((b) => b.checks[r] === 'still')
  const fr = fresh(p, r)
  return {
    carried: car,
    fixed: car.filter((b) => b.checks[r] === 'fixed'),
    still,
    pending: car.filter((b) => !b.checks[r]),
    fresh: fr,
    issues: [...still, ...fr]
  }
}

export function projectStatus(p: Project): ProjectStatus {
  const last = latestRound(p)
  if (!last.end) return 'testing'
  return last.result === 'pass' ? 'passed' : 'waiting'
}

export const STATUS_LABEL: Record<ProjectStatus, string> = { testing: '测试中', waiting: '待复测', passed: '已通过' }

export function summarize(p: Project): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    developer: p.developer,
    type: p.type,
    createdBy: p.createdBy,
    round: p.rounds.length,
    status: projectStatus(p),
    remaining: remaining(p),
    bugCount: p.bugs.length
  }
}

export const groupByModule = (bugs: Bug[]): [Module, Bug[]][] =>
  MODULES.map((m) => [m, bugs.filter((b) => b.module === m)] as [Module, Bug[]]).filter(([, l]) => l.length > 0)

/** 反馈列表里从上到下的顺序：复测轮先列复测清单再列本轮新增，各自按模块分组。键盘、滚轮换条都按它走 */
export function feedOrder(p: Project, r: number): Bug[] {
  const rep = roundReport(p, r)
  const flat = (l: Bug[]) => groupByModule(l).flatMap(([, x]) => x)
  return r > 1 ? [...flat(rep.carried), ...flat(rep.fresh)] : flat(rep.fresh)
}

/**
 * 刚给 doneId 标了复测结果，接下来该看哪条：它后面第一条还没复测的，后面没有就从头找。
 * 标结果和刷新是异步的，所以 doneId 这条不管 checks 里有没有都算已复测。全部复测完返回 null。
 */
export function nextPending(p: Project, r: number, doneId: string): Bug | null {
  const list = feedOrder(p, r).filter((b) => b.round < r)
  const todo = (b: Bug) => b.id !== doneId && !b.checks[r]
  const i = list.findIndex((b) => b.id === doneId)
  return list.slice(i + 1).find(todo) ?? list.slice(0, Math.max(i, 0)).find(todo) ?? null
}

/** 一条反馈写成“页面-问题”，带审核 / 上线前缀 */
export function bugLine(b: Bug): string {
  const prefix = b.mode === 'audit' ? '审核状态下-' : b.mode === 'online' ? '上线模式-' : ''
  return prefix + (b.page ? `${b.page}-` : '') + b.text
}

const moduleHeader = (m: Module) => (m.startsWith('tab') ? `${m}:` : `${m}：`)

/** 与飞书“反馈原文”一致的纯文本，复测轮只列仍存在 + 新增 */
export function feedbackText(p: Project, r: number = p.rounds.length): string {
  const round = p.rounds[r - 1]
  const rep = roundReport(p, r)
  const result = round.end ? (round.result === 'pass' ? '测试通过' : '测试不通过') : '测试中'
  const out = [p.name, `开发人员：${p.developer}　类型：${p.type}　${r > 1 ? `第${r}轮复测　` : ''}测试结果：${result}`, '']
  for (const [m, list] of groupByModule(rep.issues)) {
    out.push(moduleHeader(m))
    list.forEach((b, i) => out.push(`${i + 1}.${bugLine(b)}${b.round < r ? '（复测仍存在）' : ''}`))
  }
  if (r > 1) out.push('', `上轮问题已修复 ${rep.fixed.length} 条`)
  return out.join('\n').trimEnd()
}

const csvCell = (v: string | number) => {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function bugStatusInRound(b: Bug, r: number): string {
  if (b.round === r) return '新增'
  const c = b.checks[r]
  return c === 'fixed' ? '已修复' : c === 'still' ? '仍存在' : '待复测'
}

/** 一条反馈所有截图上的评论，多张图之间用 / 分开 */
export const bugNotes = (b: Bug): string =>
  b.shots
    .map((s) => marksText(s.marks))
    .filter(Boolean)
    .join(' / ')

/** 带 BOM 的 CSV，Excel 打开不乱码 */
/** 反馈关联的设计稿画板，已被删掉时为 undefined */
export const bugDesign = (p: Project, b: Bug): Design | undefined => (b.design ? p.designs?.find((d) => d.id === b.design!.id) : undefined)

export const designLabel = (d: Design | undefined) => (d ? (d.page ? `${d.page} / ${d.name}` : d.name) : '')

export function bugsCsv(p: Project, bugs: Bug[], r: number, shotNames: Map<Bug, string[]>): string {
  const header = ['编号', '模块', '页面', '问题', '环境', '发现轮次', `第${r}轮状态`, '截图', '图注', '设计稿', '设备', '记录时间']
  const rows = bugs.map((b) => [
    b.seq,
    b.module,
    b.page,
    b.text,
    b.mode === 'audit' ? '审核状态' : b.mode === 'online' ? '上线模式' : '',
    b.round,
    bugStatusInRound(b, r),
    (shotNames.get(b) ?? []).join(' '),
    bugNotes(b),
    designLabel(bugDesign(p, b)),
    b.device ? `${deviceName(b.device)} Android ${b.device.androidVersion}` : '',
    b.createdAt
  ])
  return '﻿' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

/** 按项目名、开发、类型和反馈内容搜索，返回命中的反馈条数（项目信息命中时为 0 也算匹配） */
export function searchProject(p: Project, q: string): { match: boolean; hits: number } {
  const k = q.trim().toLowerCase()
  if (!k) return { match: true, hits: 0 }
  const hits = p.bugs.filter((b) => `${b.module} ${b.page} ${b.text}`.toLowerCase().includes(k)).length
  const meta = `${p.name} ${p.developer} ${p.type}`.toLowerCase().includes(k)
  return { match: meta || hits > 0, hits }
}

/** 默认常用短语，取自团队历史反馈里出现最多的说法 */
export const DEFAULT_PHRASES = {
  general: ['对照原型修改', '与UI不符', '点击无反应', '缺数据', '审核状态下去掉vip标识'],
  ad: ['缺插屏', '无插屏', '缺信息流', '信息流看不见']
}

export const phraseGroup = (m: Module): 'general' | 'ad' => (m === '广告' ? 'ad' : 'general')

/** 默认短语 + 自定义短语，按点击次数排序（次数相同保持原顺序） */
export function rankedPhrases(group: 'general' | 'ad', custom: string[], usage: Record<string, number>): { text: string; custom: boolean }[] {
  const all = [...DEFAULT_PHRASES[group].map((text) => ({ text, custom: false })), ...custom.map((text) => ({ text, custom: true }))]
  return all
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => (usage[b.text] ?? 0) - (usage[a.text] ?? 0) || a.i - b.i)
    .map(({ text, custom }) => ({ text, custom }))
}

/** 把短语追加到已有文字后面，用中文逗号分隔 */
export const appendPhrase = (text: string, phrase: string): string =>
  text.trim() ? text.replace(/[，,\s]*$/, '') + '，' + phrase : phrase

/** 项目里用过的页面名：当前模块下用过的优先，其余在后，各自按最近使用排序 */
export function pageSuggestions(p: Project, m: Module): string[] {
  const recent = [...p.bugs].filter((b) => b.page).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const seen = new Set<string>()
  const out: string[] = []
  for (const b of [...recent.filter((b) => b.module === m), ...recent]) {
    if (!seen.has(b.page)) {
      seen.add(b.page)
      out.push(b.page)
    }
  }
  return out
}

/** “Xiaomi Xiaomi 14” 这类品牌重复的型号只显示一次 */
export const deviceName = (d: { brand: string; model: string }) =>
  d.model.toLowerCase().startsWith(d.brand.toLowerCase()) ? d.model : `${d.brand} ${d.model}`.trim()

/** “复制给 AI”：让接了 BugShot MCP 的 AI 自己去读截图和设计稿 */
export function aiPrompt(p: Project, b: Bug): string {
  const what = [
    b.shots.some((s) => !s.ref) ? '截图' : '',
    b.shots.some((s) => s.marks?.length) ? '圈画评论' : '',
    b.shots.some((s) => s.ref) ? '对标应用的截图' : '',
    bugDesign(p, b) ? '对应的设计稿' : ''
  ].filter(Boolean)
  const has = what.length ? `，里面有${what.length > 1 ? `${what.slice(0, -1).join('、')}和${what[what.length - 1]}` : what[0]}` : ''
  const how = bugDesign(p, b) ? '对照设计稿修改代码' : '按描述修改代码'
  return `请修复项目“${p.name}”的第 ${b.seq} 条问题：${b.module} · ${bugLine(b)}。用 BugShot MCP 的 get_bug 读取这条问题${has}。${how}。处理完用 ai_feedback 写下结果：改好了标已修复并写明改了哪些文件；不确定是否改对、判断不了或在代码里查不到，分别标待确认修复、无法判断、查不到问题，并写清楚原因。`
}

export const AI_STATUS: Record<AiStatus, string> = { fixed: '已修复', confirm: '待确认修复', unclear: '无法判断', notfound: '查不到问题' }

/** 图片和网页里用的文字颜色，和客户端样式里的 .ai-line 一致 */
export const AI_COLOR: Record<AiStatus, string> = { fixed: '#6941c6', confirm: '#175cd3', unclear: '#b54708', notfound: '#5f6b7a' }

/** “AI 已修复”“AI 无法判断”这样的标签，旧数据没有 status 当作已修复 */
export const aiLabel = (f: AiFix) => `AI ${AI_STATUS[f.status ?? 'fixed']}`

/** “发给开发”的链接：在服务端只读网页里直接打开这一条 */
export function bugShareUrl(serverUrl: string, token: string, projectId: string, seq: number): string {
  const base = serverUrl.replace(/\/+$/, '')
  const q = token ? `?token=${encodeURIComponent(token)}` : ''
  return `${base}/${q}#bug=${encodeURIComponent(projectId)}/${seq}`
}

/** GitHub Release 说明（已渲染成 HTML）转成更新弹窗里显示的纯文本，保留标题和列表 */
export function releaseNotesText(html: string): string {
  const isHtml = /<[a-z][^>]*>/i.test(html)
  return (isHtml ? html.replace(/\r?\n/g, '') : html)
    .replace(/<\/(h\d)>/gi, '</$1>\n')
    .replace(/<li[^>]*>\s*/gi, '• ')
    .replace(/<\/(h\d|p|li|ul|ol|div)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.trim().replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '• ').replace(/\*\*(.+?)\*\*/g, '$1'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 开发自测：同一版截图上这条评论之前一共有几处标注，新评论的编号接着排 */
export const marksBefore = (page: SelfTestPage, msg: SelfTestMsg): Mark[] =>
  page.thread.slice(0, page.thread.indexOf(msg)).flatMap((m) => (m.who === 'me' && m.ver === msg.ver ? (m.marks ?? []) : []))

/** 开发自测：第 ver 版截图上验收人已经发出去的全部标注，按编号顺序 */
export const versionMarks = (page: SelfTestPage, ver: number): Mark[] => page.thread.flatMap((m) => (m.who === 'me' && m.ver === ver ? (m.marks ?? []) : []))

