import type { Module } from '@shared/types'

export const modCls = (m: Module) => (m.startsWith('tab') ? 't' : m === '广告' ? 'a' : 'o')

const pad = (n: number) => String(n).padStart(2, '0')

/** ISO 时间显示成 “10/29 14:05” */
export function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export { deviceName } from '@shared/logic'
