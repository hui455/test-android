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

export type MarkKind = 'rect' | 'ellipse' | 'arrow' | 'pen'

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
  createdAt: string
  updatedAt: string
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

export interface LanSettings {
  enabled: boolean
  port: number
  token: string
  requireToken: boolean
  readOnly: boolean
}

export interface Settings {
  developer: string
  customPhrases: { general: string[]; ad: string[] }
  /** 短语被点击的次数，用于排序 */
  phraseUsage: Record<string, number>
  lan: LanSettings
  autoCheckUpdate: boolean
  adbPath: string
}

export type NewBug = Pick<Bug, 'module' | 'page' | 'text' | 'mode'>
