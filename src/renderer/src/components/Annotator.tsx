import { useEffect, useRef, useState } from 'react'
import { annotatedSvg, MARK_COLORS, markNo } from '@shared/annotate'
import type { Design, Mark, MarkKind, Project } from '@shared/types'
import { designUrl } from '../api'
import { DesignPicker } from './Designs'
import { COLOR_NAMES, loadImage, MarkCanvas, noColor, TOOLS, ToolIcon } from './MarkCanvas'
import { Modal } from './Modal'

export { loadImage }

export async function toDataUrl(src: string): Promise<string> {
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
export function Annotator(props: {
  src: string
  marks: Mark[]
  title: string
  onClose: () => void
  onSave: (marks: Mark[], png: string | null) => Promise<void> | void
  /** 右边并排放设计稿对比；onPick 换一张时同时改掉这条反馈的设计页 */
  compare?: { project: Project; design: Design | null; onPick: (d: Design | null) => void }
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [marks, setMarks] = useState<Mark[]>(props.marks)
  const [tool, setTool] = useState<MarkKind>('rect')
  const [color, setColor] = useState(MARK_COLORS[0])
  const [sel, setSel] = useState(-1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const noteRefs = useRef<(HTMLInputElement | null)[]>([])
  const focusNext = useRef(-1)
  // 设计稿对比：两边按宽度对齐，鼠标所在高度画一条对齐线
  const cmp = props.compare
  const [showCmp, setShowCmp] = useState(true)
  const [picking, setPicking] = useState(false)
  const [guide, setGuide] = useState(true)
  const [guideY, setGuideY] = useState<number | null>(null)
  const [svgBox, setSvgBox] = useState<{ w: number; h: number } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  // 新画的一处自动聚焦到它的评论框
  useEffect(() => {
    if (focusNext.current >= 0) {
      noteRefs.current[focusNext.current]?.focus()
      focusNext.current = -1
    }
  }, [marks.length])

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
    // 正在选设计稿时按键交给选择窗口
    if (picking) return
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

  return (
    <Modal className={`annot${cmp && showCmp ? ' wide' : ''}`} onClose={props.onClose} label="圈画标注">
      <div
        ref={stageRef}
        className={`annot-stage${cmp ? ' has-cmp' : ''}${cmp && showCmp ? ' cmp-on' : ''}`}
        onPointerMove={(e) => {
          if (!cmp || !showCmp || !guide) return
          const r = stageRef.current!.getBoundingClientRect()
          setGuideY(e.clientY - r.top)
        }}
        onPointerLeave={() => setGuideY(null)}
      >
        <div className="annot-cell">
          {cmp && showCmp && <div className="annot-cap">截图 · 在这里画</div>}
          <div className="annot-svgbox">
            <MarkCanvas
              src={props.src}
              marks={marks}
              onMarks={setMarks}
              tool={tool}
              color={color}
              sel={sel}
              onSel={setSel}
              onDrawn={(i) => (focusNext.current = i)}
              onSize={setSize}
              onBox={setSvgBox}
            />
          </div>
        </div>
        {cmp && showCmp && (
          <div className="annot-cell">
            <div className="annot-cap">
              <span className="t">{cmp.design ? `设计稿 · ${cmp.design.page ? `${cmp.design.page} / ` : ''}${cmp.design.name}` : '设计稿'}</span>
              <button type="button" className="btn sm" onClick={() => setPicking(true)}>
                {cmp.design ? '换一张' : '选择'}
              </button>
              <button type="button" className="btn sm" onClick={() => setShowCmp(false)}>
                收起
              </button>
            </div>
            {cmp.design ? (
              <div className="annot-dimg" style={svgBox ? { width: svgBox.w, maxHeight: svgBox.h } : undefined}>
                <img src={designUrl(cmp.project.id, cmp.design.file)} alt={`设计稿 ${cmp.design.name}`} draggable={false} />
              </div>
            ) : (
              <div className="empty">这条还没有关联设计稿，点“选择”挑一张。</div>
            )}
            <label className="annot-guide-opt">
              <input type="checkbox" checked={guide} onChange={(e) => setGuide(e.target.checked)} /> 对齐线（两边同一高度）
            </label>
          </div>
        )}
        {cmp && !showCmp && (
          <button type="button" className="annot-cmp-open" onClick={() => setShowCmp(true)}>
            对比设计稿
          </button>
        )}
        {guideY != null && <div className="annot-guide" style={{ top: guideY }} />}
      </div>
      {picking && cmp && (
        <DesignPicker
          project={cmp.project}
          current={cmp.design?.id ?? ''}
          onClose={() => setPicking(false)}
          onPick={(d) => {
            setPicking(false)
            cmp.onPick(d)
          }}
        />
      )}
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
              <span className="no" style={{ background: m.color, color: noColor(m.color) }}>
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
