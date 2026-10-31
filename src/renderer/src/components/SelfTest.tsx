import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { MARK_COLORS, marksSvg, markStyle, markTooSmall } from '@shared/annotate'
import { designLabel, marksBefore, versionMarks } from '@shared/logic'
import { MODULES, type Mark, type Project, type SelfTest, type SelfTestPage, type SelfTestStatus } from '@shared/types'
import { designUrl, selfUrl } from '../api'
import type { Run, Toast } from '../App'
import { renderMarked } from './Annotator'
import { DesignPicker, ProjectTabs, type ProjectTab } from './Designs'
import { fmtTime } from './util'

/**
 * 开发自测：正式测试之前，开发的 AI 把 App 每个页面截图传上来，验收人逐页通过，
 * 或者在截图上钉评论点、写评论发给 AI，AI 改完重新截图成新版本。
 * 只有填了自测令牌的人看得到，数据和正式测试的反馈完全分开。
 */

const LABEL: Record<SelfTestStatus, string> = { todo: '待验收', issue: '有问题 · 等 AI 改', pass: '已通过' }

const FILTERS: [SelfTestStatus | 'all', string][] = [
  ['all', '全部'],
  ['todo', '待验收'],
  ['issue', '有问题'],
  ['pass', '已通过']
]

/** 发给开发的 AI：把所有页面截图传上来 */
export const uploadPrompt = (p: Project) =>
  `请把 App 的每个页面都截一张图（同一页面的不同状态分开截，比如审核状态和上线模式），用 MCP 的 selftest_upload 上传到项目“${p.name}”的开发自测。页面名用设计稿里对应的画板名，可以先用 list_designs 看有哪些画板。`

/** 发给开发的 AI：处理有问题的页面 */
export const fixPrompt = (p: Project) =>
  `请处理项目“${p.name}”开发自测里标了“有问题”的页面。用 MCP 的 selftest_list（status 填 issue）读取，再用 selftest_get 看每一页截图上的评论点和对应的设计稿。对照设计稿改代码，改完重新截这一页，用 selftest_upload 按原来的页面名上传，并在 note 里写改了什么。看不懂的评论用 selftest_reply 问我。`

const lastShot = (pg: SelfTestPage) => pg.shots[pg.shots.length - 1]

/** 列表里每页下面那一行：最后一条对话 */
function lastLine(pg: SelfTestPage): { text: string; ai: boolean } | null {
  const m = pg.thread[pg.thread.length - 1]
  if (!m) return null
  const body = [...(m.marks ?? []).map((k) => k.note.trim()).filter(Boolean), m.text].filter(Boolean).join('；') || '在截图上标了几处'
  return { text: `${m.who === 'ai' ? 'AI' : m.by || '我'}：${body}`, ai: m.who === 'ai' }
}

function groupPages(list: SelfTestPage[]): [string, SelfTestPage[]][] {
  const order = [...MODULES, ''] as string[]
  const m = new Map<string, SelfTestPage[]>()
  for (const pg of [...list].sort((a, b) => order.indexOf(a.module) - order.indexOf(b.module))) m.set(pg.module || '未分模块', [...(m.get(pg.module || '未分模块') ?? []), pg])
  return [...m]
}

/** 中间一栏：页面列表 */
export function SelfTestList(props: { project: Project; st: SelfTest; sel: string; onSelect: (id: string) => void; tab: ProjectTab; onTab: (t: ProjectTab) => void; run: Run; toast: Toast }) {
  const { project: p, st, run, toast } = props
  const [filter, setFilter] = useState<SelfTestStatus | 'all'>('all')
  const [menu, setMenu] = useState(false)
  const count = (s: SelfTestStatus) => st.pages.filter((x) => x.status === s).length
  const shown = st.pages.filter((x) => filter === 'all' || x.status === filter)
  const latest = st.pages.flatMap((x) => x.shots).sort((a, b) => b.at.localeCompare(a.at))[0]
  const copy = async (text: string) => {
    setMenu(false)
    await run('copy', text)
    toast('已复制，发给开发用的 AI')
  }

  return (
    <>
      <div className="phead">
        <div className="ptitle">
          <h2>{p.name}</h2>
          <span className="spacer" />
          <span className="more">
            <button className="btn sm" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              复制给 AI
            </button>
            {menu && (
              <>
                <span className="menu-scrim" onClick={() => setMenu(false)} />
                <span className="menu wide" role="menu">
                  <button role="menuitem" onClick={() => copy(uploadPrompt(p))}>
                    让 AI 把所有页面截图传上来
                  </button>
                  <button role="menuitem" onClick={() => copy(fixPrompt(p))} disabled={!count('issue')}>
                    让 AI 改有问题的页面{count('issue') ? `（${count('issue')}）` : ''}
                  </button>
                </span>
              </>
            )}
          </span>
        </div>
        <div className="psub">
          <span className="spill self">开发自测</span>
          <span>{latest ? `AI 最近上传 ${fmtTime(latest.at)} · ${latest.by}` : '还没有截图'}</span>
        </div>
        <ProjectTabs project={p} tab={props.tab} onTab={props.onTab} />
        {st.pages.length > 0 && (
          <div className="rbar">
            <span className="pick">
              {FILTERS.map(([k, l]) => (
                <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  {l} {k === 'all' ? st.pages.length : count(k)}
                </button>
              ))}
            </span>
          </div>
        )}
      </div>
      {st.pages.length === 0 ? (
        <div className="dempty">
          <b>还没有自测截图</b>
          <p className="note">让开发用的 AI（Claude Code、Codex 等，要用自测令牌接入 MCP）把 App 每个页面截图传上来。把下面这句发给它：</p>
          <div className="dquote">{uploadPrompt(p)}</div>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => copy(uploadPrompt(p))}>
              复制这句话
            </button>
          </div>
        </div>
      ) : (
        <ul className="feed">
          {groupPages(shown).map(([m, list]) => [
            <li className="grp" key={`g-${m}`}>
              <span>{m}</span>
              <span className="c">{list.length} 页</span>
              <span className="ln" />
            </li>,
            ...list.map((pg) => {
              const d = pg.design && p.designs?.find((x) => x.id === pg.design!.id)
              const line = lastLine(pg)
              const shot = lastShot(pg)
              return (
                <li className={`card${pg.id === props.sel ? ' on' : ''}`} key={pg.id}>
                  <button className="bug" aria-current={pg.id === props.sel} onClick={() => props.onSelect(pg.id)}>
                    <span className="thumb">{shot && <img src={selfUrl(p.id, shot.file)} alt="" loading="lazy" />}</span>
                    <span className="bug-b">
                      <span className="bug-top">
                        <span className="pg" style={{ color: 'var(--fg)', fontWeight: 600, fontSize: 13.5 }}>
                          {pg.name}
                        </span>
                        <span className="who">v{pg.shots.length}</span>
                        <span className={`spill ${pg.status}`}>{LABEL[pg.status]}</span>
                      </span>
                      <span className="lbl">{d ? `设计稿 · ${d.name}${pg.design!.score != null ? ` · ${Math.round(pg.design!.score * 100)}%` : ''}` : '没有对应的设计稿'}</span>
                      {line && <span className={`ai-line${line.ai ? ' ai-fixed' : ''}`} style={line.ai ? undefined : { color: 'var(--muted)' }}>{line.text}</span>}
                    </span>
                  </button>
                </li>
              )
            })
          ])}
          {!shown.length && <li className="empty">没有{FILTERS.find(([k]) => k === filter)?.[1]}的页面</li>}
        </ul>
      )}
    </>
  )
}

type Tool = 'pin' | 'rect'
const COLOR = MARK_COLORS[0]

/** 截图 + 评论点。可以评论时点一下钉一个评论点，或者拖出一个框 */
function Stage(props: { src: string; w: number; h: number; marks: Mark[]; edit: Tool | null; onAdd: (m: Mark) => void; ghost?: string }) {
  const { w, h } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<Mark | null>(null)
  const at = (e: ReactPointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect()
    return [((e.clientX - r.left) / r.width) * w, ((e.clientY - r.top) / r.height) * h]
  }
  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!props.edit) return
    // 不让点击把焦点抢走，新评论点的输入框才能自动聚焦
    e.preventDefault()
    const [x, y] = at(e)
    if (props.edit === 'pin') return props.onAdd({ kind: 'pin', color: COLOR, pts: [x, y, x, y], note: '' })
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ kind: 'rect', color: COLOR, pts: [x, y, x, y], note: '' })
  }
  const move = (e: ReactPointerEvent) => {
    if (!drag) return
    const [x, y] = at(e)
    setDrag({ ...drag, pts: [drag.pts[0], drag.pts[1], x, y] })
  }
  const up = () => {
    if (!drag) return
    if (!markTooSmall(drag, markStyle(w, h).sw)) {
      const [x1, y1, x2, y2] = drag.pts
      props.onAdd({ ...drag, pts: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)] })
    }
    setDrag(null)
  }
  // 截图上只画编号，评论写在下面，免得挡住画面
  const shown = [...props.marks, ...(drag ? [drag] : [])].map((m) => ({ ...m, note: '' }))
  return (
    <span className={`st-stage${props.edit ? ' editing' : ''}`}>
      <img src={props.src} alt="App 截图" draggable={false} />
      {props.ghost && <img className="ghost" src={props.ghost} alt="" />}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        dangerouslySetInnerHTML={{ __html: marksSvg(shown, w, h) }}
      />
    </span>
  )
}

/** 右边一栏：一个页面的详情 */
export function SelfTestDetail({ project: p, page: pg, run, toast }: { project: Project; page: SelfTestPage; run: Run; toast: Toast }) {
  const latest = pg.shots.length
  const [ver, setVer] = useState(latest)
  const [tool, setTool] = useState<Tool>('pin')
  const [cmp, setCmp] = useState<'side' | 'overlay'>('side')
  const [draft, setDraft] = useState<Mark[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const noteRefs = useRef<(HTMLInputElement | null)[]>([])

  // AI 传了新版本就跳到最新一版
  useEffect(() => setVer(latest), [latest])
  const prevLen = useRef(0)
  useEffect(() => {
    // 新加了一处就聚焦到它的评论框
    if (draft.length > prevLen.current) requestAnimationFrame(() => noteRefs.current[draft.length - 1]?.focus({ preventScroll: true }))
    prevLen.current = draft.length
  }, [draft.length])

  const shot = pg.shots[ver - 1]
  const isLatest = ver === latest
  const canComment = isLatest && pg.status !== 'pass'
  const sent = versionMarks(pg, ver)
  const d = pg.design ? p.designs?.find((x) => x.id === pg.design!.id) : undefined
  const src = shot ? selfUrl(p.id, shot.file) : ''
  const hasDraft = draft.length > 0 || !!text.trim()

  const send = async () => {
    if (!hasDraft || !shot) return
    setBusy(true)
    try {
      const marks = draft.map((m) => ({ ...m, note: m.note.trim() }))
      const png = marks.length ? await renderMarked(src, [...sent, ...marks], shot.width, shot.height) : null
      const ok = await run('self:comment', p.id, pg.id, text.trim(), marks, png)
      if (ok) {
        setDraft([])
        setText('')
        toast('已发给 AI。把“复制给 AI”里的话发给它，它就会来改')
      }
    } catch (err) {
      toast((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="detail self-detail">
      <div className="row">
        {pg.module && <span className="tag audit" style={{ marginLeft: 0 }}>{pg.module}</span>}
        <h3>{pg.name}</h3>
        <span className={`spill ${pg.status}`}>{LABEL[pg.status]}</span>
        <span className="spacer" />
        {latest > 1 && (
          <span className="seg" role="group" aria-label="版本">
            {pg.shots.map((_, i) => (
              <button key={i} aria-pressed={ver === i + 1} onClick={() => setVer(i + 1)}>
                v{i + 1}
              </button>
            ))}
          </span>
        )}
      </div>
      <p className="note" style={{ marginTop: -10 }}>
        {isLatest ? (latest > 1 ? `第 ${latest} 版，之前的版本可以切换查看` : '第一次上传') : `第 ${ver} 版（旧版本，只能看）`}
      </p>

      <div className="row">
        {canComment && (
          <span className="seg" role="group" aria-label="标注工具">
            <button aria-pressed={tool === 'pin'} onClick={() => setTool('pin')}>
              评论点
            </button>
            <button aria-pressed={tool === 'rect'} onClick={() => setTool('rect')}>
              框
            </button>
          </span>
        )}
        <span className="lbl" style={{ flex: 1 }}>
          {canComment ? (tool === 'pin' ? '点截图任意位置钉一个评论点' : '在截图上拖出一个框') : d ? '和设计稿对比' : ''}
        </span>
        {d && (
          <span className="seg" role="group" aria-label="对比方式">
            <button aria-pressed={cmp === 'side'} onClick={() => setCmp('side')}>
              并排
            </button>
            <button aria-pressed={cmp === 'overlay'} onClick={() => setCmp('overlay')}>
              叠加
            </button>
          </span>
        )}
      </div>

      <div className="cmp">
        {shot && (
          <figure>
            <Stage
              src={src}
              w={shot.width}
              h={shot.height}
              marks={canComment ? [...sent, ...draft] : sent}
              edit={canComment ? tool : null}
              onAdd={(m) => setDraft((x) => [...x, m])}
              ghost={d && cmp === 'overlay' ? designUrl(p.id, d.file) : undefined}
            />
            <figcaption>App 截图 v{ver}{d && cmp === 'overlay' ? ' · 叠了半透明设计稿' : ''}</figcaption>
          </figure>
        )}
        {d && cmp === 'side' && (
          <figure>
            <img src={designUrl(p.id, d.file)} alt={`设计稿 ${d.name}`} />
            <figcaption>设计稿 · {d.name}</figcaption>
          </figure>
        )}
      </div>
      <div className="row" style={{ marginTop: -6 }}>
        <span className="lbl">
          {d ? `设计稿：${designLabel(d)}（${pg.design!.score != null ? `自动匹配 ${Math.round(pg.design!.score * 100)}%` : '手动选择'}）` : '没找到对应的设计稿'}
        </span>
        {!!p.designs?.length && (
          <button className="btn sm" onClick={() => setPicking(true)}>
            {d ? '换一个' : '选一个'}
          </button>
        )}
      </div>

      {canComment && (
        <div className="st-compose">
          {draft.length > 0 && (
            <ul className="notes-list" style={{ flex: 'none' }}>
              {draft.map((m, i) => (
                <li key={i}>
                  <span className="st-no">{sent.length + i + 1}</span>
                  <input
                    ref={(el) => (noteRefs.current[i] = el)}
                    value={m.note}
                    placeholder={m.kind === 'pin' ? '这里有什么问题' : '框里有什么问题'}
                    aria-label={`第 ${sent.length + i + 1} 处的评论`}
                    onChange={(e) => setDraft((x) => x.map((k, j) => (j === i ? { ...k, note: e.target.value } : k)))}
                  />
                  <button className="x" aria-label="删掉这一处" onClick={() => setDraft((x) => x.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            className="in"
            rows={2}
            value={text}
            placeholder="写给 AI 的评论，比如：整页间距比设计稿大，按设计稿改"
            aria-label="评论"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send()
            }}
          />
          <div className="row">
            <span className="lbl" style={{ flex: 1 }}>
              {hasDraft ? '发出去后，AI 能看到截图上的评论点和设计稿' : pg.status === 'todo' ? '没问题就点“通过”' : '可以继续补充评论'}
            </span>
            {!hasDraft && pg.status === 'todo' && (
              <button className="btn ok" onClick={() => run('self:pass', p.id, pg.id, true)}>
                通过
              </button>
            )}
            <button className="btn primary" onClick={send} disabled={!hasDraft || busy}>
              {busy ? '正在发送…' : '发给 AI 修改'}
            </button>
          </div>
        </div>
      )}
      {isLatest && pg.status === 'issue' && <p className="note st-wait">已发给 AI，等它改完重新截图。可以在“复制给 AI”里复制一句话发给它。</p>}
      {isLatest && pg.status === 'pass' && (
        <div className="row">
          <span className="spill pass">已通过</span>
          <span className="lbl">
            {pg.passedBy} · {pg.passedAt ? fmtTime(pg.passedAt) : ''}
          </span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => run('self:pass', p.id, pg.id, false)}>
            撤销
          </button>
        </div>
      )}

      <div className="st-thread">
        <span className="lbl">对话 {pg.thread.length || ''}</span>
        {!pg.thread.length && <p className="note">还没有评论。点截图钉一个评论点，或者直接写。</p>}
        {pg.thread.map((m) => {
          const base = m.who === 'me' ? marksBefore(pg, m).length : 0
          return (
            <div key={m.id} className={`st-msg ${m.who}`}>
              <div className="row" style={{ gap: 8 }}>
                <b>{m.who === 'ai' ? `AI · ${m.by}` : m.by || '我'}</b>
                <button className="st-ver" onClick={() => setVer(m.ver)} title="看这一版截图">
                  v{m.ver}
                </button>
                <span className="mono">{fmtTime(m.at)}</span>
              </div>
              {m.marks?.map((k, i) => (
                <div key={i} className="st-mk">
                  <span className="st-no">{base + i + 1}</span>
                  <span>{k.note || (k.kind === 'pin' ? '（这里）' : '（框里）')}</span>
                </div>
              ))}
              {m.text && <p>{m.text}</p>}
            </div>
          )
        })}
      </div>

      {shot && (
        <div className="kv st-info">
          <span className="k">上传</span>
          <span>
            {shot.by} · {fmtTime(shot.at)}
          </span>
          <span />
          {shot.device && (
            <>
              <span className="k">设备</span>
              <span>{shot.device}</span>
              <span />
            </>
          )}
          {shot.activity && (
            <>
              <span className="k">Activity</span>
              <span className="mono">{shot.activity}</span>
              <span />
            </>
          )}
        </div>
      )}
      <div>
        <button
          className="btn sm danger"
          onClick={async () => {
            await run('self:delete', p.id, pg.id, pg.name)
          }}
        >
          删除这一页
        </button>
      </div>

      {picking && (
        <DesignPicker
          project={p}
          current={pg.design?.id ?? ''}
          onClose={() => setPicking(false)}
          onPick={async (x) => {
            setPicking(false)
            await run('self:design', p.id, pg.id, x?.id ?? null)
          }}
        />
      )}
    </div>
  )
}
