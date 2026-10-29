import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { latestRound } from '@shared/logic'
import type { Project } from '@shared/types'
import { api, type AppState, type Capture, type DeviceEntry, type UpdateStatus } from './api'
import { ProjectPane } from './components/ProjectPane'
import { FeedPane } from './components/FeedPane'
import { DetailPane } from './components/DetailPane'
import { ComposeDialog, type ComposeTarget } from './components/ComposeDialog'
import { CopyDialog, EndRoundDialog, ExportDialog } from './components/RoundDialogs'
import { LanDialog, SettingsDialog, UpdateDialog } from './components/SystemDialogs'

type Dialog =
  | { kind: 'compose'; target: ComposeTarget; key: number }
  | { kind: 'copy' }
  | { kind: 'export' }
  | { kind: 'end' }
  | { kind: 'lan' }
  | { kind: 'update' }
  | { kind: 'settings' }
  | null

const remember = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* 存不了就算了，只是记住上次选择 */
  }
}
const recall = (k: string) => {
  try {
    return localStorage.getItem(k) ?? ''
  } catch {
    return ''
  }
}

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [curId, setCurId] = useState(recall('bugshot.current'))
  const [views, setViews] = useState<Record<string, number>>({})
  const [sel, setSel] = useState('')
  const [devices, setDevices] = useState<DeviceEntry[]>([])
  const [devErr, setDevErr] = useState('')
  const [serial, setSerial] = useState(recall('bugshot.device'))
  const [dialog, setDialog] = useState<Dialog>(null)
  const [toastMsg, setToastMsg] = useState('')
  const [miniOn, setMiniOn] = useState(false)

  const toastTimer = useRef(0)
  const toast = useCallback((m: string) => {
    setToastMsg(m)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToastMsg(''), 2600)
  }, [])

  const refresh = useCallback(async () => setState(await api.call<AppState>('state')), [])

  /** 调用主进程，出错时提示 */
  const run = useCallback(
    async <T,>(channel: string, ...args: unknown[]): Promise<T | undefined> => {
      try {
        return await api.call<T>(channel, ...args)
      } catch (err) {
        toast((err as Error).message)
        return undefined
      }
    },
    [toast]
  )

  useEffect(() => {
    void refresh()
    const offs = [
      api.on('state-changed', () => void refresh()),
      api.on('toast', (m) => toast(String(m))),
      api.on('compose', (p) => {
        const { capture } = p as { capture: Capture | null }
        setDialog({ kind: 'compose', target: { capture }, key: Date.now() })
      }),
      api.on('update-status', (s) => setState((st) => (st ? { ...st, update: s as UpdateStatus } : st))),
      api.on('agent-activity', (m) => toast(`AI agent：${m}`)),
      api.on('mini-closed', () => setMiniOn(false))
    ]
    return () => offs.forEach((off) => off())
  }, [refresh, toast])

  // 设备每 3 秒刷新一次，掉线或换机时自动切换
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const list = await api.call<DeviceEntry[]>('devices')
        if (!alive) return
        setDevices(list)
        setDevErr('')
        const ready = list.filter((d) => d.state === 'device')
        setSerial((s) => (ready.some((d) => d.serial === s) ? s : (ready[0]?.serial ?? '')))
      } catch (err) {
        if (alive) setDevErr((err as Error).message)
      }
    }
    void poll()
    const t = setInterval(poll, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    void api.call('set-device', serial)
    if (serial) remember('bugshot.device', serial)
  }, [serial])

  const projects = state?.projects ?? []
  const cur: Project | undefined = projects.find((p) => p.id === curId) ?? projects[0]
  const view = cur ? Math.min(views[cur.id] ?? cur.rounds.length, cur.rounds.length) : 1

  // 新建项目后列表要等主进程推送才刷新，这期间不能把 curId 改回第一个项目
  useEffect(() => {
    if (cur) remember('bugshot.current', cur.id)
  }, [cur])

  const selectProject = (id: string) => {
    setCurId(id)
    setSel('')
  }
  const setView = (r: number) => cur && setViews((v) => ({ ...v, [cur.id]: r }))

  const startCompose = async (withShot: boolean) => {
    if (!cur) return toast('先新建或选择一个项目')
    if (latestRound(cur).end) return toast(`第${cur.rounds.length}轮已结束，请先点“开始新一轮复测”`)
    if (!withShot) return setDialog({ kind: 'compose', target: { capture: null }, key: Date.now() })
    const capture = await run<Capture>('capture', serial)
    if (capture) setDialog({ kind: 'compose', target: { capture }, key: Date.now() })
  }

  const selectedBug = useMemo(() => cur?.bugs.find((b) => b.id === sel), [cur, sel])
  const updateBadge = state?.update.state === 'available' || state?.update.state === 'ready'

  if (!state) return <div className="empty">加载中…</div>

  return (
    <div className="window">
      <div className="titlebar">
        <span className="logo">
          <i aria-hidden="true" />
          <b>BugShot</b>
        </span>
        <span className="spacer" />
        <button className="tb-btn" onClick={() => setDialog({ kind: 'lan' })}>
          <span className="live" style={{ background: state.lan.running ? 'var(--ok)' : 'var(--faint)' }} />
          {state.lan.running ? '局域网 · MCP 已开启' : '局域网 · MCP 未开启'}
        </button>
        <button className="tb-btn" onClick={() => setDialog({ kind: 'update' })}>
          v{state.version} · 检查更新 {updateBadge && <span className="badge">新</span>}
        </button>
        <button className="tb-btn" onClick={() => setDialog({ kind: 'settings' })}>
          设置
        </button>
      </div>
      <div className="devicebar">
        <div className="device">
          <span className="dot" aria-hidden="true" style={{ background: serial ? 'var(--ok)' : 'var(--faint)' }} />
          <select aria-label="选择设备" value={serial} onChange={(e) => setSerial(e.target.value)}>
            {devices.length === 0 && <option value="">未连接设备</option>}
            {devices.map((d) => (
              <option key={d.serial} value={d.serial} disabled={d.state !== 'device'}>
                {d.model} · {d.serial}
                {d.state === 'unauthorized' ? '（请在手机上允许 USB 调试）' : d.state !== 'device' ? `（${d.state}）` : ''}
              </option>
            ))}
          </select>
          {devErr ? <span className="devwarn">{devErr}</span> : !serial && <span className="mono">用 USB 连上手机并打开“USB 调试”</span>}
        </div>
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => {
            setMiniOn(!miniOn)
            void api.call('mini', !miniOn)
          }}
        >
          {miniOn ? '关闭悬浮窗' : '悬浮窗'}
        </button>
        <button className="btn" onClick={() => startCompose(false)}>
          只记文字 <kbd>Ctrl+Shift+T</kbd>
        </button>
        <button className="btn rec" onClick={() => startCompose(true)} disabled={!serial}>
          截图提 Bug <kbd>Ctrl+Shift+B</kbd>
        </button>
      </div>
      <div className="panes">
        <ProjectPane projects={projects} curId={cur?.id ?? ''} onSelect={selectProject} run={run} toast={toast} developer={state.settings.developer} />
        <section className="pane" aria-label="反馈列表">
          {cur ? (
            <FeedPane
              project={cur}
              view={view}
              sel={sel}
              onSelect={setSel}
              onView={(r) => {
                setView(r)
                setSel('')
              }}
              run={run}
              toast={toast}
              onCopy={() => setDialog({ kind: 'copy' })}
              onExport={() => setDialog({ kind: 'export' })}
              onEnd={() => setDialog({ kind: 'end' })}
              onStarted={(r, n) => {
                setView(r)
                toast(`已开始第${r}轮复测，带出 ${n} 条未修复问题`)
              }}
            />
          ) : (
            <div className="empty">在左侧输入项目名并点“新建”开始</div>
          )}
        </section>
        <section className="pane" aria-label="详情">
          <div className="pane-h">
            <span>详情</span>
          </div>
          {cur && selectedBug ? (
            <DetailPane
              project={cur}
              bug={selectedBug}
              view={view}
              run={run}
              toast={toast}
              hasDevice={!!serial}
              onEdit={() => setDialog({ kind: 'compose', target: { capture: null, edit: selectedBug }, key: Date.now() })}
              onDeleted={() => setSel('')}
            />
          ) : (
            <div className="empty">选择一条反馈查看详情</div>
          )}
        </section>
      </div>

      {dialog?.kind === 'compose' && cur && (
        <ComposeDialog
          key={dialog.key}
          project={cur}
          target={dialog.target}
          settings={state.settings}
          run={run}
          toast={toast}
          serial={serial}
          onClose={() => setDialog(null)}
          onSaved={(id, next) => {
            setSel(id)
            setView(cur.rounds.length)
            setDialog(next ? { kind: 'compose', target: { capture: null }, key: Date.now() } : null)
          }}
        />
      )}
      {dialog?.kind === 'copy' && cur && <CopyDialog project={cur} view={view} projects={projects} run={run} toast={toast} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'export' && cur && <ExportDialog project={cur} view={view} run={run} toast={toast} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'end' && cur && <EndRoundDialog project={cur} run={run} toast={toast} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'lan' && <LanDialog state={state} run={run} toast={toast} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'update' && <UpdateDialog state={state} run={run} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'settings' && <SettingsDialog state={state} run={run} toast={toast} onClose={() => setDialog(null)} />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  )
}

export type Run = <T>(channel: string, ...args: unknown[]) => Promise<T | undefined>
export type Toast = (m: string) => void
