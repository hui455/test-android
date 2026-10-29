import { shotFile } from '@shared/annotate'
import { groupByModule, remaining, roundReport } from '@shared/logic'
import { useState } from 'react'
import type { Bug, CheckResult, Project, RoundResult } from '@shared/types'
import { shotUrl } from '../api'
import type { Run, Toast } from '../App'
import { fmtTime, modCls } from './util'

export function CheckButtons({ project, bug, view, run }: { project: Project; bug: Bug; view: number; run: Run }) {
  const cur = bug.checks[view]
  const editable = view === project.rounds.length
  const set = (v: CheckResult) => run('bug:check', project.id, bug.id, cur === v ? null : v)
  return (
    <span className="chk" role="group" aria-label="复测结果">
      <button className="fx" aria-pressed={cur === 'fixed'} disabled={!editable} onClick={() => set('fixed')}>
        已修复
      </button>
      <button className="st" aria-pressed={cur === 'still'} disabled={!editable} onClick={() => set('still')}>
        仍存在
      </button>
    </span>
  )
}

export function FeedPane(props: {
  project: Project
  view: number
  sel: string
  onSelect: (id: string) => void
  onView: (r: number) => void
  run: Run
  toast: Toast
  onCopy: () => void
  onExport: () => void
  onEnd: () => void
  onStarted: (round: number, carried: number) => void
}) {
  const { project: p, view: r, sel, run } = props
  const rd = p.rounds[r - 1]
  const last = p.rounds[p.rounds.length - 1]
  const [who, setWho] = useState('')
  const reporters = [...new Set(p.bugs.map((b) => b.reporter ?? '').filter(Boolean))]
  const shown = who && reporters.includes(who) ? { ...p, bugs: p.bugs.filter((b) => b.reporter === who) } : p
  const rep = roundReport(shown, r)

  const row = (b: Bug, i: number) => (
    <li className="rt" key={b.id}>
      <button className={`bug${b.checks[r] === 'fixed' ? ' done' : ''}`} aria-current={b.id === sel} onClick={() => props.onSelect(b.id)}>
        <span className="no">{i + 1}.</span>
        {b.shots.length ? (
          <span className="thumb">
            <img src={shotUrl(p.id, shotFile(b.shots[0]))} alt="" />
            {b.shots.length > 1 && <span className="thumb-n">{b.shots.length}</span>}
          </span>
        ) : (
          <span className="thumb none">文字</span>
        )}
        <span className="bug-t">
          {b.page && <span className="pg">{b.page}-</span>}
          {b.text}
          {b.mode === 'audit' && <span className="tag audit">审核</span>}
          {b.mode === 'online' && <span className="tag online">上线</span>}
          {r > 1 && b.round === r && <span className="tag new">新增</span>}
          {b.shots.some((s) => s.marks?.length) && <span className="tag marked">已标注</span>}
          {b.pending && <span className={`tag ${b.uploadError ? 'marked' : 'pend'}`}>{b.uploadError ? '上传失败' : '待上传'}</span>}
          {b.reporter && <span className="who">{b.reporter}</span>}
        </span>
      </button>
      {b.round < r && <CheckButtons project={p} bug={b} view={r} run={run} />}
    </li>
  )

  const groups = (list: Bug[]) =>
    groupByModule(list).map(([m, l]) => [
      <li className="grp" key={`g-${m}`}>
        <span className={`mod ${modCls(m)}`}>{m}</span>
        <span className="c">{l.length}</span>
      </li>,
      ...l.map(row)
    ])

  const startRound = async () => {
    const np = await run<Project>('round:start', p.id)
    if (np) props.onStarted(np.rounds.length, roundReport(np, np.rounds.length).carried.length)
  }
  const allFixed = async () => {
    for (const b of rep.pending) await run('bug:check', p.id, b.id, 'fixed')
    props.toast('剩余复测项已标为已修复')
  }
  const deleteProject = async () => {
    await run('project:delete', p.id)
  }

  return (
    <>
      <div className="phead">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>{p.name}</h2>
          <div className="row">
            <button className="btn sm" onClick={props.onCopy}>
              复制文本
            </button>
            <button className="btn sm" onClick={props.onExport}>
              导出 zip
            </button>
            <button className="btn sm danger" onClick={deleteProject}>
              删除项目
            </button>
          </div>
        </div>
        <div className="meta">
          <span>开发人员：{p.developer || '未填'}</span>
          <span>类型：{p.type}</span>
          <span>未修复合计 {remaining(p)} 条</span>
          {reporters.length > 1 && (
            <label className="switch">
              记录人
              <select value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">全部</option>
                {reporters.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="rounds" role="tablist" aria-label="测试轮次">
          {p.rounds.map((x) => (
            <button key={x.no} role="tab" aria-selected={r === x.no} onClick={() => props.onView(x.no)}>
              <span>{x.no > 1 ? `第${x.no}轮复测` : '第1轮'}</span>
              {x.end ? <span className={`rs ${x.result === 'pass' ? 'ok' : 'bad'}`}>{x.result === 'pass' ? '通过' : '不通过'}</span> : <span className="rs testing">测试中</span>}
              <span className="mono">
                {fmtTime(x.start)}
                {x.end ? ` – ${fmtTime(x.end).split(' ').pop()}` : ' 起'}
              </span>
            </button>
          ))}
          {last.end && (
            <button className="newrd" onClick={startRound}>
              + 开始新一轮复测
            </button>
          )}
        </div>
        <div className="endbar">
          {rd.end ? (
            <>
              <span className="result" role="group" aria-label="本轮测试结果">
                {(['fail', 'pass'] as RoundResult[]).map((v) => (
                  <button key={v} className={v === 'fail' ? 'bad' : 'ok'} aria-pressed={rd.result === v} onClick={() => run('round:result', p.id, r, v)}>
                    {v === 'fail' ? '测试不通过' : '测试通过'}
                  </button>
                ))}
              </span>
              <span>已结束 {fmtTime(rd.end)}</span>
            </>
          ) : (
            <>
              <span className="rs testing">测试中</span>
              <span>开始于 {fmtTime(rd.start)}</span>
              <button className="btn sm primary" onClick={props.onEnd}>
                结束测试
              </button>
            </>
          )}
        </div>
        <div className="meta">
          {r > 1 ? (
            <span>
              复测 {rep.carried.length} 条：<b className="okc">已修复 {rep.fixed.length}</b> · <b className="badc">仍存在 {rep.still.length}</b> · 待复测 {rep.pending.length}　新增{' '}
              {rep.fresh.length} 条
            </span>
          ) : (
            <span>{rep.fresh.length} 条反馈</span>
          )}
        </div>
      </div>
      <ul className="feed">
        {r > 1 && (
          <>
            <li className="sec">
              <span>复测清单 · 第{r - 1}轮后未修复的问题</span>
              {rep.pending.length > 0 && r === p.rounds.length && (
                <button className="btn sm" onClick={allFixed}>
                  剩余 {rep.pending.length} 条全部已修复
                </button>
              )}
            </li>
            {rep.carried.length ? groups(rep.carried) : <li className="empty">上轮问题已全部修复</li>}
            <li className="sec">
              <span>本轮新增</span>
            </li>
          </>
        )}
        {rep.fresh.length ? (
          groups(rep.fresh)
        ) : (
          <li className="empty">
            {r > 1 ? '本轮还没有新问题。' : '还没有反馈。'}
            <br />按 <kbd>Ctrl+Shift+B</kbd> 截图，或 <kbd>Ctrl+Shift+T</kbd> 只记文字。
          </li>
        )}
      </ul>
    </>
  )
}
