import { contextBridge, ipcRenderer } from 'electron'

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as Result<T>
  if (!r.ok) throw new Error(r.error)
  return r.value
}

const api = {
  call,
  on(channel: string, fn: (...args: unknown[]) => void) {
    const listener = (_e: unknown, ...args: unknown[]) => fn(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('bugshot', api)
export type BugshotApi = typeof api
