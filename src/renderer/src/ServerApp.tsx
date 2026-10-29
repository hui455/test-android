import { useCallback, useEffect, useRef, useState } from 'react'
import type { OnlineClient, ServerConfig } from '@shared/types'
import { api } from './api'

interface SrvState {
  version: string
  status: { running: boolean; address: string; port: number; webUrl: string; mcpUrl: string; error: string }
  config: ServerConfig
  clients: OnlineClient[]
  stats: { projects: number; bugs: number; bytes: number }
  dataRoot: string
  lastBackup: string
  openAtLogin: boolean
  uptime: number
}

const size = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.ceil(b / 1e3)} KB`)
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : `${Math.round(m / 60)} 小时前`
}
const uptime = (ms: number) => {
  const h = Math.floor(ms / 3_600_000)
  return h >= 24 ? `${Math.floor(h / 24)} 天` : h >= 1 ? `${h} 小时` : `${Math.max(1, Math.floor(ms / 60000))} 分钟`
}

/** 服务端窗口：运行状态、连接信息、在线的客户端、数据与备份 */
export function ServerApp() {
  const [s, setS] = useState<SrvState | null>(null)
  const [toastMsg, setToastMsg] = useState('')
  const [name, setName] = useState('')
  const [port, setPort] = useState('')
  const [upd, setUpd] = useState<{ latest: string; url: string; newer: boolean } | null>(null)
  const timer = useRef(0)
  const toast = (m: string) => {
    setToastMsg(m)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToastMsg(''), 2600)
  }
  const refresh = useCallback(async () => {
    const v = await api.call<SrvState>('srv:state')
    setS(v)
    return v
  }, [])
  useEffect(() => {
    void refresh().then((v) => {
      setName(v.config.name)
      setPort(String(v.config.port))
    })
    // 打开窗口时悄悄检查一次，有新版本在标题栏提示
    api.call<{ latest: string; url: string; newer: boolean }>('srv:check-update').then(setUpd, () => {})
    const off = api.on('state-changed', () => void refresh())
    const t = setInterval(refresh, 15000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [refresh])

  const call = async (ch: string, ...args: unknown[]) => {
    try {
      return await api.call(ch, ...args)
    } catch (err) {
      toast((err as Error).message)
    }
  }
  const copy = async (label: string, text: string) => {
    await call('copy', text)
    toast(`已复制${label}`)
  }

  if (!s) return <div className="empty">加载中…</div>
  const c = s.config
  const auth = c.requireToken ? ` --header "Authorization: Bearer ${c.token}"` : ''
  const claude = `claude mcp add --transport http bugshot ${s.status.mcpUrl}${auth}`
  const codex = c.requireToken
    ? `export BUGSHOT_TOKEN=${c.token}\ncodex mcp add bugshot --url ${s.status.mcpUrl} --bearer-token-env-var BUGSHOT_TOKEN`
    : `codex mcp add bugshot --url ${s.status.mcpUrl}`

  return (
    <div className="window">
      <div className="titlebar">
        <span className="logo">
          <i aria-hidden="true" />
          <b>BugShot 服务端</b>
        </span>
        <span className="spacer" />
        <button
          className="tb-btn"
          onClick={async () => {
            const r = (await call('srv:check-update')) as { latest: string; url: string; newer: boolean } | undefined
            if (!r) return
            setUpd(r)
            if (!r.newer) return toast(`已是最新版本 v${s.version}`)
            toast(`有新版本 v${r.latest}，正在打开下载页`)
            void call('srv:open-url', r.url)
          }}
        >
          v{s.version} · 检查更新 {upd?.newer && <span className="badge">v{upd.latest}</span>}
        </button>
      </div>
      <div className="srv">
        <div className="srv-body">
          <div className="srv-card wide">
            <div className="srv-status">
              <span className="live" style={{ width: 10, height: 10, background: s.status.running ? 'var(--ok)' : 'var(--rec)' }} />
              <div>
                <b>
                  {s.status.running ? '运行中' : '没有运行'} · {c.name}
                </b>
                <p className="sub">{s.status.running ? `已运行 ${uptime(s.uptime)} · 关掉窗口后在托盘继续运行` : s.status.error}</p>
              </div>
              <span className="spacer" />
              <button className="btn" onClick={() => call('srv:open-web')} disabled={!s.status.running}>
                打开网页
              </button>
            </div>
            <div className="row">
              <label className="switch">
                <input type="checkbox" checked={s.openAtLogin} onChange={(e) => call('srv:login', e.target.checked)} /> 开机自动启动
              </label>
              <label className="switch">
                <input type="checkbox" checked={c.readOnly} onChange={(e) => call('srv:update', { readOnly: e.target.checked })} /> 只读（AI agent 只能查看，不能建项目、传设计稿）
              </label>
            </div>
          </div>

          <div className="srv-card">
            <h3>连接信息</h3>
            <div className="settings-grid">
              <label className="lbl" htmlFor="sName">
                名称
              </label>
              <input id="sName" className="in" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name.trim() !== c.name && call('srv:update', { name: name.trim() })} />
              <span className="lbl">地址</span>
              <code className="mono">{s.status.webUrl || '—'}</code>
              <label className="lbl" htmlFor="sPort">
                端口
              </label>
              <input
                id="sPort"
                className="in"
                style={{ width: 90 }}
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
                onBlur={() => Number(port) > 0 && Number(port) < 65536 && Number(port) !== c.port && call('srv:update', { port: Number(port) })}
              />
              <span className="lbl">团队令牌</span>
              <div className="row">
                <code className="mono">{c.requireToken ? c.token : '不需要'}</code>
                {c.requireToken && (
                  <>
                    <button className="btn sm" onClick={() => copy('团队令牌', c.token)}>
                      复制
                    </button>
                    <button className="btn sm" onClick={() => call('srv:new-token')}>
                      重新生成
                    </button>
                  </>
                )}
              </div>
            </div>
            <p className="note">测试人员的 BugShot 会在局域网里自动找到这台服务端，只需要填团队令牌。重新生成令牌后，每个人都要重新填一次。</p>
            <div className="row">
              <button className="btn sm" onClick={() => copy(' Claude Code 接入命令', claude)} disabled={!s.status.running}>
                复制 Claude Code 接入命令
              </button>
              <button className="btn sm" onClick={() => copy(' Codex 接入命令', codex)} disabled={!s.status.running}>
                复制 Codex 接入命令
              </button>
            </div>
          </div>

          <div className="srv-card">
            <h3>在线的客户端 {s.clients.length}</h3>
            {s.clients.length ? (
              <ul className="clients">
                {s.clients.map((x, i) => (
                  <li key={i}>
                    <span className="live" style={{ background: 'var(--ok)' }} />
                    <span>
                      {x.name}
                      {x.kind === 'mcp' ? '（MCP）' : ''}
                      {x.detail && x.kind === 'client' ? ` · ${x.detail}` : ''}
                    </span>
                    <span className="when">{x.kind === 'mcp' && x.detail ? x.detail : x.kind === 'mcp' ? ago(x.last) : x.address.replace('::ffff:', '')}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="note">还没有客户端连上来。</p>
            )}
          </div>

          <div className="srv-card wide">
            <div className="row">
              <h3>数据</h3>
              <span className="note">
                {s.stats.projects} 个项目 · {s.stats.bugs} 条反馈 · {size(s.stats.bytes)} · 存在 {s.dataRoot}
              </span>
            </div>
            <div className="row">
              <button className="btn sm" onClick={() => call('srv:open-dir')}>
                打开目录
              </button>
              <button className="btn sm" onClick={() => call('srv:change-dir')}>
                更改位置
              </button>
              <button
                className="btn sm"
                onClick={async () => {
                  if (await call('srv:backup')) toast('已备份')
                }}
              >
                立即备份
              </button>
              <label className="switch">
                <input type="checkbox" checked={c.autoBackup} onChange={(e) => call('srv:update', { autoBackup: e.target.checked })} /> 每天 3:00 自动备份，保留 7 份
              </label>
              {s.lastBackup && <span className="note">最近一次：{s.lastBackup}</span>}
            </div>
          </div>
        </div>
      </div>
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  )
}
