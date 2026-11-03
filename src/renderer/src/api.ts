import type { ConnState, DeviceInfo, Project, SelfTest, Settings } from '@shared/types'

/** 局域网里自动找到的服务端 */
export interface Found {
  name: string
  url: string
  version: string
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'none'; version: string }
  | { state: 'available'; version: string; notes: string; date: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export interface AppState {
  projects: Project[]
  /** 开发自测，key 是项目 id；没填自测令牌时为空 */
  selftests: Record<string, SelfTest>
  settings: Settings
  conn: ConnState
  version: string
  update: UpdateStatus
  adb: string
}

export interface DeviceEntry {
  serial: string
  state: string
  model: string
  transport: 'usb' | 'tcp'
}

export interface Capture {
  id: string
  dataUrl: string
  device: DeviceInfo
}

interface Bridge {
  call<T>(channel: string, ...args: unknown[]): Promise<T>
  on(channel: string, fn: (...args: unknown[]) => void): () => void
}

declare global {
  interface Window {
    bugshot: Bridge
  }
}

export const api = window.bugshot
export const shotUrl = (projectId: string, file: string) => `bugshot://shot/${encodeURIComponent(projectId)}/${encodeURIComponent(file)}`
export const designUrl = (projectId: string, file: string) => `bugshot://design/${encodeURIComponent(projectId)}/${encodeURIComponent(file)}`
export const selfUrl = (projectId: string, file: string) => `bugshot://selftest/${encodeURIComponent(projectId)}/${encodeURIComponent(file)}`
