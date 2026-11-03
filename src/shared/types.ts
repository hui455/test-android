export const MODULES = ['tab1', 'tab2', 'tab3', 'tab4', '广告', '登录/支付', '悬浮窗', '其他'] as const
export type Module = (typeof MODULES)[number]

/** 审核状态 / 上线模式，空字符串表示不区分 */
export type Mode = '' | 'audit' | 'online'
export type CheckResult = 'fixed' | 'still'
export type RoundResult = 'pass' | 'fail'

export interface DeviceInfo {
  serial: string
  model: string
  brand: string
  androidVersion: string
  sdk: string
  resolution: string
  foreground: string
}

/** pin 是开发自测里的评论点：只有一个编号圆点，pts 为 [x, y, x, y] */
export type MarkKind = 'rect' | 'ellipse' | 'arrow' | 'pen' | 'pin'

/** 截图上的一处圈画，坐标是原图像素；编号按数组顺序从 1 开始 */
export interface Mark {
  kind: MarkKind
  color: string
  /** rect / ellipse / arrow 为 [x1, y1, x2, y2]，pen 为 [x, y, x, y, …] */
  pts: number[]
  /** 这一处的评论，可为空 */
  note: string
}

export interface Screenshot {
  /** 文件名，位于项目目录的 screenshots/ 下 */
  file: string
  takenAt: string
  /** 圈画标注，原图不改动 */
  marks?: Mark[]
  /** 画上标注后的图片文件名，与原图同目录 */
  marked?: string
  /** 对标机（装着对标应用的第二台手机）截的图 */
  ref?: boolean
  /** 对标截图的设备，主测机的设备记在 Bug.device */
  device?: DeviceInfo | null
}

export interface Bug {
  id: string
  /** 项目内自增编号，从 1 开始 */
  seq: number
  module: Module
  page: string
  text: string
  mode: Mode
  /** 第几轮发现 */
  round: number
  /** 之后各轮的复测结果，key 为轮次 */
  checks: Record<string, CheckResult>
  shots: Screenshot[]
  device: DeviceInfo | null
  /** 记录人（测试人员在客户端填的名字，AI agent 记的为 “AI agent”） */
  reporter?: string
  /** 最后修改人 */
  updatedBy?: string
  /** 对应的设计稿画板 */
  design?: BugDesign | null
  /** AI agent 写的反馈（已修复 / 待确认修复 / 无法判断 / 查不到问题），复测结果仍由测试人员确认 */
  aiFix?: AiFix | null
  /** 仅客户端：还在本机待上传，没有编号 */
  pending?: boolean
  /** 仅客户端：补传失败的原因 */
  uploadError?: string
  createdAt: string
  updatedAt: string
}

/** AI 反馈的结论：已修复 / 待确认修复 / 无法判断 / 查不到问题 */
export type AiStatus = 'fixed' | 'confirm' | 'unclear' | 'notfound'

/** AI agent 处理一条反馈后写下的结论和说明（旧数据没有 status，当作已修复） */
export interface AiFix {
  status?: AiStatus
  summary: string
  by: string
  at: string
  /** 标记时所在的轮次 */
  round: number
}

/** 反馈关联的设计稿；score 是截图和设计稿的相似度（0–1），手动选的为 null */
export interface BugDesign {
  id: string
  score: number | null
}

/**
 * 设计稿里的一个画板（一般由接了 Figma 的 AI agent 通过 MCP 上传）。
 * 图片存在服务端项目目录的 designs/ 下。
 */
export interface Design {
  id: string
  /** Figma 页面名，如“tab1 首页” */
  page: string
  /** 画板名，如“首页-审核状态”，选中后填进反馈的“页面” */
  name: string
  /** 对应的模块，上传时没给就按页面名推断 */
  module: Module | ''
  file: string
  width: number
  height: number
  /** 画板在 Figma 里的链接 */
  figmaUrl: string
  /** 画板在 Figma 页面上的位置和大小（Figma 坐标），画布视图按它还原 Figma 里的排版；旧数据没有 */
  box?: DesignBox
  /** 用来和截图比对的缩略特征，见 shared/match.ts */
  sig: string
  uploadedBy: string
  updatedAt: string
}

export interface DesignBox {
  x: number
  y: number
  w: number
  h: number
}

/** 设计稿来自哪个 Figma 文件 */
export interface FigmaSource {
  name: string
  url: string
}

export interface Round {
  no: number
  start: string
  /** 为空表示测试中 */
  end: string | null
  result: RoundResult
}

export interface Project {
  id: string
  name: string
  developer: string
  type: string
  createdAt: string
  createdBy: 'user' | 'agent'
  rounds: Round[]
  bugs: Bug[]
  nextSeq: number
  designs?: Design[]
  figma?: FigmaSource | null
  /** 项目打开了“对标应用”开关，才显示对标机和对标截图 */
  refApp?: boolean
}

export type ProjectStatus = 'testing' | 'waiting' | 'passed'

export interface ProjectSummary {
  id: string
  name: string
  developer: string
  type: string
  createdBy: 'user' | 'agent'
  round: number
  status: ProjectStatus
  remaining: number
  bugCount: number
}

/** 服务端设置，存在服务端数据目录的 server.json */
export interface ServerConfig {
  /** 显示给客户端的名称，如“办公室服务器” */
  name: string
  port: number
  token: string
  requireToken: boolean
  /**
   * 自测令牌：开发自测只认这个令牌。给开发的 AI（上传自测截图）和验收的人（客户端里填上才看得到“开发自测”），
   * 测试人员只有团队令牌，看不到也碰不到自测数据
   */
  devToken: string
  /** 禁止 AI agent 通过 MCP 修改数据 */
  readOnly: boolean
  /** 每天 3:00 自动备份，保留 7 份 */
  autoBackup: boolean
}

/** 服务端 /api/info 的返回，局域网自动发现也用它 */
export interface ServerInfo {
  app: 'bugshot-server'
  name: string
  /** 服务端自己的局域网 IP，自动发现时用它拼地址，同一台服务端只列一次 */
  address: string
  version: string
  protocol: number
  port: number
  needToken: boolean
  readOnly: boolean
}

export interface OnlineClient {
  name: string
  kind: 'client' | 'mcp'
  /** 客户端当前连着的手机，或 MCP 最近做的事 */
  detail: string
  address: string
  last: string
}

export interface ConnSettings {
  /** 服务端地址，如 http://192.168.1.20:17800，空表示还没设置 */
  url: string
  token: string
  /** 测试人员名字，记在每条反馈上 */
  name: string
  /** 上次连上的服务端名称；服务端换了 IP 时按名称重新找 */
  serverName?: string
  /** 自测令牌，只有开发和验收的人填 */
  devToken?: string
}

export type ConnStatus = 'unset' | 'connecting' | 'online' | 'offline' | 'auth' | 'mismatch'

export interface ConnState {
  status: ConnStatus
  url: string
  serverName: string
  serverVersion: string
  error: string
  /** 本机待上传的反馈条数 */
  outbox: number
  /** 本机还没上传的旧版本项目数 */
  legacy: number
  /** 填了正确的自测令牌，能看“开发自测” */
  dev?: boolean
}

export interface Settings {
  developer: string
  customPhrases: { general: string[]; ad: string[] }
  /** 短语被点击的次数，用于排序 */
  phraseUsage: Record<string, number>
  server: ConnSettings
  autoCheckUpdate: boolean
  adbPath: string
}

export type NewBug = Pick<Bug, 'module' | 'page' | 'text' | 'mode'> & { design?: BugDesign | null }

// ---------- 开发自测 ----------
// 正式测试之前，开发的 AI 把 App 每个页面截图传上来，验收的人逐页通过或评论，AI 读到评论后改代码、重新截图。
// 数据和正式测试完全分开（projects/<id>/selftest.json），只有带自测令牌的人和 AI 能看到。

/** 待验收 / 有问题（等 AI 改）/ 已通过 */
export type SelfTestStatus = 'todo' | 'issue' | 'pass'

/** AI 上传的一版截图，版本号从 1 开始，等于在 shots 里的位置 + 1 */
export interface SelfTestShot {
  file: string
  width: number
  height: number
  /** 和设计稿比对用的特征 */
  sig: string
  by: string
  at: string
  /** 截图时的设备、前台 Activity，AI 传了才有 */
  device?: string
  activity?: string
}

/** 页面下的一条对话：验收人的评论（可带评论点、框），或 AI 的回复 */
export interface SelfTestMsg {
  id: string
  who: 'me' | 'ai'
  by: string
  /** 针对第几版截图 */
  ver: number
  text: string
  /** 评论点和框，坐标是这一版截图的像素；编号接着这一版前面的评论往下排 */
  marks?: Mark[]
  /** 这一版截图画上到这条为止所有评论点的图片，给 AI 看 */
  marked?: string
  at: string
}

export interface SelfTestPage {
  id: string
  /** 页面名，最好和设计稿画板名一致，如“首页-审核状态”；AI 用同一个名字再传就是新版本 */
  name: string
  module: Module | ''
  status: SelfTestStatus
  shots: SelfTestShot[]
  /** 对应的设计稿；score 为 null 表示手动选的，之后的新版本不再自动换 */
  design: BugDesign | null
  thread: SelfTestMsg[]
  passedBy?: string
  passedAt?: string
  updatedAt: string
}

export interface SelfTest {
  projectId: string
  /** 项目“⋯”里的“开发自测”开关；AI 第一次上传时自动打开 */
  enabled: boolean
  pages: SelfTestPage[]
}

/** 客户端和服务端的接口版本，不一致时提示升级 */
export const PROTOCOL = 1
