import { useEffect, useRef, useState } from 'react'
import { MARK_COLORS, markNo, marksText } from '@shared/annotate'
import { appendPhrase, pageSuggestions, phraseGroup, rankedPhrases } from '@shared/logic'
import { MODULES, type Bug, type BugDesign, type Design, type Mark, type MarkKind, type Mode, type Module, type Project, type Settings } from '@shared/types'
import type { Capture } from '../api'
import type { Run, Toast } from '../App'
import { Annotator, renderMarked } from './Annotator'
import { DesignMatch } from './Designs'
import { COLOR_NAMES, loadImage, MarkCanvas, noColor, TOOLS, ToolIcon } from './MarkCanvas'
import { Modal } from './Modal'
import { deviceName } from './util'

export interface ComposeTarget {
  capture: Capture | null
  /** 对标机的截图 */
  refCapture?: Capture | null
  /** 编辑已有反馈时传入 */
  edit?: Bug
}

/** 保存后接着做什么：截下一张 / 再记一条纯文字 / 关掉 */
export type ComposeNext = 'shot' | 'text' | null

/** 上一条反馈的模块、环境、页面，按项目记在本机，重启后也沿用 */
interface Last {
  module?: Module
  mode?: Mode
  page?: string
}
const lastKey = (projectId: string) => `bugshot.last.${projectId}`
function readLast(projectId: string): Last {
  try {
    const v = JSON.parse(localStorage.getItem(lastKey(projectId)) ?? '{}') as Last
    return {
      module: MODULES.includes(v.module as Module) ? v.module : undefined,
      mode: v.mode === 'audit' || v.mode === 'online' || v.mode === '' ? v.mode : undefined,
      page: typeof v.page === 'string' ? v.page : undefined
    }
  } catch {
    return {}
  }
}
function writeLast(projectId: string, v: Last) {
  try {
    localStorage.setItem(lastKey(projectId), JSON.stringify(v))
  } catch {
    /* 存不了就算了，只是下次少沿用一次 */
  }
}

const isTyping = (t: EventTarget | null) => {
  const tag = (t as HTMLElement | null)?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function ComposeDialog(props: {
  project: Project
  target: ComposeTarget
  settings: Settings
  run: Run
  toast: Toast
  serial: string
  refSerial: string
  onClose: () => void
  onSaved: (bugId: string, next: ComposeNext) => void
}) {
  const { project: p, settings, run, toast, target } = props
  const edit = target.edit
  const [last] = useState(() => (edit ? {} : readLast(p.id)))
  const [capture, setCapture] = useState<Capture | null>(target.capture)
  const [mod, setMod] = useState<Module>(edit?.module ?? last.module ?? 'tab1')
  const [modFrom, setModFrom] = useState<'' | 'last' | 'design'>(last.module ? 'last' : '')
  const [page, setPage] = useState(edit?.page ?? last.page ?? '')
  const [mode, setMode] = useState<Mode>(edit?.mode ?? last.mode ?? '')
  const [modeFrom, setModeFrom] = useState<'' | 'last'>(last.mode ? 'last' : '')
  // “问题”：没自己改过时，由标注评论自动拼出来
  const [text, setText] = useState(edit?.text ?? '')
  const [textAuto, setTextAuto] = useState(!edit)
  const [adding, setAdding] = useState(false)
  const [newPhrase, setNewPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  // 截图上的圈画，直接在左边画；保存时再画成带标注的图
  const [marks, setMarks] = useState<Mark[]>([])
  const [sel, setSel] = useState(-1)
  const [tool, setTool] = useState<MarkKind>('rect')
  const [color, setColor] = useState(MARK_COLORS[0])
  const [annotating, setAnnotating] = useState(false)
  const [design, setDesign] = useState<BugDesign | null>(edit?.design ?? null)
  // 上次自动填进“页面”的值（沿用上一条或设计稿画板名）：测试人员自己改过页面就不再覆盖
  const autoPage = useRef<string | null>(edit ? null : (last.page ?? null))
  const [pageFrom, setPageFrom] = useState<'' | 'last' | 'design'>(last.page ? 'last' : '')
  const pickDesign = (d: Design | null, score: number | null) => {
    setDesign(d ? { id: d.id, score } : null)
    if (!d) return
    setPage((cur) => {
      if (cur.trim() && cur !== autoPage.current) return cur
      autoPage.current = d.name
      setPageFrom('design')
      return d.name
    })
    if (d.module) {
      setMod(d.module)
      setModFrom('design')
    }
  }
  const textRef = useRef<HTMLTextAreaElement>(null)
  const noteRefs = useRef<(HTMLInputElement | null)[]>([])
  const focusNote = useRef(-1)
  const capRef = useRef(capture)
  capRef.current = capture
  const [refCap, setRefCap] = useState<Capture | null>(target.refCapture ?? null)
  const refCapRef = useRef(refCap)
  refCapRef.current = refCap

  // 有截图时先画，焦点留给画布；纯文字直接写问题
  useEffect(() => {
    if (!target.capture) textRef.current?.focus()
  }, [target.capture])
  // 新画的一处，光标跳到它的评论框
  useEffect(() => {
    if (focusNote.current >= 0) {
      noteRefs.current[focusNote.current]?.focus()
      focusNote.current = -1
    }
  }, [marks.length])
  // 关闭时丢掉没保存的截图
  useEffect(
    () => () => {
      if (capRef.current) void run('discard-capture', capRef.current.id)
      if (refCapRef.current) void run('discard-capture', refCapRef.current.id)
    },
    [run]
  )
  const shootRef = async () => {
    const old = refCapRef.current
    const c = await run<Capture>('capture', props.refSerial)
    if (!c) return
    if (old) void run('discard-capture', old.id)
    setRefCap(c)
  }
  const dropRef = () => {
    if (refCap) void run('discard-capture', refCap.id)
    setRefCap(null)
  }

  const group = phraseGroup(mod)
  const phrases = rankedPhrases(group, settings.customPhrases[group], settings.phraseUsage)
  const pages = pageSuggestions(p, mod)

  const shoot = async () => {
    const old = capRef.current
    const c = await run<Capture>('capture', props.serial)
    if (!c) return
    if (old) void run('discard-capture', old.id)
    setCapture(c)
    setMarks([])
    setSel(-1)
  }
  const dropShot = () => {
    if (capture) void run('discard-capture', capture.id)
    setCapture(null)
    setMarks([])
    setSel(-1)
  }

  const autoText = marksText(marks)
  const shownText = textAuto ? autoText : text
  const setNote = (i: number, note: string) => setMarks((ms) => ms.map((m, k) => (k === i ? { ...m, note } : m)))
  const removeMark = (i: number) => {
    setMarks((ms) => ms.filter((_, k) => k !== i))
    setSel(-1)
  }

  /** 常用短语：选中了某处标注就填进它的评论，否则填进“问题” */
  const usePhrase = (t: string) => {
    void run('phrase:used', t)
    if (sel >= 0 && marks[sel]) {
      setNote(sel, appendPhrase(marks[sel].note, t))
      noteRefs.current[sel]?.focus()
      return
    }
    setText(appendPhrase(shownText, t))
    setTextAuto(false)
    textRef.current?.focus()
  }
  const addPhrase = async () => {
    const v = newPhrase.trim()
    setAdding(false)
    setNewPhrase('')
    textRef.current?.focus()
    if (!v) return
    const list = settings.customPhrases[group]
    if (list.includes(v)) return
    await run('settings:update', { customPhrases: { ...settings.customPhrases, [group]: [...list, v] } })
    toast(`已添加自定义短语“${v}”`)
  }
  const removePhrase = (v: string) =>
    run('settings:update', { customPhrases: { ...settings.customPhrases, [group]: settings.customPhrases[group].filter((x) => x !== v) } })

  const save = async (next: boolean) => {
    // 自己写的问题清空了，就退回用标注评论
    const finalText = shownText.trim() || autoText
    if (!finalText.trim()) {
      toast(marks.length ? '给标注写一句评论，或者在“问题”里写一下' : '写一下是什么问题')
      if (marks.length) noteRefs.current[0]?.focus()
      else textRef.current?.focus()
      return
    }
    setBusy(true)
    const input = { module: mod, page, text: finalText, mode, design }
    let bug: Bug | undefined
    if (edit) bug = await run<Bug>('bug:update', p.id, edit.id, input)
    else {
      let marked: { marks: Mark[]; png: string } | undefined
      if (capture && marks.length) {
        try {
          const clean = marks.map((m) => ({ ...m, note: m.note.trim() }))
          const img = await loadImage(capture.dataUrl)
          marked = { marks: clean, png: await renderMarked(capture.dataUrl, clean, img.naturalWidth, img.naturalHeight) }
        } catch (err) {
          setBusy(false)
          return toast(`画标注失败：${(err as Error).message}`)
        }
      }
      bug = await run<Bug>('bug:add', p.id, input, capture?.id ?? null, marked, refCap?.id ?? null)
    }
    setBusy(false)
    if (!bug) return
    if (!edit) {
      capRef.current = null // 已经保存，不要丢弃
      refCapRef.current = null
      writeLast(p.id, { module: mod, mode, page })
    }
    toast(edit ? '已保存修改' : `已记到 ${p.name} 第${p.rounds.length}轮 · ${mod}`)
    props.onSaved(bug.id, next ? (capture ? 'shot' : 'text') : null)
  }

  // 快捷键：Ctrl+Enter 保存，Ctrl+Shift+Enter 保存并截下一张，Alt+数字 填常用短语；
  // 不在输入框里时 R/O/A/P 换画图工具，Ctrl+Z 撤销，Delete 删掉选中的标注
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e) => {
    if (annotating || busy) return
    const mod1 = e.ctrlKey || e.metaKey
    if (mod1 && e.key === 'Enter') {
      e.preventDefault()
      void save(e.shiftKey && !edit)
      return
    }
    // 用 code 判断数字键：macOS 上 Option+数字打出来的是特殊符号
    const digit = /^Digit([1-9])$/.exec(e.code)
    if (e.altKey && !mod1 && digit) {
      const ph = phrases[Number(digit[1]) - 1]
      if (ph) {
        e.preventDefault()
        usePhrase(ph.text)
      }
      return
    }
    if (!capture || edit || isTyping(e.target)) return
    if (mod1 && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      setMarks((ms) => ms.slice(0, -1))
      setSel(-1)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0) {
      e.preventDefault()
      removeMark(sel)
    } else if (!mod1 && !e.altKey) {
      const t = TOOLS.find(([, , k]) => k === e.key.toUpperCase())
      if (t) setTool(t[0])
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const d = capture?.device
  const drawing = !edit && !!capture
  return (
    <Modal className={`cap${drawing ? ' draw' : ''}`} onClose={props.onClose} label={edit ? '编辑反馈' : '记一条反馈'}>
      <div className="capcol">
        <div className="capshot">
          {!edit && capture && (refCap || props.refSerial) && <span className="reflbl main">测试机 · {deviceName(capture.device)}</span>}
          {edit ? (
            <div className="noshot">截图在详情里管理</div>
          ) : capture ? (
            <>
              <div className="drawbar">
                <span className="tools" role="group" aria-label="画图工具">
                  {TOOLS.map(([k, label, key]) => (
                    <button key={k} type="button" aria-pressed={tool === k} onClick={() => setTool(k)} title={`${label}（${key}）`}>
                      <ToolIcon kind={k} />
                      {label}
                    </button>
                  ))}
                </span>
                <span className="colors" role="group" aria-label="颜色">
                  {MARK_COLORS.map((c, i) => (
                    <button key={c} type="button" aria-pressed={color === c} aria-label={COLOR_NAMES[i]} style={{ background: c }} onClick={() => setColor(c)} />
                  ))}
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn sm"
                  disabled={!marks.length}
                  onClick={() => {
                    setMarks((ms) => ms.slice(0, -1))
                    setSel(-1)
                  }}
                  title="撤销（Ctrl+Z）"
                >
                  撤销
                </button>
              </div>
              <div className="drawstage">
                <MarkCanvas
                  src={capture.dataUrl}
                  marks={marks}
                  onMarks={setMarks}
                  tool={tool}
                  color={color}
                  sel={sel}
                  onSel={setSel}
                  onDrawn={(i) => (focusNote.current = i)}
                />
              </div>
              <div className="row">
                <button type="button" className="btn sm" onClick={() => setAnnotating(true)}>
                  {p.designs?.length ? '放大 / 对比设计稿' : '放大画'}
                </button>
                <button type="button" className="btn sm" onClick={shoot}>
                  重新截图
                </button>
                <button type="button" className="btn sm danger" onClick={dropShot}>
                  删除截图
                </button>
              </div>
              {d && (
                <div className="devinfo">
                  {d.resolution} · {d.serial}
                  {d.foreground && (
                    <>
                      <br />
                      {d.foreground}
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="noshot">
                纯文字反馈
                <br />
                不带截图
              </div>
              <button type="button" className="btn sm" onClick={shoot} disabled={!props.serial}>
                补一张截图
              </button>
            </>
          )}
        </div>
        {!edit && (refCap || props.refSerial) && (
          <div className="refblock">
            <span className="reflbl">对标应用{refCap ? ` · ${deviceName(refCap.device)}` : ''}</span>
            {refCap ? (
              <div className="refrow">
                <div className="shot refthumb">
                  <img src={refCap.dataUrl} alt="对标机截图" />
                </div>
                <div className="refbtns">
                  <button type="button" className="btn sm" onClick={shootRef}>
                    重截
                  </button>
                  <button type="button" className="btn sm danger" onClick={dropRef}>
                    去掉
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn sm" onClick={shootRef}>
                + 截对标机（可选）
              </button>
            )}
          </div>
        )}
      </div>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          void save(false)
        }}
      >
        <div>
          <h3>{edit ? '编辑反馈' : '记一条反馈'}</h3>
          <p className="sub">
            {edit ? `#${edit.seq}` : '归入'} <b>{p.name}</b> 第{edit ? edit.round : p.rounds.length}轮{d ? ` · ${deviceName(d)} · Android ${d.androidVersion}` : ''}
          </p>
        </div>
        <DesignMatch project={p} captureId={capture?.id ?? null} value={design} onPick={pickDesign} run={run} />
        {drawing && (
          <>
            <span className="lbl">标注评论 · 每处写一句，会自动拼成“问题”</span>
            {marks.length === 0 ? (
              <p className="draw-hint">在左边截图上按住拖动，画出问题位置，然后在这里写一句。不画也行，直接写问题。</p>
            ) : (
              <ol className="notes-list inline">
                {marks.map((m, i) => (
                  <li key={i} className={i === sel ? 'on' : ''}>
                    <span className="no" style={{ background: m.color, color: noColor(m.color) }}>
                      {i + 1}
                    </span>
                    <input
                      ref={(el) => {
                        noteRefs.current[i] = el
                      }}
                      value={m.note}
                      maxLength={200}
                      aria-label={`标注 ${i + 1} 的评论`}
                      placeholder={`${markNo(i)} 这里有什么问题`}
                      onFocus={() => setSel(i)}
                      onChange={(e) => setNote(i, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                          e.preventDefault()
                          ;(e.target as HTMLInputElement).blur()
                        }
                      }}
                    />
                    <button type="button" className="x" aria-label={`删除标注 ${i + 1}`} onClick={() => removeMark(i)}>
                      ×
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
        <label className="lbl" htmlFor="fText">
          问题
          {drawing && textAuto && autoText && <span className="from"> · 由标注评论自动生成，可以改</span>}
          {drawing && !textAuto && autoText && (
            <button type="button" className="link" onClick={() => setTextAuto(true)}>
              {' '}
              改回用标注评论
            </button>
          )}
        </label>
        <textarea
          id="fText"
          ref={textRef}
          placeholder={drawing ? (autoText || '画了标注、写了评论就不用再写；也可以直接写') : '点下方常用短语快速填入，也可以直接写'}
          value={shownText}
          onFocus={() => setSel(-1)}
          onChange={(e) => {
            setText(e.target.value)
            setTextAuto(false)
          }}
        />
        <div className="phr">
          <div className="h">
            <span>
              常用短语 · {group === 'ad' ? '广告' : '通用'}
              {sel >= 0 && marks[sel] ? ` · 填进第 ${sel + 1} 处标注` : ''}
            </span>
            <span>点一下或按 Alt+数字</span>
          </div>
          <div className="chips">
            {phrases.map((ph, i) => {
              const k = i < 9 ? <span className="k">{i + 1}</span> : null
              return ph.custom ? (
                <span className="mine" key={ph.text}>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => usePhrase(ph.text)} title={i < 9 ? `Alt+${i + 1}` : undefined}>
                    {ph.text}
                    {k}
                  </button>
                  <button type="button" className="x" aria-label={`删除短语 ${ph.text}`} onClick={() => removePhrase(ph.text)}>
                    ×
                  </button>
                </span>
              ) : (
                <button type="button" key={ph.text} onMouseDown={(e) => e.preventDefault()} onClick={() => usePhrase(ph.text)} title={i < 9 ? `Alt+${i + 1}` : undefined}>
                  {ph.text}
                  {k}
                </button>
              )
            })}
            {adding ? (
              <span className="addin">
                <input
                  autoFocus
                  value={newPhrase}
                  maxLength={30}
                  placeholder="输入短语，回车添加"
                  onChange={(e) => setNewPhrase(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      e.stopPropagation()
                      void addPhrase()
                    }
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      setAdding(false)
                    }
                  }}
                />
                <button type="button" onClick={addPhrase}>
                  添加
                </button>
              </span>
            ) : (
              <button type="button" className="plus" onClick={() => setAdding(true)}>
                + 自定义
              </button>
            )}
          </div>
        </div>
        <span className="lbl">
          模块
          {!edit && modFrom && <span className="from"> · {modFrom === 'design' ? '来自设计稿' : '沿用上一条'}</span>}
        </span>
        <div className="pick">
          {MODULES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={m === mod}
              onClick={() => {
                setMod(m)
                setModFrom('')
              }}
            >
              {m}
            </button>
          ))}
        </div>
        <label className="lbl" htmlFor="fPage">
          页面（可选，会拼成“页面-问题”）
          {!edit && pageFrom && page && page === autoPage.current && <span className="from"> · {pageFrom === 'design' ? '来自设计稿画板名' : '沿用上一条'}</span>}
        </label>
        <input id="fPage" list="pages" placeholder="如 扣分账本页" value={page} onChange={(e) => setPage(e.target.value)} />
        <datalist id="pages">
          {pages.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <span className="lbl">
          环境（可选）
          {!edit && modeFrom && <span className="from"> · 沿用上一条</span>}
        </span>
        <div className="pick">
          {(
            [
              ['', '不区分'],
              ['audit', '审核状态'],
              ['online', '上线模式']
            ] as [Mode, string][]
          ).map(([v, l]) => (
            <button
              key={v}
              type="button"
              aria-pressed={mode === v}
              onClick={() => {
                setMode(v)
                setModeFrom('')
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={props.onClose}>
            取消
          </button>
          {!edit && (
            <button type="button" className="btn" disabled={busy} onClick={() => save(true)}>
              {capture ? '保存并截下一张' : '保存并记下一条'} <kbd>Ctrl+Shift+Enter</kbd>
            </button>
          )}
          <button className="btn primary" type="submit" disabled={busy}>
            保存 <kbd>Ctrl+Enter</kbd>
          </button>
        </div>
      </form>
      {annotating && capture && (
        <Annotator
          src={capture.dataUrl}
          marks={marks}
          title={`${p.name} · 新反馈的截图`}
          onClose={() => setAnnotating(false)}
          onSave={(m) => {
            setMarks(m)
            setSel(-1)
            setAnnotating(false)
          }}
          compare={
            p.designs?.length
              ? { project: p, design: p.designs.find((x) => x.id === design?.id) ?? null, onPick: (x) => pickDesign(x, null) }
              : undefined
          }
        />
      )}
    </Modal>
  )
}
