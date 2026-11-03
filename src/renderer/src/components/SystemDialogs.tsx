import { useEffect, useState } from 'react'
import { api, type AppState, type Found } from '../api'
import type { Run, Toast } from '../App'
import { Modal } from './Modal'

const TOOLS: [string, string][] = [
  ['list_projects', '列出项目，可按关键字和状态筛选'],
  ['create_project', '新建项目（名称、开发人员、类型）'],
  ['get_project', '项目信息和每轮统计'],
  ['list_bugs', '读取某轮或全部反馈，可按模块、关键字筛选'],
  ['search_bugs', '跨项目按关键字搜索反馈'],
  ['get_bug', '读取一条反馈，附带截图和对应的设计稿'],
  ['ai_feedback', '处理完写 AI 反馈：已修复 / 待确认修复 / 无法判断 / 查不到问题，复测结果仍由人确认'],
  ['upload_designs', '上传 Figma 设计稿画板，截图时自动匹配'],
  ['set_design_positions', '同步画板在 Figma 里的位置，画布照原排版显示'],
  ['list_designs / get_design / delete_design', '查看、删除设计稿'],
  ['get_feedback_text', '与“复制文本”相同的纯文本'],
  ['export_project_zip', '导出 zip，返回下载地址']
]

/** 只有用自测令牌接入的 AI 才有 */
const SELF_TOOLS: [string, string][] = [
  ['selftest_upload', '开发自测：上传 App 页面截图，同名再传是新版本'],
  ['selftest_list / selftest_get', '开发自测：读页面状态、评论点和设计稿'],
  ['selftest_reply', '开发自测：回复验收人（“通过”只能由人点）']
]

export function CopyRow({ label, value, run, toast }: { label: string; value: string; run: Run; toast: Toast }) {
  return (
    <>
      <span className="k">{label}</span>
      <code>{value}</code>
      <button
        className="btn sm"
        onClick={async () => {
          await run('copy', value)
          toast(`已复制${label}`)
        }}
      >
        复制
      </button>
    </>
  )
}

export function ConnectDialog({ state, run, toast, onClose }: { state: AppState; run: Run; toast: Toast; onClose: () => void }) {
  const saved = state.settings.server
  const conn = state.conn
  const [url, setUrl] = useState(saved.url)
  const [token, setToken] = useState(saved.token)
  const [name, setName] = useState(saved.name)
  const [devToken, setDevToken] = useState(saved.devToken ?? '')
  const [found, setFound] = useState<Found[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const scan = async () => {
    setFound(null)
    const list = (await run<Found[]>('conn:discover')) ?? []
    setFound(list)
    if (!url && list.length === 1) setUrl(list[0].url)
  }
  useEffect(() => void scan(), [])

  const normalized = () => {
    const u = url.trim()
    if (!u) return ''
    const full = /^https?:\/\//.test(u) ? u : `http://${u}`
    return /:\d+(\/|$)/.test(full.replace(/^https?:\/\//, '')) ? full : `${full}:17800`
  }
  const connect = async () => {
    const next = { url: normalized(), token: token.trim(), name: name.trim(), devToken: devToken.trim() }
    if (!next.url) return setErr('先选一个服务端，或者填地址')
    if (!next.name) return setErr('填一下你的名字，会记在每条反馈上')
    setBusy(true)
    setErr('')
    try {
      await api.call('conn:probe', next)
      await api.call('conn:save', next)
      toast('已连接服务端')
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const mcpUrl = saved.url ? `${saved.url}/mcp` : ''
  const auth = saved.token ? ` --header "Authorization: Bearer ${saved.token}"` : ''
  const claude = `claude mcp add --transport http bugshot ${mcpUrl}${auth}`
  const codex = saved.token
    ? `export BUGSHOT_TOKEN=${saved.token}\ncodex mcp add bugshot --url ${mcpUrl} --bearer-token-env-var BUGSHOT_TOKEN`
    : `codex mcp add bugshot --url ${mcpUrl}`

  return (
    <Modal onClose={onClose} label="连接服务端">
      <div>
        <h3>连接 BugShot 服务端</h3>
        <p className="sub">数据都存在服务端，所有测试人员共用。填一次就行，之后自动连接；连不上时新记的反馈先存在本机，连上后自动上传。</p>
      </div>
      {conn.status === 'online' && (
        <p className="note" style={{ color: 'var(--ok)' }}>
          已连接 · {conn.serverName} · v{conn.serverVersion}
        </p>
      )}
      {conn.status !== 'online' && conn.status !== 'unset' && conn.error && (
        <p className="note" style={{ color: 'var(--bad)' }}>
          {conn.error}
        </p>
      )}
      <div className="servers">
        <span className="lbl">
          在局域网里找到的服务端{' '}
          <button className="btn sm" onClick={scan} disabled={found === null}>
            {found === null ? '正在查找…' : '重新查找'}
          </button>
        </span>
        {found?.map((f) => (
          <button key={f.url} aria-pressed={normalized() === f.url} onClick={() => setUrl(f.url)}>
            <span className="dot" aria-hidden="true" />
            <span>
              <b>{f.name}</b>
              <span className="mono">
                {f.url.replace('http://', '')} · v{f.version}
              </span>
            </span>
          </button>
        ))}
        {found?.length === 0 && <p className="note">没找到。确认服务端已经打开、和这台电脑在同一个局域网，或者直接填地址。</p>}
      </div>
      <div className="settings-grid">
        <label className="lbl" htmlFor="cUrl">
          服务端地址
        </label>
        <input id="cUrl" className="in" placeholder="如 192.168.1.20:17800" value={url} onChange={(e) => setUrl(e.target.value)} />
        <label className="lbl" htmlFor="cTok">
          团队令牌
        </label>
        <input id="cTok" className="in mono" placeholder="在服务端窗口里看，bs_ 开头" value={token} onChange={(e) => setToken(e.target.value)} />
        <label className="lbl" htmlFor="cName">
          你的名字
        </label>
        <input id="cName" className="in" placeholder="记在每条反馈上，如 小王" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <details open={!!saved.devToken}>
        <summary className="lbl">开发自测（只有开发和验收的人需要填）</summary>
        <div className="settings-grid" style={{ marginTop: 8 }}>
          <label className="lbl" htmlFor="cDev">
            自测令牌
          </label>
          <input id="cDev" className="in mono" placeholder="在服务端窗口里看，bsd_ 开头" value={devToken} onChange={(e) => setDevToken(e.target.value)} />
        </div>
        <p className="note" style={{ marginTop: 6 }}>
          填上后项目里多一个“开发自测”：开发的 AI 上传 App 截图，你逐页验收、评论。测试人员不填这个，看不到。
        </p>
      </details>
      {err && (
        <p className="note" style={{ color: 'var(--bad)' }}>
          {err}
        </p>
      )}
      {conn.status === 'online' && conn.legacy > 0 && (
        <div className="banner info" style={{ margin: 0 }}>
          <span>这台电脑上还有 {conn.legacy} 个旧版本的项目，上传后大家都能看到。重名的项目会在名字后面加上你的名字。</span>
          <button
            className="btn sm"
            onClick={async () => {
              const r = await run<{ projects: unknown[] }>('legacy:upload')
              if (r) toast(`已上传 ${r.projects.length} 个项目`)
            }}
          >
            上传到服务端
          </button>
        </div>
      )}
      {conn.status === 'online' && mcpUrl && (
        <details>
          <summary className="lbl">让 AI agent 接入（MCP）</summary>
          <div className="kv" style={{ marginTop: 8 }}>
            <CopyRow label="MCP 地址" value={mcpUrl} run={run} toast={toast} />
            <CopyRow label="Claude Code" value={claude} run={run} toast={toast} />
            <CopyRow label="Codex" value={codex} run={run} toast={toast} />
            {conn.dev && saved.devToken && (
              <CopyRow label="开发 AI" value={`claude mcp add --transport http bugshot ${mcpUrl} --header "Authorization: Bearer ${saved.devToken}"`} run={run} toast={toast} />
            )}
          </div>
          <div className="tblwrap" style={{ marginTop: 8 }}>
            <table className="tools">
              <tbody>
                {[...TOOLS, ...(conn.dev ? SELF_TOOLS : [])].map(([n, d]) => (
                  <tr key={n}>
                    <td>{n}</td>
                    <td>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <div className="actions">
        <button className="btn" onClick={onClose}>
          {conn.status === 'unset' ? '稍后再说' : '关闭'}
        </button>
        <button className="btn primary" onClick={connect} disabled={busy}>
          {busy ? '正在连接…' : '连接'}
        </button>
      </div>
    </Modal>
  )
}

export function UpdateDialog({ state, run, onClose }: { state: AppState; run: Run; onClose: () => void }) {
  const u = state.update
  return (
    <Modal onClose={onClose} label="检查更新">
      <div>
        <h3>{u.state === 'available' ? `发现新版本 v${u.version}` : u.state === 'ready' ? `v${u.version} 已下载` : '检查更新'}</h3>
        <p className="sub">当前 v{state.version} · 来源 GitHub Releases：hui455/test-android</p>
      </div>
      {u.state === 'checking' && <p className="note">正在检查…</p>}
      {u.state === 'none' && <p className="note">已是最新版本。</p>}
      {u.state === 'error' && <p className="note" style={{ color: 'var(--bad)' }}>{u.message}</p>}
      {u.state === 'available' && u.notes && <div className="pre">{u.notes}</div>}
      {u.state === 'downloading' && <p className="note">正在下载 {u.percent}%</p>}
      <div className="row">
        <label className="switch">
          <input type="checkbox" checked={state.settings.autoCheckUpdate} onChange={(e) => run('settings:update', { autoCheckUpdate: e.target.checked })} /> 启动时自动检查
        </label>
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>
          关闭
        </button>
        {u.state === 'available' ? (
          <button className="btn primary" onClick={() => run('update:download')}>
            下载更新
          </button>
        ) : u.state === 'ready' ? (
          <button className="btn primary" onClick={() => run('update:install')}>
            重启并安装
          </button>
        ) : (
          <button className="btn primary" disabled={u.state === 'checking' || u.state === 'downloading'} onClick={() => run('update:check')}>
            检查更新
          </button>
        )}
      </div>
    </Modal>
  )
}

export function SettingsDialog({ state, run, toast, onClose }: { state: AppState; run: Run; toast: Toast; onClose: () => void }) {
  const [dev, setDev] = useState(state.settings.developer)
  return (
    <Modal onClose={onClose} label="设置">
      <h3>设置</h3>
      <div className="settings-grid">
        <span className="lbl">默认开发人员</span>
        <input className="in" value={dev} placeholder="新建项目时自动填入，如 Jack" onChange={(e) => setDev(e.target.value)} onBlur={() => run('settings:update', { developer: dev.trim() })} />
        <span className="lbl">adb 路径</span>
        <div className="row">
          <code className="mono" style={{ overflowWrap: 'anywhere' }}>
            {state.adb}
          </code>
          <button
            className="btn sm"
            onClick={async () => {
              const p = await run<string>('choose-adb')
              if (p) toast(`adb：${p}`)
            }}
          >
            选择…
          </button>
          {state.settings.adbPath && (
            <button className="btn sm" onClick={() => run('settings:update', { adbPath: '' })}>
              恢复默认
            </button>
          )}
        </div>
        <span className="lbl">快捷键</span>
        <span className="note">截图提 Bug：Ctrl/Cmd+Shift+B（项目打开了对标应用时，测试机和对标机一起截）　只记文字：Ctrl/Cmd+Shift+T（窗口不在前台也能用）</span>
      </div>
      <div className="actions">
        <button className="btn primary" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  )
}
