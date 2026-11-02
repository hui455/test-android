import { useEffect, useRef, useState } from 'react'
import { dragHandle, hitMark, markHandles, markStyle, marksSvg, markTooSmall, moveMark, normalizeMark } from '@shared/annotate'
import type { Mark, MarkKind } from '@shared/types'

export const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = src
  })

export const TOOLS: [MarkKind, string, string][] = [
  ['rect', '框', 'R'],
  ['ellipse', '圈', 'O'],
  ['arrow', '箭头', 'A'],
  ['pen', '画笔', 'P']
]

export const COLOR_NAMES = ['红', '黄', '蓝', '绿']

/** 编号圆点的字色：黄、绿底用黑字 */
export const noColor = (c: string) => (['#ffcc00', '#30d158'].includes(c) ? '#111' : '#fff')

/**
 * 在截图上画框、圈、箭头或随手画。点已有的图形选中，拖动移动，拖角上的小方块调大小。
 * 圈画窗口和“记一条反馈”里直接画都用它，标注数据由外面保管。
 */
export function MarkCanvas(props: {
  src: string
  marks: Mark[]
  onMarks: (marks: Mark[] | ((ms: Mark[]) => Mark[])) => void
  tool: MarkKind
  color: string
  sel: number
  onSel: (i: number) => void
  /** 画好一处新的，参数是它的下标 */
  onDrawn?: (i: number) => void
  onSize?: (size: { w: number; h: number }) => void
  /** 图在界面上实际显示的大小，并排对比设计稿时用来对齐 */
  onBox?: (box: { w: number; h: number }) => void
  className?: string
}) {
  const { marks, onMarks, sel, onSel } = props
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [err, setErr] = useState('')
  const [draft, setDraft] = useState<Mark | null>(null)
  const [cursor, setCursor] = useState('crosshair')
  const svgRef = useRef<SVGSVGElement>(null)
  // 正在拖动已有的标注：整体移动，或拖某个控制点调大小
  const drag = useRef<{ i: number; h: number; x: number; y: number } | null>(null)

  const onSize = useRef(props.onSize)
  onSize.current = props.onSize
  useEffect(() => {
    setSize(null)
    setErr('')
    loadImage(props.src).then(
      (img) => {
        const s = { w: img.naturalWidth, h: img.naturalHeight }
        setSize(s)
        onSize.current?.(s)
      },
      (e: Error) => setErr(e.message)
    )
  }, [props.src])

  const onBox = useRef(props.onBox)
  onBox.current = props.onBox
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const ro = new ResizeObserver(() => onBox.current?.({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [size])

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
      onSel(hit.i)
      drag.current = { ...hit, x, y }
      return
    }
    onSel(-1)
    setDraft({ kind: props.tool, color: props.color, pts: [x, y, x, y], note: '' })
  }
  const move = (e: React.PointerEvent) => {
    if (!style) return
    const [x, y] = point(e)
    const d = drag.current
    if (d) {
      onMarks((ms) => ms.map((m, k) => (k !== d.i ? m : d.h >= 0 ? dragHandle(m, d.h, x, y) : moveMark(m, x - d.x, y - d.y))))
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
      onMarks((ms) => ms.map((m, k) => (k === i ? normalizeMark(m) : m)))
      return
    }
    if (!draft || !style) return
    setDraft(null)
    if (markTooSmall(draft, style.sw)) return
    const i = marks.length
    onMarks([...marks, normalizeMark(draft)])
    onSel(i)
    props.onDrawn?.(i)
  }

  if (!size) return <div className="empty">{err || '加载中…'}</div>
  const shown = draft ? [...marks, draft] : marks
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${size.w} ${size.h}`}
      className={`annot-svg ${props.className ?? ''}`}
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
  )
}

export function ToolIcon({ kind }: { kind: MarkKind }) {
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
