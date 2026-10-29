import { useEffect, useState } from 'react'
import { STATUS_LABEL, projectStatus } from '@shared/logic'
import { api, type AppState } from './api'

/** 置顶悬浮窗：显示当前项目，一键截图或只记文字 */
export function Mini() {
  const [name, setName] = useState('')
  useEffect(() => {
    const refresh = async () => {
      const s = await api.call<AppState>('state')
      const cur = localStorage.getItem('bugshot.current')
      const p = s.projects.find((x) => x.id === cur)
      setName(p ? `${p.name} · 第${p.rounds.length}轮 · ${STATUS_LABEL[projectStatus(p)]}` : '未选择项目')
    }
    void refresh()
    const off = api.on('state-changed', () => void refresh())
    const t = setInterval(refresh, 3000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])
  return (
    <div className="mini-root">
      <span className="pname" title={name}>
        记到 <b>{name}</b>
      </span>
      <button className="txt" onClick={() => api.call('mini:compose', false)} aria-label="只记文字">
        文字
      </button>
      <button className="big" onClick={() => api.call('mini:compose', true)} aria-label="截图提 Bug" />
      <button className="x" onClick={() => api.call('mini', false)} aria-label="关闭悬浮窗">
        ×
      </button>
    </div>
  )
}
