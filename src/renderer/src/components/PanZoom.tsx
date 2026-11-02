import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface View {
  z: number
  x: number
  y: number
}

const clamp = (z: number, min: number, max: number) => Math.min(max, Math.max(min, z))

/**
 * 可以滚轮缩放、按住拖动的画面（设计稿画布、对比放大共用）。
 * view 由外面管着，方便工具栏上的“− 100% +”“适合窗口”按钮一起用。
 */
export function PanZoom(props: { view: View; onView: (v: View) => void; min?: number; max?: number; className?: string; children: ReactNode }) {
  const { view, onView, min = 0.1, max = 4 } = props
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const [grabbing, setGrabbing] = useState(false)
  const dragged = useRef(false)
  const viewRef = useRef(view)
  viewRef.current = view

  // 滚轮要 preventDefault，React 的 onWheel 是 passive 的，只能自己挂
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = viewRef.current
      const r = el.getBoundingClientRect()
      const z = clamp(v.z * Math.exp(-e.deltaY * 0.0015), min, max)
      // 以鼠标位置为中心缩放
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      onView({ z, x: px - ((px - v.x) * z) / v.z, y: py - ((py - v.y) * z) / v.z })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [min, max, onView])

  return (
    <div
      ref={box}
      className={`panzoom ${props.className ?? ''}${grabbing ? ' grabbing' : ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        // 动了几个像素才算拖动，免得点画板时画面抖一下
        if (!d.moved && Math.hypot(dx, dy) < 4) return
        if (!d.moved) {
          d.moved = true
          setGrabbing(true)
          ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
        }
        onView({ ...viewRef.current, x: d.vx + dx, y: d.vy + dy })
      }}
      onPointerUp={() => {
        dragged.current = !!drag.current?.moved
        drag.current = null
        setGrabbing(false)
      }}
      onClickCapture={(e) => {
        // 拖动结束时不触发里面的点击
        if (dragged.current) e.stopPropagation()
        dragged.current = false
      }}
    >
      <div className="panzoom-in" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
        {props.children}
      </div>
    </div>
  )
}

/** 让 w×h 的内容整个放进 box 里，四周留 pad */
export function fitView(box: { width: number; height: number }, w: number, h: number, pad = 24, max = 1): View {
  const z = Math.min(max, (box.width - pad * 2) / w, (box.height - pad * 2) / h)
  return { z, x: (box.width - w * z) / 2, y: Math.max(pad, (box.height - h * z) / 2) }
}
