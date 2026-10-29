import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { latestRound } from '@shared/logic'
import type { Project } from '@shared/types'
import { api, type AppState, type Capture, type DeviceEntry, type UpdateStatus } from './api'
import { ProjectPane } from './components/ProjectPane'
import { FeedPane } from './components/FeedPane'
import { DetailPane } from './components/DetailPane'
import { ComposeDialog, type ComposeTarget } from './components/ComposeDialog'
import { CopyDialog, EndRoundDialog, ExportDialog } from './components/RoundDialogs'
import { ConnectDialog, SettingsDialog, UpdateDialog } from './components/SystemDialogs'
import { DesignPane, type ProjectTab } from './components/Designs'

type Dialog =
  | { kind: 'compose'; target: ComposeTarget; key: number }
  | { kind: 'copy' }
  | { kind: 'export' }
  | { kind: 'end' }
  | { kind: 'conn' }
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
  // 对标机：第二台手机，装着对标应用，可以不选
  const [refSerial, setRefSerial] = useState(recall('bugshot.refDevice'))
  const [dialog, setDialog] = useState<Dialog>(null)
  const [toastMsg, setToastMsg] = useState('')
  const [miniOn, setMiniOn] = useState(false)
  const [tab, setTab] = useState<ProjectTab>('feed')

  const toastTimer = useRef(0)
  const toast = useCallback((m: string) => {
    setToastMsg(m)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToastMsg(''), 2600)
  }, [])

  const refresh = useCallback(async () => setState(await api.call<AppState>('state')), [])

  // 第一次打开还没设置服务端，直接弹出连接界面
  const asked = useRef(false)
  useEffect(() => {
    if (state && state.conn.status === 'unset' && !asked.current) {
      asked.current = true
      setDialog({ kind: 'conn' })
    }
  }, [state])

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
        const { capture, refCapture } = p as { capture: Capture | null; refCapture?: Capture | null }
        setDialog({ kind: 'compose', target: { capture, refCapture }, key: Date.now() })
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
        setSerial((s) => (ready.some((d) => d.serial === s) ? s : (ready.find((d) => d.serial !== recall('bugshot.refDevice'))?.serial ?? ready[0]?.serial ?? '')))
        // 对标机拔掉了就先不用，插回来后还是它
        setRefSerial((s) => (ready.some((d) => d.serial === s) ? s : ''))
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
  const activeRef = refSerial && refSerial !== serial ? refSerial : ''
  useEffect(() => void api.call('set-ref-device', activeRef), [activeRef])

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

  const startCompose = async (withShot: boolean, both = false) => {
    if (!cur) return toast('先新建或选择一个项目')
    if (latestRound(cur).end) return toast(`第${cur.rounds.length}轮已结束，请先点“开始新一轮复测”`)
    if (!withShot) return setDialog({ kind: 'compose', target: { capture: null }, key: Date.now() })
    const [capture, refCapture] = await Promise.all([run<Capture>('capture', serial), both && activeRef ? run<Capture>('capture', activeRef) : null])
    if (capture) setDialog({ kind: 'compose', target: { capture, refCapture }, key: Date.now() })
    else if (refCapture) void run('discard-capture', refCapture.id)
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
        <button className="tb-btn" onClick={() => setDialog({ kind: 'conn' })}>
          <ConnLabel state={state} />
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
        {devices.filter((d) => d.state === 'device').length > 1 || refSerial ? (
          <div className="device">
            <span className="dot" aria-hidden="true" style={{ background: activeRef ? 'var(--ad)' : 'var(--faint)' }} />
            <select
              aria-label="对标机"
              value={activeRef}
              onChange={(e) => {
                setRefSerial(e.target.value)
                remember('bugshot.refDevice', e.target.value)
              }}
            >
              <option value="">不用对标机</option>
              {devices
                .filter((d) => d.state === 'device' && d.serial !== serial)
                .map((d) => (
                  <option key={d.serial} value={d.serial}>
                    对标机：{d.model} · {d.serial}
                  </option>
                ))}
            </select>
          </div>
        ) : null}
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
        {activeRef && (
          <button className="btn accent" onClick={() => startCompose(true, true)} disabled={!serial}>
            截两台 <kbd>Ctrl+Shift+R</kbd>
          </button>
        )}
        <button className="btn rec" onClick={() => startCompose(true)} disabled={!serial}>
          截图提 Bug <kbd>Ctrl+Shift+B</kbd>
        </button>
      </div>
      {state.conn.status !== 'online' && state.conn.status !== 'unset' && (
        <div className="banner warn" style={{ marginTop: 10 }}>
          {state.conn.status === 'offline' ? (
            <span>现在连不上服务端，新记的反馈先存在本机，连上后自动上传，编号到时候再分配。可以继续截图记录；删除项目、结束测试要等连上再做。</span>
          ) : (
            <span>{state.conn.error}</span>
          )}
          <button className="btn sm" onClick={() => (state.conn.status === 'offline' ? run('conn:retry') : setDialog({ kind: 'conn' }))}>
            {state.conn.status === 'offline' ? '重新连接' : '去设置'}
          </button>
        </div>
      )}
      {state.conn.status === 'online' && state.conn.legacy > 0 && (
        <div className="banner info" style={{ marginTop: 10 }}>
          <span>这台电脑上还有 {state.conn.legacy} 个旧版本的项目没有上传到服务端。</span>
          <button className="btn sm" onClick={() => setDialog({ kind: 'conn' })}>
            去上传
          </button>
        </div>
      )}
      <div className="panes">
        <ProjectPane projects={projects} curId={cur?.id ?? ''} onSelect={selectProject} run={run} toast={toast} developer={state.settings.developer} />
        {cur && tab === 'design' ? (
          <section className="pane wide" aria-label="设计稿">
            <DesignPane project={cur} tab={tab} onTab={setTab} run={run} toast={toast} />
          </section>
        ) : (
          <>
            <section className="pane" aria-label="反馈列表">
              {cur ? (
                <FeedPane
                  tab={tab}
                  onTab={setTab}
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
                  refSerial={activeRef}
                  onEdit={() => setDialog({ kind: 'compose', target: { capture: null, edit: selectedBug }, key: Date.now() })}
                  onDeleted={() => setSel('')}
                />
              ) : (
                <div className="empty">选择一条反馈查看详情</div>
              )}
            </section>
          </>
        )}
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
          refSerial={activeRef}
          onClose={() => setDialog(null)}
          onSaved={(id, next) => {
            setSel(id)
            setTab('feed')
            setView(cur.rounds.length)
            setDialog(next ? { kind: 'compose', target: { capture: null }, key: Date.now() } : null)
          }}
        />
      )}
      {dialog?.kind === 'copy' && cur && <CopyDialog project={cur} view={view} projects={projects} run={run} toast={toast} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'export' && cur && <ExportDialog project={cur} view={view} run={run} toast={toast} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'end' && cur && <EndRoundDialog project={cur} run={run} toast={toast} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'conn' && <ConnectDialog state={state} run={run} toast={toast} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'update' && <UpdateDialog state={state} run={run} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'settings' && <SettingsDialog state={state} run={run} toast={toast} onClose={() => setDialog(null)} />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  )
}

function ConnLabel({ state }: { state: AppState }) {
  const c = state.conn
  const who = state.settings.server.name
  if (c.status === 'online')
    return (
      <>
        <span className="live" />
        已连接 · {c.serverName}
        {who ? ` · ${who}` : ''}
        {c.outbox > 0 && <span className="badge">{c.outbox}</span>}
      </>
    )
  if (c.status === 'unset')
    return (
      <span className="conn-pill warn">
        <span className="live" style={{ background: 'var(--ad)' }} />
        未连接服务端
      </span>
    )
  if (c.status === 'connecting') return <>正在连接服务端…</>
  return (
    <span className={`conn-pill ${c.status === 'offline' ? 'warn' : 'bad'}`}>
      <span className="live" style={{ background: 'currentColor' }} />
      {c.status === 'offline' ? `服务端连不上${c.outbox ? ` · ${c.outbox} 条待上传` : ''}` : c.status === 'auth' ? '团队令牌不对' : '版本不兼容'}
    </span>
  )
}

export type Run = <T>(channel: string, ...args: unknown[]) => Promise<T | undefined>
export type Toast = (m: string) => void
