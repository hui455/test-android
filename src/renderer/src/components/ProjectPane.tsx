import { useState } from 'react'
import { projectStatus, remaining, searchProject, STATUS_LABEL } from '@shared/logic'
import type { Project, ProjectStatus } from '@shared/types'
import type { Run, Toast } from '../App'

const FILTERS: [ProjectStatus | '', string][] = [
  ['', '全部'],
  ['testing', '测试中'],
  ['waiting', '待复测'],
  ['passed', '已通过']
]
const PS_CLASS: Record<ProjectStatus, string> = { testing: 'testing', waiting: 'wait', passed: 'pass' }

export function ProjectPane(props: {
  projects: Project[]
  curId: string
  onSelect: (id: string) => void
  run: Run
  toast: Toast
  developer: string
  /** 开发自测的进度，如“自测 5/8”，只有填了自测令牌才有 */
  selfBadge?: Record<string, string>
}) {
  const { projects, curId, onSelect, run, toast } = props
  const [q, setQ] = useState('')
  const [sf, setSf] = useState<ProjectStatus | ''>('')
  const [name, setName] = useState('')
  const [type, setType] = useState('马甲')
  const [creating, setCreating] = useState(false)
  const showForm = creating || projects.length === 0

  const shown = projects
    .map((p) => ({ p, s: searchProject(p, q) }))
    .filter(({ p, s }) => s.match && (!sf || projectStatus(p) === sf))

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    const p = await run<Project>('project:create', n, props.developer, type)
    if (p) {
      setName('')
      setCreating(false)
      onSelect(p.id)
      toast(`已创建“${n}”，第 1 轮测试开始`)
    }
  }

  return (
    <section className="pane p1" aria-label="项目">
      <div className="pane-h">
        <span>项目</span>
        <button className="btn sm ghost" onClick={() => setCreating(!creating)} aria-expanded={showForm}>
          {showForm && projects.length ? '收起' : '+ 新建'}
        </button>
      </div>
      {showForm && (
        <form className="newproj" onSubmit={create}>
          <input
            className="in"
            autoFocus={creating}
            placeholder="项目名，如 7-二维码"
            aria-label="新建项目名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
          />
          <select aria-label="项目类型" value={type} onChange={(e) => setType(e.target.value)}>
            <option>马甲</option>
            <option>马甲-换皮</option>
            <option>其他</option>
          </select>
          <button className="btn sm primary" type="submit">
            新建
          </button>
        </form>
      )}
      <div className="search">
        <input className="in" type="search" placeholder="搜项目名或反馈内容" aria-label="搜索项目" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="pick sm">
          {FILTERS.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={sf === k} onClick={() => setSf(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <ul className="projects">
        {shown.length === 0 && <li className="empty">{projects.length ? '没有匹配的项目' : '还没有项目'}</li>}
        {shown.map(({ p, s }) => {
          const st = projectStatus(p)
          const left = remaining(p)
          return (
            <li key={p.id}>
              <button aria-current={p.id === curId} onClick={() => onSelect(p.id)}>
                <span className="pt">
                  <span className="pn">{p.name}</span>
                  {p.createdBy === 'agent' && <span className="ai">AI</span>}
                  <span className={`ps ${PS_CLASS[st]}`}>{STATUS_LABEL[st]}</span>
                </span>
                <span className="sub">
                  <span>
                    {p.developer || '未填开发'} · {p.type} · 第{p.rounds.length}轮
                  </span>
                  <span className={`left${left ? '' : ' zero'}`} title="未修复">
                    {left ? `剩 ${left}` : '清零'}
                  </span>
                </span>
                {props.selfBadge?.[p.id] && (
                  <span className="sub">
                    <span className="spill self">{props.selfBadge[p.id]}</span>
                  </span>
                )}
                {s.hits > 0 && <span className="hit">{s.hits} 条反馈含“{q.trim()}”</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
