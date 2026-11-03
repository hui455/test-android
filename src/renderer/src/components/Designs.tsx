import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { shotFile } from '@shared/annotate'
import { CANVAS, layoutCanvas } from '@shared/canvas'
import { designLabel } from '@shared/logic'
import { AUTO_MATCH, type Candidate } from '@shared/match'
import type { Bug, BugDesign, Design, Project } from '@shared/types'
import { designUrl, shotUrl } from '../api'
import type { Run, Toast } from '../App'
import { Modal } from './Modal'
import { SelfCtx } from './selfCtx'
import { fitView, PanZoom, type View } from './PanZoom'
import { fmtTime } from './util'

export type ProjectTab = 'feed' | 'design' | 'self'

const pct = (n: number) => `${Math.round(n * 100)}%`

/** 发给接了 Figma 的 AI，让它通过 BugShot MCP 上传设计稿 */
/** 旧数据没有画板位置时，让 AI 补上，画布才能照 Figma 排版 */
export const positionPrompt = (p: Project) =>
  `用 Figma MCP 的 get_metadata 读出这个 Figma 文件每个页面下顶层画板的 x/y/width/height，再用 BugShot MCP 的 set_design_positions 同步到项目“${p.name}”（design 填“页面名/画板名”）：${p.figma?.url || '[Figma 链接]'}`

export const syncPrompt = (p: Project) =>
  `把这个 Figma 文件按页面拆开，每个页面下的手机界面画板导出成图片，连同画板在 Figma 里的位置和大小（x/y/width/height），用 BugShot MCP 的 upload_designs 上传到项目“${p.name}”：${p.figma?.url || '[Figma 链接]'}`

export function groupDesigns(list: Design[]): [string, Design[]][] {
  const m = new Map<string, Design[]>()
  for (const d of list) m.set(d.page || '未分页', [...(m.get(d.page || '未分页') ?? []), d])
  return [...m]
}

export function ProjectTabs({ project: p, tab, onTab }: { project: Project; tab: ProjectTab; onTab: (t: ProjectTab) => void }) {
  // 开发自测：只有填了自测令牌、项目打开了开发自测才出现
  const self = useContext(SelfCtx)
  return (
    <div className="ptabs" role="tablist" aria-label="项目内容">
      {self.dev && self.on && (
        <button role="tab" aria-selected={tab === 'self'} onClick={() => onTab('self')}>
          开发自测 <span className="c">{self.count}</span>
        </button>
      )}
      <button role="tab" aria-selected={tab === 'feed'} onClick={() => onTab('feed')}>
        反馈 <span className="c">{p.bugs.length}</span>
      </button>
      <button role="tab" aria-selected={tab === 'design'} onClick={() => onTab('design')}>
        设计稿 <span className="c">{p.designs?.length ?? 0}</span>
      </button>
    </div>
  )
}

function Thumb({ p, d, className = 'dthumb' }: { p: Project; d: Design; className?: string }) {
  return (
    <span className={className}>
      <img src={designUrl(p.id, d.file)} alt="" loading="lazy" />
    </span>
  )
}

type DesignView = 'list' | 'canvas'
const VIEW_KEY = 'bugshot.designView'
const readView = (): DesignView => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'canvas' ? 'canvas' : 'list'
  } catch {
    return 'list'
  }
}

/** 项目的“设计稿”页：按 Figma 页面分组列出画板，或者像 Figma 那样平铺在画布上 */
export function DesignPane(props: { project: Project; tab: ProjectTab; onTab: (t: ProjectTab) => void; run: Run; toast: Toast; onShowBug?: (b: Bug) => void }) {
  const { project: p, tab, onTab, run, toast } = props
  const designs = p.designs ?? []
  const [open, setOpen] = useState<Design | null>(null)
  const [mode, setModeState] = useState<DesignView>(readView)
  const setMode = (m: DesignView) => {
    setModeState(m)
    try {
      localStorage.setItem(VIEW_KEY, m)
    } catch {
      // 存不了就只在这次生效
    }
  }
  const last = [...designs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const copySync = async () => {
    await run('copy', syncPrompt(p))
    toast('已复制，发给接了 Figma 的 AI 即可')
  }
  const add = async () => {
    const n = await run<number>('design:add', p.id)
    if (n) toast(`已添加 ${n} 张设计稿`)
  }

  return (
    <>
      <div className="phead tabs-only">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>{p.name}</h2>
        </div>
        <ProjectTabs project={p} tab={tab} onTab={onTab} />
      </div>
      {designs.length === 0 ? (
        <div className="dempty">
          <b>还没有设计稿</b>
          <p className="note">让接了 Figma 的 AI（Claude Code、Codex 等）通过 BugShot MCP 上传。把下面这句发给它，换上你的 Figma 链接：</p>
          <div className="dquote">{syncPrompt(p)}</div>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={copySync}>
              复制这句话
            </button>
            <button className="btn" onClick={add}>
              手动添加图片
            </button>
          </div>
        </div>
      ) : (
        <div className={`dbody${mode === 'canvas' ? ' canvas' : ''}`}>
          <div className="dsrc">
            <span>
              {p.figma?.name ? (
                <>
                  来自 Figma 文件 <b>{p.figma.name}</b>
                </>
              ) : (
                `${designs.length} 张设计稿`
              )}
              {last && (
                <span className="mono">
                  {' '}
                  · {last.uploadedBy || '未知'} 于 {fmtTime(last.updatedAt)} 更新
                </span>
              )}
            </span>
            <span className="spacer" />
            {p.figma?.url && (
              <a href={p.figma.url} target="_blank" rel="noreferrer">
                在 Figma 打开
              </a>
            )}
            <button className="btn sm" onClick={copySync} title="复制一句话，发给 AI 让它重新上传">
              让 AI 重新同步
            </button>
            <button className="btn sm" onClick={add}>
              手动添加图片
            </button>
            <span className="pick sm" role="group" aria-label="查看方式">
              <button aria-pressed={mode === 'list'} onClick={() => setMode('list')}>
                列表
              </button>
              <button aria-pressed={mode === 'canvas'} onClick={() => setMode('canvas')}>
                画布
              </button>
            </span>
          </div>
          {mode === 'canvas' && (
            <DesignCanvas
              project={p}
              onOpen={setOpen}
              onShowBug={props.onShowBug}
              onCopyPositions={async () => {
                await run('copy', positionPrompt(p))
                toast('已复制，发给接了 Figma 的 AI，同步后画布会照 Figma 排版')
              }}
            />
          )}
          {mode === 'list' && groupDesigns(designs).map(([page, list]) => (
            <section key={page} className="dgroup">
              <h4>
                {page} <span className="c">{list.length} 个画板</span>
              </h4>
              <div className="dgrid">
                {list.map((d) => {
                  const n = p.bugs.filter((b) => b.design?.id === d.id).length
                  return (
                    <button key={d.id} className="dcard" onClick={() => setOpen(d)}>
                      <Thumb p={p} d={d} />
                      <span className="dname">{d.name}</span>
                      <span className="mono">{n ? `${n} 条反馈` : d.module || ' '}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
      {open && (
        <Modal className="dview" label={`设计稿 ${open.name}`} onClose={() => setOpen(null)}>
          <div className="dview-img">
            <img src={designUrl(p.id, open.file)} alt={open.name} />
          </div>
          <div className="dview-side">
            <h3>{open.name}</h3>
            <dl className="fields">
              <dt>页面</dt>
              <dd>{open.page || '未分页'}</dd>
              <dt>模块</dt>
              <dd>{open.module || '未指定'}</dd>
              <dt>尺寸</dt>
              <dd>
                {open.width} × {open.height}
              </dd>
              <dt>上传</dt>
              <dd>
                {open.uploadedBy || '未知'} · {fmtTime(open.updatedAt)}
              </dd>
              <dt>反馈</dt>
              <dd>
                {p.bugs
                  .filter((b) => b.design?.id === open.id)
                  .map((b) => `#${b.seq}`)
                  .join('、') || '没有关联'}
              </dd>
            </dl>
            <div className="row">
              {open.figmaUrl && (
                <a className="btn sm" href={open.figmaUrl} target="_blank" rel="noreferrer">
                  在 Figma 打开
                </a>
              )}
              <DeleteButton
                onDelete={async () => {
                  if (await run('design:delete', p.id, open.id)) {
                    setOpen(null)
                    toast('已删除设计稿')
                  }
                }}
              />
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [sure, setSure] = useState(false)
  return (
    <button className="btn sm danger" onClick={() => (sure ? onDelete() : setSure(true))} onBlur={() => setSure(false)}>
      {sure ? '再点一次确认删除' : '删除'}
    </button>
  )
}

/** 选设计页：搜索 + 按页面分组的缩略图 */
export function DesignPicker({ project: p, current, onPick, onClose }: { project: Project; current: string; onPick: (d: Design | null) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const list = (p.designs ?? []).filter((d) => `${d.page} ${d.name}`.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <Modal className="dpick" label="选择设计页" onClose={onClose}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>选择对应的设计页</h3>
        <input className="in" autoFocus placeholder="搜画板名" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜画板名" />
      </div>
      <div className="dbody" style={{ padding: 0 }}>
        {groupDesigns(list).map(([page, ds]) => (
          <section key={page} className="dgroup">
            <h4>{page}</h4>
            <div className="dgrid">
              {ds.map((d) => (
                <button key={d.id} className="dcard" aria-pressed={d.id === current} onClick={() => onPick(d)}>
                  <Thumb p={p} d={d} />
                  <span className="dname">{d.name}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
        {!list.length && <div className="empty">没有找到</div>}
      </div>
      <div className="actions">
        {current && (
          <button className="btn" onClick={() => onPick(null)}>
            不关联设计页
          </button>
        )}
        <button className="btn" onClick={onClose}>
          取消
        </button>
      </div>
    </Modal>
  )
}

/**
 * 记反馈时的“对应设计页”：截图后自动比对，相似度够高就直接选上。
 * onPick 返回的 auto 表示是自动匹配的（相似度够高）。
 */
export function DesignMatch(props: { project: Project; captureId: string | null; value: BugDesign | null; onPick: (d: Design | null, score: number | null) => void; run: Run }) {
  const { project: p, value, run } = props
  const designs = p.designs ?? []
  const [cands, setCands] = useState<Candidate[] | null>(null)
  const [picker, setPicker] = useState(false)
  const [auto, setAuto] = useState(false)

  useEffect(() => {
    setCands(null)
    setAuto(false)
    if (!props.captureId || !designs.length) return
    let alive = true
    void run<Candidate[]>('design:match', p.id, props.captureId).then((list) => {
      if (!alive || !list) return
      setCands(list)
      const top = list[0]
      const d = top && designs.find((x) => x.id === top.id)
      if (d && top.score >= AUTO_MATCH) {
        setAuto(true)
        props.onPick(d, top.score)
      }
    })
    return () => {
      alive = false
    }
    // 只在换了截图时重新比对
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.captureId])

  const byId = useMemo(() => new Map(designs.map((d) => [d.id, d])), [designs])
  if (!designs.length) return null
  const sel = value ? byId.get(value.id) : undefined
  const shown = (cands ?? []).filter((c) => byId.has(c.id))
  // 手动选的不在候选里时也显示出来
  const extra = sel && !shown.some((c) => c.id === sel.id) ? [{ id: sel.id, score: value?.score ?? null }] : []

  return (
    <div className="dmatch">
      <div className="row">
        <b>对应设计页</b>
        {auto && sel && value?.score != null && <span className="tag fxd">已自动匹配</span>}
        {cands && !auto && !sel && <span className="tag pend">没有很像的，请手动选</span>}
        {props.captureId && !cands && <span className="mono">正在比对…</span>}
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={() => setPicker(true)}>
          {shown.length ? '其他画板' : '选择画板'}
        </button>
      </div>
      {(shown.length > 0 || extra.length > 0) && (
        <div className="dcands">
          {[...extra, ...shown].map((c) => {
            const d = byId.get(c.id)!
            const on = d.id === sel?.id
            return (
              <button
                type="button"
                key={c.id}
                className="dcand"
                aria-pressed={on}
                onClick={() => {
                  setAuto(false)
                  props.onPick(on ? null : d, on ? null : c.score)
                }}
              >
                <Thumb p={p} d={d} className="dthumb sm" />
                <span className="dcand-t">
                  <b>{d.name}</b>
                  <span className="mono">{d.page}</span>
                  {c.score != null && <span className={`score ${c.score >= AUTO_MATCH ? 'hi' : c.score >= 0.6 ? 'mid' : ''}`}>相似度 {pct(c.score)}</span>}
                  {on && <span className="okc">✓ 已选</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {!shown.length && !extra.length && !props.captureId && <p className="note">没有截图时可以手动选一个画板，方便和设计稿对比。</p>}
      {sel && <p className="note">选中后，“页面”会填成画板名，模块按设计稿的页面自动选好。</p>}
      {picker && (
        <DesignPicker
          project={p}
          current={sel?.id ?? ''}
          onClose={() => setPicker(false)}
          onPick={(d) => {
            setPicker(false)
            setAuto(false)
            props.onPick(d, d ? (cands?.find((c) => c.id === d.id)?.score ?? null) : null)
          }}
        />
      )}
    </div>
  )
}

type CompareMode = 'side' | 'overlay' | 'swap'

/** 详情里和设计稿对比：并排、叠加、来回切换 */
export function DesignCompare(props: { project: Project; bug: Bug; design: Design; big?: boolean; initial?: { mode: CompareMode; alpha: number }; onClose?: () => void }) {
  const { project: p, bug: b, design: d, big } = props
  const [mode, setMode] = useState<CompareMode>(props.initial?.mode ?? 'side')
  const [alpha, setAlpha] = useState(props.initial?.alpha ?? 50)
  const [showDesign, setShowDesign] = useState(false)
  const [zoom, setZoom] = useState(false)
  const [view, setView] = useState<View>({ z: 1, x: 0, y: 0 })
  const stage = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const shot = b.shots.find((s) => !s.ref)
  const shotSrc = shot ? shotUrl(p.id, shotFile(shot)) : ''
  const designSrc = designUrl(p.id, d.file)

  useEffect(() => {
    if (mode !== 'swap') return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      // 放大窗口打开时只让放大窗口里的那份响应空格
      if (e.key !== ' ' || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName) || (!big && document.querySelector('.scrim'))) return
      e.preventDefault()
      setShowDesign((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, big])

  const fit = () => {
    const r = stage.current?.getBoundingClientRect()
    const c = content.current
    if (r && c && c.offsetWidth) setView(fitView(r, c.offsetWidth, c.offsetHeight, 24, 1.5))
  }
  // 放大后图片加载完整个放进窗口；切换对比方式时也重新放
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!big) return
    const t = setTimeout(fit, 120)
    return () => clearTimeout(t)
  }, [big, mode])

  if (!shot)
    return (
      <div className="cmp">
        <figure>
          <img src={designSrc} alt={`设计稿 ${d.name}`} />
          <figcaption>设计稿 · {d.name}</figcaption>
        </figure>
      </div>
    )

  const modes = (
    <span className="seg" role="group" aria-label="对比方式">
      {(
        [
          ['side', '并排'],
          ['overlay', '叠加'],
          ['swap', '来回切换']
        ] as [CompareMode, string][]
      ).map(([m, l]) => (
        <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
          {l}
        </button>
      ))}
    </span>
  )
  const alphas = mode === 'overlay' && (
    <>
      <span className="lbl">设计稿透明度</span>
      <span className="pick sm">
        {[30, 50, 80].map((n) => (
          <button key={n} aria-pressed={alpha === n} onClick={() => setAlpha(n)}>
            {n}%
          </button>
        ))}
      </span>
    </>
  )
  const body = (
    <>
      {mode === 'side' && (
        <div className="cmp">
          <figure>
            <img src={shotSrc} alt="实际截图" draggable={false} onLoad={big ? fit : undefined} />
            <figcaption>实际截图{shot.marks?.length ? '（含标注）' : ''}</figcaption>
          </figure>
          <figure>
            <img src={designSrc} alt={`设计稿 ${d.name}`} draggable={false} onLoad={big ? fit : undefined} />
            <figcaption>设计稿 · {d.name}</figcaption>
          </figure>
        </div>
      )}
      {mode === 'overlay' && (
        <div className="cmp">
          <figure className="stack">
            <img src={shotSrc} alt="实际截图" draggable={false} onLoad={big ? fit : undefined} />
            <img className="ghost" src={designSrc} alt="" draggable={false} style={{ opacity: alpha / 100 }} />
            <figcaption>按宽度对齐叠在一起，差异处一眼能看出来</figcaption>
          </figure>
        </div>
      )}
      {mode === 'swap' && (
        <div className="cmp">
          <figure>
            <figcaption>正在看：{showDesign ? '设计稿' : '实际截图'}（空格键切换）</figcaption>
            <img src={showDesign ? designSrc : shotSrc} alt={showDesign ? '设计稿' : '实际截图'} draggable={false} onLoad={big ? fit : undefined} />
          </figure>
        </div>
      )}
    </>
  )

  // 全屏放大：保持当前的对比方式，可以滚轮缩放、拖动
  if (big)
    return (
      <div className="cmpbig">
        <div className="cmpbig-bar">
          <b>{d.name} · 截图和设计稿</b>
          {modes}
          {alphas}
          {mode === 'swap' && (
            <button className="btn sm" onClick={() => setShowDesign((v) => !v)}>
              切换
            </button>
          )}
          <span className="spacer" />
          <span className="mono">滚轮缩放 · 拖动 · Esc 关闭</span>
          <button className="btn sm" onClick={fit}>
            适合窗口
          </button>
          <button className="btn sm icon" aria-label="关闭" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="cmpbig-stage" ref={stage}>
          <PanZoom view={view} onView={setView} min={0.2} max={6}>
            <div ref={content} className="cmpbig-content">
              {body}
            </div>
          </PanZoom>
        </div>
      </div>
    )

  return (
    <div className="cmpwrap">
      <div className="row">
        <span className="lbl">和设计稿对比</span>
        <span className="spacer" />
        {modes}
        <button className="btn sm" onClick={() => setZoom(true)} title="全屏看，可以缩放">
          ⤢ 放大
        </button>
      </div>
      {alphas && <div className="row" style={{ justifyContent: 'center' }}>{alphas}</div>}
      {mode === 'swap' && (
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn sm" onClick={() => setShowDesign((v) => !v)}>
            切换截图 / 设计稿
          </button>
        </div>
      )}
      <div className="cmp-click" onClick={() => setZoom(true)} title="点击放大">
        {body}
      </div>
      {zoom && (
        <Modal className="cmpzoom" label="对比放大" onClose={() => setZoom(false)}>
          <DesignCompare project={p} bug={b} design={d} big initial={{ mode, alpha }} onClose={() => setZoom(false)} />
        </Modal>
      )}
    </div>
  )
}

export const designLine = (b: Bug, d: Design) => `${designLabel(d)}${b.design?.score != null ? `（自动匹配 ${pct(b.design.score)}）` : '（手动选择）'}`

/** 设计稿画布：滚轮缩放、按住拖动，点画板看名字和相关反馈，双击看大图 */
function DesignCanvas({ project: p, onOpen, onShowBug, onCopyPositions }: { project: Project; onOpen: (d: Design) => void; onShowBug?: (b: Bug) => void; onCopyPositions: () => void }) {
  const designs = p.designs ?? []
  const layout = useMemo(() => layoutCanvas(groupDesigns(designs)), [designs])
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ z: 0.6, x: 24, y: 24 })
  const [q, setQ] = useState('')
  const [sel, setSel] = useState('')
  const fit = () => {
    const pz = box.current?.querySelector('.panzoom')?.getBoundingClientRect()
    if (pz) setView(fitView(pz, layout.width, layout.height))
  }
  // 第一次打开时整个放进窗口
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fit, [p.id])
  const bugsOf = (id: string) => p.bugs.filter((b) => b.design?.id === id)
  const kw = q.trim().toLowerCase()
  const cur = designs.find((d) => d.id === sel)
  const zoom = (k: number) => {
    const r = box.current?.querySelector('.panzoom')?.getBoundingClientRect()
    if (!r) return
    const z = Math.min(4, Math.max(0.1, view.z * k))
    // 以画面中心缩放
    setView({ z, x: r.width / 2 - ((r.width / 2 - view.x) * z) / view.z, y: r.height / 2 - ((r.height / 2 - view.y) * z) / view.z })
  }

  return (
    <div className="dcanvas" ref={box}>
      <div className="dcanvas-bar">
        <input className="in" placeholder="搜画板名" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜画板名" />
        <span className="zoombox">
          <button onClick={() => zoom(1 / 1.25)} aria-label="缩小">
            −
          </button>
          <span>{Math.round(view.z * 100)}%</span>
          <button onClick={() => zoom(1.25)} aria-label="放大">
            +
          </button>
        </span>
        <button className="btn sm" onClick={fit}>
          适合窗口
        </button>
        {designs.some((d) => !d.box) && (
          <span className="dc-nopos">
            {designs.every((d) => !d.box) ? '还没有 Figma 里的位置，先按网格排' : '部分画板没有 Figma 里的位置，排在后面'}
            <button className="btn sm" onClick={onCopyPositions}>
              复制给 AI 同步位置
            </button>
          </span>
        )}
      </div>
      <PanZoom view={view} onView={setView}>
        <div style={{ width: layout.width, height: layout.height, position: 'relative' }}>
          {layout.pages.map((r) => (
            <div key={r.page} className="dc-page" style={{ left: r.x, top: r.y }}>
              {r.page}
            </div>
          ))}
          {layout.pages.flatMap((r) =>
            r.boards.map(({ d, x, y, w, h }) => {
              const n = bugsOf(d.id).length
              const hit = kw && `${d.page} ${d.name}`.toLowerCase().includes(kw)
              return (
                <button
                  key={d.id}
                  className={`dc-board${d.id === sel ? ' on' : ''}${hit ? ' hit' : ''}${kw && !hit ? ' dim' : ''}`}
                  style={{ left: x, top: y - CANVAS.NAME_H, width: w }}
                  onClick={() => setSel(d.id === sel ? '' : d.id)}
                  onDoubleClick={() => onOpen(d)}
                  title={`${d.name}（双击看大图）`}
                >
                  <span className="dc-name">{d.name}</span>
                  <span className="dc-img" style={{ height: h }}>
                    <img src={designUrl(p.id, d.file)} alt="" loading="lazy" draggable={false} />
                  </span>
                  {n > 0 && <span className="dc-badge">{n}</span>}
                </button>
              )
            })
          )}
        </div>
      </PanZoom>
      {cur && (
        <div className="dc-pop">
          <b>{cur.name}</b>
          <span className="mono">
            {cur.page || '未分页'} · {bugsOf(cur.id).length ? `${bugsOf(cur.id).length} 条反馈` : '没有反馈'}
          </span>
          {onShowBug && bugsOf(cur.id).length > 0 && (
            <div className="dc-bugs">
              {bugsOf(cur.id).map((b) => (
                <button key={b.id} onClick={() => onShowBug(b)} title={b.text}>
                  #{b.seq} {b.text}
                </button>
              ))}
            </div>
          )}
          <div className="row">
            <button className="btn sm primary" onClick={() => onOpen(cur)}>
              看大图
            </button>
            <button className="btn sm" onClick={() => setSel('')}>
              关闭
            </button>
          </div>
        </div>
      )}
      <span className="dc-hint">滚轮缩放 · 按住拖动 · 双击画板看大图</span>
    </div>
  )
}
