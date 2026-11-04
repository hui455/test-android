import { useEffect } from 'react'
import { markNo, shotFile } from '@shared/annotate'
import { bugLine } from '@shared/logic'
import type { Bug, Project } from '@shared/types'
import { shotUrl } from '../api'
import { Modal } from './Modal'

/**
 * 测试结束后看截图：这一条的所有截图（含对标）按原比例一行排开，图上带圈画，图下是标注评论。
 * ↑↓ 换上一条 / 下一条，Esc 关闭；每张图下面可以点“改标注”进圈画。
 */
export function ShotViewer(props: {
  project: Project
  bug: Bug
  view: number
  onClose: () => void
  onStep?: (d: 1 | -1) => void
  onAnnotate: (i: number) => void
}) {
  const { project: p, bug: b, onStep } = props
  // 捕获阶段先拿到 ↑↓，并标记已处理，主窗口的 ↑↓ 就不会再换一次
  useEffect(() => {
    if (!onStep) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      onStep(e.key === 'ArrowDown' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onStep])

  let own = 0
  let ref = 0
  const shots = b.shots.map((s, i) => ({ s, i, label: s.ref ? `对标 ${++ref}` : `图 ${++own}` }))

  return (
    <Modal className="viewer" onClose={props.onClose} label="查看截图">
      <div className="viewer-h">
        {b.pending ? <span className="mono">待上传</span> : <span className="mono">#{b.seq}</span>}
        <b>{bugLine(b)}</b>
        <span className="viewer-sub">
          {b.shots.length} 张截图 · 第{props.view}轮已结束
        </span>
        <span className="spacer" />
        {onStep && (
          <>
            <button className="btn sm" onClick={() => onStep(-1)} aria-label="上一条反馈">
              ↑ 上一条
            </button>
            <button className="btn sm" onClick={() => onStep(1)} aria-label="下一条反馈">
              ↓ 下一条
            </button>
          </>
        )}
        <button className="btn sm primary" onClick={props.onClose}>
          关闭 Esc
        </button>
      </div>
      {shots.length ? (
        <div className="viewer-row">
          {shots.map(({ s, i, label }) => (
            <figure key={s.file}>
              <img src={shotUrl(p.id, shotFile(s))} alt={label} />
              <figcaption>
                <span className="viewer-lbl">
                  {label}
                  {s.ai && ' · AI 截图'}
                  <button className="link" onClick={() => props.onAnnotate(i)}>
                    改标注
                  </button>
                </span>
                {(s.marks ?? []).map((m, j) =>
                  m.note.trim() ? (
                    <span key={j}>
                      {markNo(j)}
                      {m.note.trim()}
                    </span>
                  ) : null
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <div className="viewer-empty">这条没有截图{b.text ? `：${b.text}` : ''}</div>
      )}
    </Modal>
  )
}
