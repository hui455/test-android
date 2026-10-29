import { useState } from 'react'
import type { LanSettings } from '@shared/types'
import type { AppState } from '../api'
import type { Run, Toast } from '../App'
import { Modal } from './Modal'

const TOOLS: [string, string][] = [
  ['list_projects', '列出项目，可按关键字和状态筛选'],
  ['create_project', '新建项目（名称、开发人员、类型）'],
  ['get_project', '项目信息和每轮统计'],
  ['list_bugs', '读取某轮或全部反馈，可按模块、关键字筛选'],
  ['search_bugs', '跨项目按关键字搜索反馈'],
  ['get_bug', '读取一条反馈，附带截图图片'],
  ['add_bug / update_bug', '追加或修改文字反馈'],
  ['set_retest_result', '标记复测结果：已修复 / 仍存在'],
  ['start_round / end_round', '开始新一轮复测 / 结束测试'],
  ['get_feedback_text', '与“复制文本”相同的纯文本'],
  ['export_project_zip', '导出 zip，返回下载地址']
]

function CopyRow({ label, value, run, toast }: { label: string; value: string; run: Run; toast: Toast }) {
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

export function LanDialog({ state, run, toast, onClose }: { state: AppState; run: Run; toast: Toast; onClose: () => void }) {
  const lan = state.settings.lan
  const info = state.lan
  const [port, setPort] = useState(String(lan.port))
  const set = (patch: Partial<LanSettings>) => run('settings:update', { lan: { ...lan, ...patch } })
  const url = info.mcpUrl || `http://${info.address || '本机IP'}:${lan.port}/mcp`
  const auth = lan.requireToken ? ` --header "Authorization: Bearer ${lan.token}"` : ''
  const claude = `claude mcp add --transport http bugshot ${url}${auth}`
  const codex = lan.requireToken
    ? `export BUGSHOT_TOKEN=${lan.token}\ncodex mcp add bugshot --url ${url} --bearer-token-env-var BUGSHOT_TOKEN`
    : `codex mcp add bugshot --url ${url}`
  const codexToml = `[mcp_servers.bugshot]\nurl = "${url}"${lan.requireToken ? '\nbearer_token_env_var = "BUGSHOT_TOKEN"' : ''}`
  const web = info.webUrl ? `${info.webUrl}${lan.requireToken ? `/?token=${encodeURIComponent(lan.token)}` : ''}` : ''

  return (
    <Modal onClose={onClose} label="局域网访问与 MCP">
      <div>
        <h3>局域网访问与 MCP</h3>
        <p className="sub">同一局域网的电脑和手机可用浏览器查看（只读）；AI agent 通过 MCP 读写项目、读取截图。</p>
      </div>
      <div className="row">
        <label className="switch">
          <input type="checkbox" checked={lan.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> 开启局域网服务
        </label>
        <label className="switch">
          <input type="checkbox" checked={lan.requireToken} onChange={(e) => set({ requireToken: e.target.checked })} /> 需要访问口令
        </label>
        <label className="switch">
          <input type="checkbox" checked={lan.readOnly} onChange={(e) => set({ readOnly: e.target.checked })} /> 只读（禁止 agent 修改）
        </label>
        <label className="switch">
          端口
          <input
            className="in"
            style={{ width: 80 }}
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            onBlur={() => Number(port) > 0 && Number(port) < 65536 && Number(port) !== lan.port && set({ port: Number(port) })}
          />
        </label>
      </div>
      {info.error && <p className="note" style={{ color: 'var(--bad)' }}>{info.error}</p>}
      {lan.enabled && info.running && (
        <>
          <div className="kv">
            <CopyRow label="网页地址" value={web} run={run} toast={toast} />
            <CopyRow label="MCP 地址" value={info.mcpUrl} run={run} toast={toast} />
            {lan.requireToken && (
              <>
                <span className="k">访问口令</span>
                <code>{lan.token}</code>
                <button className="btn sm" onClick={() => run('settings:new-token')}>
                  重新生成
                </button>
              </>
            )}
            <CopyRow label="Claude Code" value={claude} run={run} toast={toast} />
            <CopyRow label="Codex" value={codex} run={run} toast={toast} />
            <CopyRow label="Codex 配置" value={codexToml} run={run} toast={toast} />
          </div>
          <p className="note">Codex 配置贴到 ~/.codex/config.toml，口令放在环境变量 BUGSHOT_TOKEN 里。</p>
          <div>
            <span className="lbl">MCP 提供的工具</span>
            <div className="tblwrap">
              <table className="tools">
                <tbody>
                  {TOOLS.map(([n, d]) => (
                    <tr key={n}>
                      <td>{n}</td>
                      <td>{d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {info.lastClient && <p className="note">最近一次 MCP 访问：{info.lastClient}</p>}
        </>
      )}
      <div className="actions">
        <button className="btn primary" onClick={onClose}>
          完成
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
        <span className="note">截图提 Bug：Ctrl/Cmd+Shift+B　只记文字：Ctrl/Cmd+Shift+T（窗口不在前台也能用）</span>
      </div>
      <div className="actions">
        <button className="btn primary" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  )
}
