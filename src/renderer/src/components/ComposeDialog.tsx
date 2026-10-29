import { useEffect, useRef, useState } from 'react'
import { marksText } from '@shared/annotate'
import { appendPhrase, pageSuggestions, phraseGroup, rankedPhrases } from '@shared/logic'
import { MODULES, type Bug, type BugDesign, type Design, type Mark, type Mode, type Module, type Project, type Settings } from '@shared/types'
import type { Capture } from '../api'
import type { Run, Toast } from '../App'
import { Annotator } from './Annotator'
import { DesignMatch } from './Designs'
import { Modal } from './Modal'
import { deviceName } from './util'

export interface ComposeTarget {
  capture: Capture | null
  /** 编辑已有反馈时传入 */
  edit?: Bug
}

let lastModule: Module = 'tab1'

export function ComposeDialog(props: {
  project: Project
  target: ComposeTarget
  settings: Settings
  run: Run
  toast: Toast
  serial: string
  onClose: () => void
  onSaved: (bugId: string, next: boolean) => void
}) {
  const { project: p, settings, run, toast, target } = props
  const edit = target.edit
  const [capture, setCapture] = useState<Capture | null>(target.capture)
  const [mod, setMod] = useState<Module>(edit?.module ?? lastModule)
  const [page, setPage] = useState(edit?.page ?? '')
  const [text, setText] = useState(edit?.text ?? '')
  const [mode, setMode] = useState<Mode>(edit?.mode ?? '')
  const [adding, setAdding] = useState(false)
  const [newPhrase, setNewPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  // 截图上的圈画：marked 是画好标注的图，保存反馈时一起交给主进程
  const [marks, setMarks] = useState<Mark[]>([])
  const [marked, setMarked] = useState<string | null>(null)
  const [annotating, setAnnotating] = useState(false)
  const [design, setDesign] = useState<BugDesign | null>(edit?.design ?? null)
  // 上次自动填进“页面”的画板名：测试人员自己改过页面就不再覆盖
  const autoPage = useRef<string | null>(null)
  const pickDesign = (d: Design | null, score: number | null) => {
    setDesign(d ? { id: d.id, score } : null)
    if (!d) return
    setPage((cur) => {
      if (cur.trim() && cur !== autoPage.current) return cur
      autoPage.current = d.name
      return d.name
    })
    if (d.module) setMod(d.module)
  }
  const textRef = useRef<HTMLTextAreaElement>(null)
  const capRef = useRef(capture)
  capRef.current = capture

  useEffect(() => textRef.current?.focus(), [])
  // 关闭时丢掉没保存的截图
  useEffect(() => () => void (capRef.current && run('discard-capture', capRef.current.id)), [run])

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
    setMarked(null)
  }
  const dropShot = () => {
    if (capture) void run('discard-capture', capture.id)
    setCapture(null)
    setMarks([])
    setMarked(null)
  }

  const usePhrase = (t: string) => {
    setText((v) => appendPhrase(v, t))
    void run('phrase:used', t)
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
    if (!text.trim()) return textRef.current?.focus()
    setBusy(true)
    const input = { module: mod, page, text, mode, design }
    const bug = edit ? await run<Bug>('bug:update', p.id, edit.id, input) : await run<Bug>('bug:add', p.id, input, capture?.id ?? null, marked ? { marks, png: marked } : undefined)
    setBusy(false)
    if (!bug) return
    if (!edit) {
      capRef.current = null // 已经保存，不要丢弃
      lastModule = mod
    }
    toast(edit ? '已保存修改' : `已记到 ${p.name} 第${p.rounds.length}轮 · ${mod}`)
    props.onSaved(bug.id, next)
  }

  // Ctrl/Cmd+Enter 在对话框任意位置都能保存
  const saveRef = useRef(save)
  saveRef.current = save
  const annotatingRef = useRef(false)
  annotatingRef.current = annotating
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !annotatingRef.current) {
        e.preventDefault()
        void saveRef.current(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const d = capture?.device
  return (
    <Modal className="cap" onClose={props.onClose} label={edit ? '编辑反馈' : '记一条反馈'}>
      <div className="capshot">
        {edit ? (
          <div className="noshot">截图在详情里管理</div>
        ) : capture ? (
          <>
            <button type="button" className="shot zoomable" onClick={() => setAnnotating(true)} title="点击圈画标注">
              <img src={marked ?? capture.dataUrl} alt="截图预览" />
              <span className="shot-hint">{marks.length ? `${marks.length} 处标注 · 点击修改` : '点击圈画标注'}</span>
            </button>
            {marksText(marks) && <div className="shot-notes">{marksText(marks)}</div>}
            <div className="row">
              <button type="button" className="btn sm accent" onClick={() => setAnnotating(true)}>
                圈画标注
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
        <span className="lbl">模块</span>
        <div className="pick">
          {MODULES.map((m) => (
            <button key={m} type="button" aria-pressed={m === mod} onClick={() => setMod(m)}>
              {m}
            </button>
          ))}
        </div>
        <label className="lbl" htmlFor="fPage">
          页面（可选，会拼成“页面-问题”）
        </label>
        <input id="fPage" list="pages" placeholder="如 扣分账本页" value={page} onChange={(e) => setPage(e.target.value)} />
        {design && page === autoPage.current && <span className="note" style={{ marginTop: -6 }}>来自设计稿画板名</span>}
        <datalist id="pages">
          {pages.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <label className="lbl" htmlFor="fText">
          问题
        </label>
        <textarea id="fText" ref={textRef} required placeholder="点下方常用短语快速填入，也可以直接写" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="phr">
          <div className="h">
            <span>常用短语 · {group === 'ad' ? '广告' : '通用'}</span>
            <span>点一下填入</span>
          </div>
          <div className="chips">
            {phrases.map((ph) =>
              ph.custom ? (
                <span className="mine" key={ph.text}>
                  <button type="button" onClick={() => usePhrase(ph.text)}>
                    {ph.text}
                  </button>
                  <button type="button" className="x" aria-label={`删除短语 ${ph.text}`} onClick={() => removePhrase(ph.text)}>
                    ×
                  </button>
                </span>
              ) : (
                <button type="button" key={ph.text} onClick={() => usePhrase(ph.text)}>
                  {ph.text}
                </button>
              )
            )}
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
        <span className="lbl">环境（可选）</span>
        <div className="pick">
          {(
            [
              ['', '不区分'],
              ['audit', '审核状态'],
              ['online', '上线模式']
            ] as [Mode, string][]
          ).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={mode === v} onClick={() => setMode(v)}>
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
              保存并记下一条
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
          onSave={(m, png) => {
            setMarks(m)
            setMarked(png)
            setAnnotating(false)
            textRef.current?.focus()
          }}
        />
      )}
    </Modal>
  )
}
