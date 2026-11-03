import { shotFile } from '@shared/annotate'
import { aiLabel, groupByModule, remaining, roundReport } from '@shared/logic'
import { useContext, useEffect, useRef, useState } from 'react'
import type { Bug, CheckResult, Project, RoundResult } from '@shared/types'
import { shotUrl } from '../api'
import type { Run, Toast } from '../App'
import { ProjectTabs, type ProjectTab } from './Designs'
import { SelfCtx } from './selfCtx'
import { fmtTime } from './util'

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
  /** 按记录人筛选，状态放在外面，键盘和滚轮换条要用同一份列表 */
  who: string
  onWho: (who: string) => void
  tab: ProjectTab
  onTab: (t: ProjectTab) => void
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
  const { who, onWho: setWho } = props
  const [menu, setMenu] = useState(false)
  const self = useContext(SelfCtx)
  // 用键盘或滚轮换到的那条要露出来
  const feedRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    feedRef.current?.querySelector('.card.on')?.scrollIntoView({ block: 'nearest' })
  }, [sel])
  const reporters = [...new Set(p.bugs.map((b) => b.reporter ?? '').filter(Boolean))]
  const shown = who && reporters.includes(who) ? { ...p, bugs: p.bugs.filter((b) => b.reporter === who) } : p
  const rep = roundReport(shown, r)

  const own = (b: Bug) => b.shots.filter((x) => !x.ref).length
  const row = (b: Bug, i: number) => {
    const check = b.round < r
    return (
      <li className={`card${b.id === sel ? ' on' : ''}${b.checks[r] === 'fixed' ? ' done' : ''}${check ? ' has-chk' : ''}`} key={b.id}>
        <button className="bug" aria-current={b.id === sel} onClick={() => props.onSelect(b.id)}>
          <span className="no">{i + 1}.</span>
          {b.shots.length ? (
            <span className="thumb">
              <img src={shotUrl(p.id, shotFile(b.shots.find((x) => !x.ref) ?? b.shots[0]))} alt="" />
              {own(b) > 1 && <span className="thumb-n">{own(b)}</span>}
            </span>
          ) : (
            <span className="thumb none">文字</span>
          )}
          <span className="bug-b">
            <span className="bug-top">
              <span className="pg">{b.page || b.module}</span>
              <span className="who">
                {b.reporter}
                {b.reporter && r === b.round ? ' · ' : ''}
                {r === b.round ? fmtTime(b.createdAt).split(' ').pop() : ''}
              </span>
            </span>
            <span className="bug-t">{b.text}</span>
            {b.aiFix && (
              <span className={`ai-line ai-${b.aiFix.status ?? 'fixed'}`} title={`${b.aiFix.by} · ${fmtTime(b.aiFix.at)}\n${b.aiFix.summary}`}>
                {aiLabel(b.aiFix)}{b.aiFix.summary ? ` · ${b.aiFix.summary}` : ''}
              </span>
            )}
            <span className="tags">
              {r > 1 && b.round === r && <span className="tag new">新增</span>}
              {b.mode === 'audit' && <span className="tag audit">审核</span>}
              {b.mode === 'online' && <span className="tag online">上线</span>}
              {b.shots.some((x) => x.marks?.length) && <span className="tag marked">已标注</span>}
              {b.pending && <span className={`tag ${b.uploadError ? 'marked' : 'pend'}`}>{b.uploadError ? '上传失败' : '待上传'}</span>}
              {p.refApp && b.shots.some((x) => x.ref) && <span className="tag plain">有对标图</span>}
            </span>
          </span>
        </button>
        {check && <CheckButtons project={p} bug={b} view={r} run={run} />}
      </li>
    )
  }

  const groups = (list: Bug[]) =>
    groupByModule(list).map(([m, l]) => [
      <li className="grp" key={`g-${m}`}>
        <span>{m}</span>
        <span className="c">{l.length} 条</span>
        <span className="ln" />
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
        <div className="ptitle">
          <h2>{p.name}</h2>
          <span className="spacer" />
          <button className="btn sm" onClick={props.onCopy}>
            复制文本
          </button>
          <button className="btn sm" onClick={props.onExport}>
            导出
          </button>
          <span className="more">
            <button className="btn sm icon" aria-label="更多" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              ⋯
            </button>
            {menu && (
              <>
                <span className="menu-scrim" onClick={() => setMenu(false)} />
                <span className="menu" role="menu">
                  <button
                    role="menuitemcheckbox"
                    aria-checked={!!p.refApp}
                    title="需要拿另一台手机上的对标应用做对比时打开"
                    onClick={async () => (await run('project:update', p.id, { refApp: !p.refApp })) && props.toast(p.refApp ? '已关闭对标应用' : '已打开对标应用，在顶部选对标机')}
                  >
                    对标应用
                    <span className="spacer" />
                    <span className="track" aria-hidden="true" />
                  </button>
                  {self.dev && (
                    <button
                      role="menuitemcheckbox"
                      aria-checked={self.on}
                      title="正式测试前让开发的 AI 上传截图、你来验收；测试人员看不到"
                      onClick={() => {
                        setMenu(false)
                        self.toggle()
                      }}
                    >
                      开发自测
                      <span className="spacer" />
                      <span className="track" aria-hidden="true" />
                    </button>
                  )}
                  <span className="sep" />
                  <button role="menuitem" className="danger" onClick={deleteProject}>
                    删除项目
                  </button>
                </span>
              </>
            )}
          </span>
        </div>
        <div className="psub">
          <span>
            {p.developer || '未填开发人员'} · {p.type} · 未修复 {remaining(p)} 条
          </span>
          {reporters.length > 1 && (
            <select aria-label="记录人" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">全部记录人</option>
              {reporters.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          )}
        </div>
        <ProjectTabs project={p} tab={props.tab} onTab={props.onTab} />
        <div className="rbar">
          <span className="rounds" role="tablist" aria-label="测试轮次">
            {p.rounds.map((x) => (
              <button key={x.no} role="tab" aria-selected={r === x.no} onClick={() => props.onView(x.no)}>
                {x.no > 1 ? `第${x.no}轮复测` : '第1轮'}
                <span className={`dot ${x.end ? (x.result === 'pass' ? 'ok' : 'bad') : 'testing'}`} aria-hidden="true" />
                <span className="st">{x.end ? (x.result === 'pass' ? '通过' : '不通过') : '测试中'}</span>
              </button>
            ))}
          </span>
          {last.end && (
            <button className="btn sm newrd" onClick={startRound}>
              + 开始新一轮复测
            </button>
          )}
          <span className="spacer" />
          {rd.end ? (
            <>
              <span className="when">已结束 {fmtTime(rd.end)}</span>
              <span className="result" role="group" aria-label="本轮测试结果">
                {(['fail', 'pass'] as RoundResult[]).map((v) => (
                  <button key={v} className={v === 'fail' ? 'bad' : 'ok'} aria-pressed={rd.result === v} onClick={() => run('round:result', p.id, r, v)}>
                    {v === 'fail' ? '不通过' : '通过'}
                  </button>
                ))}
              </span>
            </>
          ) : (
            <>
              <span className="when">{fmtTime(rd.start)} 起</span>
              <button className="btn sm primary" onClick={props.onEnd}>
                结束测试
              </button>
            </>
          )}
        </div>
        {r > 1 && (
          <div className="rstats">
            <span className="ok">已修复 {rep.fixed.length}</span>
            <span className="bad">仍存在 {rep.still.length}</span>
            <span className="wait">待复测 {rep.pending.length}</span>
            <span className="new">新增 {rep.fresh.length}</span>
          </div>
        )}
      </div>
      <ul className="feed" ref={feedRef}>
        {r > 1 && (
          <>
            <li className="sec">
              <span>复测清单 · 第{r - 1}轮后未修复的问题</span>
              {r === p.rounds.length && rep.carried.length > 0 && (
                <span className="keys" title="在详情上滚动滚轮也能换条">
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> / 滚轮 换条 · <kbd>F</kbd> 已修复 · <kbd>S</kbd> 仍存在 · <kbd>B</kbd> 仍存在并补截图
                </span>
              )}
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
