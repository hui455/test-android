import { useEffect, useRef, useState } from 'react'
import { annotatedSvg, dragHandle, hitMark, MARK_COLORS, markHandles, markNo, markStyle, marksSvg, markTooSmall, moveMark, normalizeMark } from '@shared/annotate'
import type { Mark, MarkKind } from '@shared/types'
import { Modal } from './Modal'

const TOOLS: [MarkKind, string, string][] = [
  ['rect', '框', 'R'],
  ['ellipse', '圈', 'O'],
  ['arrow', '箭头', 'A'],
  ['pen', '画笔', 'P']
]

const COLOR_NAMES = ['红', '黄', '蓝', '绿']

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = src
  })

async function toDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:')) return src
  const blob = await (await fetch(src)).blob()
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

/** 把原图和标注画成一张 PNG（data URL） */
export async function renderMarked(src: string, marks: Mark[], w: number, h: number): Promise<string> {
  const svg = annotatedSvg(await toDataUrl(src), marks, w, h)
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/png')
}

/**
 * 截图圈画：在图上画框、圈、箭头或随手画，每处自动编号，右侧给每个编号写评论。
 * 保存时返回标注数据和画好标注的图片；全部删掉再保存表示清除标注。
 */
export function Annotator(props: { src: string; marks: Mark[]; title: string; onClose: () => void; onSave: (marks: Mark[], png: string | null) => Promise<void> | void }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [marks, setMarks] = useState<Mark[]>(props.marks)
  const [tool, setTool] = useState<MarkKind>('rect')
  const [color, setColor] = useState(MARK_COLORS[0])
  const [draft, setDraft] = useState<Mark | null>(null)
  const [sel, setSel] = useState(-1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const svgRef = useRef<SVGSVGElement>(null)
  const noteRefs = useRef<(HTMLInputElement | null)[]>([])
  const focusNext = useRef(-1)
  // 正在拖动已有的标注：整体移动，或拖某个控制点调大小
  const drag = useRef<{ i: number; h: number; x: number; y: number } | null>(null)
  const [cursor, setCursor] = useState('crosshair')

  useEffect(() => {
    loadImage(props.src).then(
      (img) => setSize({ w: img.naturalWidth, h: img.naturalHeight }),
      (e: Error) => setErr(e.message)
    )
  }, [props.src])

  // 新画的一处自动聚焦到它的评论框
  useEffect(() => {
    if (focusNext.current >= 0) {
      noteRefs.current[focusNext.current]?.focus()
      focusNext.current = -1
    }
  }, [marks.length])

  const style = size ? markStyle(size.w, size.h) : null

  const point = (e: React.PointerEvent): [number, number] => {
    const svg = svgRef.current!
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
    return [Math.round(Math.min(Math.max(p.x, 0), size!.w)), Math.round(Math.min(Math.max(p.y, 0), size!.h))]
  }

  /** 鼠标下是选中图形的哪个控制点，或哪一处标注 */
  const hitAt = (x: number, y: number): { i: number; h: number } => {
    if (!style) return { i: -1, h: -1 }
    const hs = style.sw * 3
    const m = marks[sel]
    if (m) {
      const h = markHandles(m).findIndex(([hx, hy]) => Math.abs(hx - x) <= hs && Math.abs(hy - y) <= hs)
      if (h >= 0) return { i: sel, h }
    }
    return { i: hitMark(marks, x, y, style.sw * 2.5, sel), h: -1 }
  }

  const down = (e: React.PointerEvent) => {
    if (!size || e.button !== 0) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const [x, y] = point(e)
    const hit = hitAt(x, y)
    if (hit.i >= 0) {
      setSel(hit.i)
      drag.current = { ...hit, x, y }
      return
    }
    setSel(-1)
    setDraft({ kind: tool, color, pts: [x, y, x, y], note: '' })
  }
  const move = (e: React.PointerEvent) => {
    if (!style) return
    const [x, y] = point(e)
    const d = drag.current
    if (d) {
      setMarks((ms) => ms.map((m, k) => (k !== d.i ? m : d.h >= 0 ? dragHandle(m, d.h, x, y) : moveMark(m, x - d.x, y - d.y))))
      drag.current = { ...d, x, y }
      return
    }
    if (!draft) {
      const hit = hitAt(x, y)
      setCursor(hit.h < 0 ? (hit.i >= 0 ? 'move' : 'crosshair') : marks[hit.i].kind === 'arrow' ? 'grab' : hit.h === 0 || hit.h === 3 ? 'nwse-resize' : 'nesw-resize')
      return
    }
    if (draft.kind !== 'pen') return setDraft({ ...draft, pts: [draft.pts[0], draft.pts[1], x, y] })
    const n = draft.pts.length
    if (Math.hypot(x - draft.pts[n - 2], y - draft.pts[n - 1]) >= style.sw) setDraft({ ...draft, pts: [...draft.pts, x, y] })
  }
  const up = () => {
    if (drag.current) {
      const i = drag.current.i
      drag.current = null
      setMarks((ms) => ms.map((m, k) => (k === i ? normalizeMark(m) : m)))
      return
    }
    if (!draft || !style) return
    setDraft(null)
    if (markTooSmall(draft, style.sw)) return
    focusNext.current = marks.length
    setSel(marks.length)
    setMarks([...marks, normalizeMark(draft)])
  }

  const setNote = (i: number, note: string) => setMarks(marks.map((m, k) => (k === i ? { ...m, note } : m)))
  const remove = (i: number) => {
    setMarks(marks.filter((_, k) => k !== i))
    setSel(-1)
  }
  const undo = () => {
    setMarks((ms) => ms.slice(0, -1))
    setSel(-1)
  }

  const save = async () => {
    if (!size) return
    setBusy(true)
    setErr('')
    try {
      const clean = marks.map((m) => ({ ...m, note: m.note.trim() }))
      await props.onSave(clean, clean.length ? await renderMarked(props.src, clean, size.w, size.h) : null)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  // 快捷键：R/O/A/P 换工具，Ctrl+Z 撤销，Ctrl+Enter 保存；在评论框里打字时不响应字母键
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e) => {
    const typing = (e.target as HTMLElement).tagName === 'INPUT'
    // 叠在“记一条反馈”上面打开时，按键只给标注窗口，不能触发下面的保存或关闭
    if (e.key === 'Escape') {
      e.stopPropagation()
      props.onClose()
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      void save()
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault()
      undo()
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && sel >= 0) {
      e.preventDefault()
      remove(sel)
    } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = TOOLS.find(([, , k]) => k === e.key.toUpperCase())
      if (t) setTool(t[0])
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const shown = draft ? [...marks, draft] : marks

  return (
    <Modal className="annot" onClose={props.onClose} label="圈画标注">
      <div className="annot-stage">
        {size ? (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${size.w} ${size.h}`}
            className="annot-svg"
            style={{ cursor }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => {
              setDraft(null)
              drag.current = null
            }}
          >
            <image href={props.src} x="0" y="0" width={size.w} height={size.h} />
            <g dangerouslySetInnerHTML={{ __html: marksSvg(shown, size.w, size.h, sel) }} />
            {/* 选中时的控制点，只在编辑时显示，不会画进导出的图 */}
            {style &&
              marks[sel] &&
              markHandles(marks[sel]).map(([hx, hy], k) => (
                <rect
                  key={k}
                  className="handle"
                  x={hx - style.sw * 1.6}
                  y={hy - style.sw * 1.6}
                  width={style.sw * 3.2}
                  height={style.sw * 3.2}
                  rx={style.sw * 0.6}
                  fill="#fff"
                  stroke="#2f6fed"
                  strokeWidth={style.sw * 0.6}
                />
              ))}
          </svg>
        ) : (
          <div className="empty">{err || '加载中…'}</div>
        )}
      </div>
      <div className="annot-side">
        <div>
          <h3>圈画标注</h3>
          <p className="sub">{props.title}</p>
        </div>
        <div className="seg" role="group" aria-label="画图工具">
          {TOOLS.map(([k, label, key]) => (
            <button key={k} type="button" aria-pressed={tool === k} onClick={() => setTool(k)} title={`${label}（${key}）`}>
              <ToolIcon kind={k} />
              {label}
            </button>
          ))}
        </div>
        <div className="colors" role="group" aria-label="颜色">
          {MARK_COLORS.map((c, i) => (
            <button key={c} type="button" aria-pressed={color === c} aria-label={COLOR_NAMES[i]} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={undo} disabled={!marks.length}>
            撤销
          </button>
          <button type="button" className="btn sm" onClick={() => setMarks([])} disabled={!marks.length}>
            清空
          </button>
        </div>
        <ol className="notes-list">
          {marks.length === 0 && <li className="hint">在左边图上按住拖动画出问题位置，每一处会自动编号，然后在这里写评论。点已有的图形可以选中，拖动移动位置，拖角上的小方块调大小，按 Delete 删除。</li>}
          {marks.map((m, i) => (
            <li key={i} className={i === sel ? 'on' : ''}>
              <span className="no" style={{ background: m.color, color: ['#ffcc00', '#30d158'].includes(m.color) ? '#111' : '#fff' }}>
                {i + 1}
              </span>
              <input
                ref={(el) => {
                  noteRefs.current[i] = el
                }}
                value={m.note}
                maxLength={200}
                placeholder={`${markNo(i)} 这里有什么问题（可不填）`}
                onFocus={() => setSel(i)}
                onChange={(e) => setNote(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) (e.target as HTMLInputElement).blur()
                }}
              />
              <button type="button" className="x" aria-label={`删除标注 ${i + 1}`} onClick={() => remove(i)}>
                ×
              </button>
            </li>
          ))}
        </ol>
        <p className="note">评论会画在图上，导出的 zip、局域网网页和 MCP 里看到的都是画好标注的图，原图会一起保留。</p>
        {err && <p className="devwarn">{err}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy || !size}>
            {busy ? '保存中…' : '完成'} <kbd>Ctrl+Enter</kbd>
          </button>
        </div>
      </div>
    </Modal>
  )
}

function ToolIcon({ kind }: { kind: MarkKind }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {kind === 'rect' && <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" {...p} />}
      {kind === 'ellipse' && <ellipse cx="8" cy="8" rx="5.5" ry="4.5" {...p} />}
      {kind === 'arrow' && (
        <>
          <path d="M3 13 L12.5 3.5" {...p} />
          <path d="M7 3.5 H12.5 V9" {...p} />
        </>
      )}
      {kind === 'pen' && <path d="M2.5 11 C4.5 6 6 13 8.5 8 S12 4 13.5 5.5" {...p} />}
    </svg>
  )
}
