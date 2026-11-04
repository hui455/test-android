import { useEffect, useRef, useState } from 'react'
import { shotFile } from '@shared/annotate'
import { aiLabel, aiPrompt, bugDesign, bugLine, reporterLabel } from '@shared/logic'
import type { Bug, Mark, Project } from '@shared/types'
import { shotUrl } from '../api'
import type { Run, Toast } from '../App'
import { Annotator } from './Annotator'
import { ShotViewer } from './ShotViewer'
import { CheckButtons } from './FeedPane'
import { DesignCompare, DesignPicker, designLine } from './Designs'
import { renderShareCard } from './shareCard'
import { deviceName, fmtTime, modCls } from './util'

export function DetailPane(props: {
  project: Project
  bug: Bug
  view: number
  run: Run
  toast: Toast
  hasDevice: boolean
  /** 项目打开了“对标应用”开关 */
  refOn: boolean
  /** 对标机，没选时为空 */
  refSerial: string
  /** 每次加一，表示马上要追加一张新截图，加好后直接在它上面打开圈画 */
  drawNew: number
  onEdit: () => void
  onDeleted: () => void
  /** 大图查看里按 ↑↓ 换上一条 / 下一条 */
  onStep?: (d: 1 | -1) => void
}) {
  const { project: p, bug: b, view: r, run, toast } = props
  const hist = [`第${b.round}轮发现`, ...Object.entries(b.checks).sort((a, c) => Number(a[0]) - Number(c[0])).map(([k, v]) => `第${k}轮${v === 'fixed' ? '已修复' : '仍存在'}`)].join(' → ')
  const d = b.device
  // 对标截图单独放一块，下标仍按 b.shots 里的位置
  const shots = b.shots.map((s, i) => ({ s, i }))
  const ownShots = shots.filter(({ s }) => !s.ref)
  const refShots = shots.filter(({ s }) => s.ref)

  const needDevice = () => {
    if (!props.hasDevice) toast('没有连接设备，无法截图')
    return props.hasDevice
  }
  const addShot = async () => needDevice() && (await run('shot:add', p.id, b.id)) && toast('已追加截图')
  const addRef = async () => (await run('shot:add', p.id, b.id, true)) && toast('已截对标机')
  const retake = async (i: number) => needDevice() && (await run('shot:replace', p.id, b.id, i)) && toast(`第 ${i + 1} 张已替换为新截图`)
  const delShot = async (i: number) => (await run('shot:delete', p.id, b.id, i)) && toast('截图已删除')
  // 发给开发：图片 / 链接 / 文字
  const [share, setShare] = useState(false)
  useEffect(() => setShare(false), [b.id])
  // 主按钮直接用上次选的发法，小箭头里换
  const [method, setMethod] = useState<ShareMethod>(recallShare)
  const link = async () => (b.pending ? null : await run<{ full: string; plain: string }>('bug:link', p.id, b.seq))
  const pick = (m: ShareMethod, f: () => Promise<void>) => () => {
    setMethod(m)
    rememberShare(m)
    void f()
  }
  const copyImage = async () => {
    setShare(false)
    try {
      const l = await link()
      const png = await renderShareCard(p, b, { link: l?.plain ?? '', withDesign: true })
      if (await run('copy:image', png)) toast('已复制图片，可以直接粘到飞书 / 微信')
    } catch (err) {
      toast(`生成图片失败：${(err as Error).message}`)
    }
  }
  const copyLink = async () => {
    setShare(false)
    const l = await link()
    if (!l?.full) return toast('还没连上服务端，没有链接')
    if (await run('copy', l.full)) toast('已复制链接，开发在公司网络里能打开')
  }
  const copyOne = async () => {
    setShare(false)
    await run('copy', `${p.name} ${b.module}：${bugLine(b)}`)
    toast('已复制这条反馈')
  }
  const copyAi = async () => {
    await run('copy', aiPrompt(p, b))
    toast('已复制，发给接了 BugShot MCP 的 AI 即可')
  }
  const design = bugDesign(p, b)
  const [picking, setPicking] = useState(false)
  useEffect(() => setPicking(false), [b.id])
  const setDesign = async (id: string | null) => {
    setPicking(false)
    if (await run('bug:update', p.id, b.id, { design: id ? { id, score: null } : null })) toast(id ? '已关联设计页' : '已取消关联')
  }
  const [annot, setAnnot] = useState(-1)
  useEffect(() => setAnnot(-1), [b.id])
  // 这一轮已经结束：点截图看大图（一行排开），不再直接进圈画；重截、删除、追加都收起来
  const ended = !!p.rounds[r - 1]?.end
  const [viewing, setViewing] = useState(false)
  useEffect(() => {
    if (!ended) setViewing(false)
  }, [ended])
  // 换了一条就回到顶上，键盘、滚轮换条时从截图开始看
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (rootRef.current) rootRef.current.scrollTop = 0
  }, [b.id])
  // 复测按 B：等新截图加进来，直接在它上面打开圈画
  const wantDraw = useRef<{ id: string; len: number } | null>(null)
  useEffect(() => {
    if (props.drawNew) wantDraw.current = { id: b.id, len: b.shots.length }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.drawNew])
  useEffect(() => {
    const w = wantDraw.current
    if (!w) return
    if (w.id !== b.id) wantDraw.current = null
    else if (b.shots.length > w.len) {
      wantDraw.current = null
      setAnnot(b.shots.length - 1)
    }
  }, [b.id, b.shots.length])
  const saveMarks = async (i: number, marks: Mark[], png: string | null) => {
    if (!(await run('shot:mark', p.id, b.id, i, marks, png))) return
    setAnnot(-1)
    toast(marks.length ? `已保存 ${marks.length} 处标注` : '已清除标注')
  }

  // 删除需要再点一次确认
  const [confirmDel, setConfirmDel] = useState(false)
  useEffect(() => setConfirmDel(false), [b.id])
  const del = async () => {
    if (!confirmDel) return setConfirmDel(true)
    await run('bug:delete', p.id, b.id)
    props.onDeleted()
    toast('已删除')
  }

  const tile = ({ s, i }: { s: Bug['shots'][number]; i: number }, n: number) => (
    <div className="shotwrap" key={s.file}>
      <button className="shot zoomable" onClick={() => (ended ? setViewing(true) : setAnnot(i))} title={ended ? '点击查看大图' : '点击圈画标注'}>
        <img src={shotUrl(p.id, shotFile(s))} alt={s.ref ? `对标截图 ${n + 1}` : `截图 ${n + 1}`} />
        {s.marks?.length ? <span className="shot-count">{s.marks.length} 处标注</span> : null}
        {s.ai && <span className="shot-ai">AI 截图</span>}
      </button>
      {!ended && (
        <div className="shot-act">
          <button onClick={() => setAnnot(i)}>标注</button>
          <button onClick={() => retake(i)}>重截</button>
          <button className="del" onClick={() => delShot(i)}>
            删除
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div className="detail" ref={rootRef}>
      <div className="row">
        <span className={`mod ${modCls(b.module)}`}>{b.module}</span>
        {b.mode && (
          <span className={`tag ${b.mode}`} style={{ margin: 0 }}>
            {b.mode === 'audit' ? '审核状态' : '上线模式'}
          </span>
        )}
        {b.pending ? <span className="tag pend">待上传</span> : <span className="mono">#{b.seq}</span>}
        {b.aiBy && (
          <span className="tag ai" style={{ margin: 0 }} title="测试人员把文字发给 AI，AI 通过 MCP 记的">
            AI 记
          </span>
        )}
      </div>
      {b.uploadError && <p className="note" style={{ color: 'var(--bad)' }}>上传失败：{b.uploadError}。可以编辑后重试，或删除这条。</p>}
      <h3>{bugLine(b)}</h3>
      {b.aiFix && (
        <div className={`aifix ai-${b.aiFix.status ?? 'fixed'}`}>
          <div className="aifix-h">
            <span className="aifix-chip">{aiLabel(b.aiFix)}</span>
            <span className="spacer" />
            <span className="mono">
              {b.aiFix.by} · 第{b.aiFix.round}轮 · {fmtTime(b.aiFix.at)}
            </span>
          </div>
          <p>{b.aiFix.summary}</p>
        </div>
      )}
      {b.aiNote && (
        <div className="aifix ai-confirm">
          <div className="aifix-h">
            <span className="aifix-chip">AI 记的说明</span>
            <span className="spacer" />
            <span className="mono">
              {b.aiBy} · {fmtTime(b.createdAt)}
            </span>
          </div>
          <p>{b.aiNote}</p>
        </div>
      )}
      {b.round < r && (
        <div className="row">
          <span className="lbl">第{r}轮复测：</span>
          <CheckButtons project={p} bug={b} view={r} run={run} />
        </div>
      )}
      <div className="shots">
        {ownShots.map(tile)}
        {!ended && (
          <button className="shot add" onClick={addShot}>
            + 追加截图
          </button>
        )}
      </div>
      {props.refOn && (
        <section className="refsec" aria-label="对标应用">
          <div className="refsec-h">
            <span>对标应用</span>
            {refShots[0]?.s.device && <span className="reftag">{deviceName(refShots[0].s.device)}</span>}
            <span className="spacer" />
            {props.refSerial && !b.pending && !ended && (
              <button className="btn sm" onClick={addRef}>
                截对标机
              </button>
            )}
          </div>
          {refShots.length ? (
            <div className="shots">{refShots.map(tile)}</div>
          ) : (
            <span className="none">这条还没有对标截图。{props.refSerial || ended ? '' : '在顶部选好对标机后可以补截。'}</span>
          )}
        </section>
      )}
      {design && <DesignCompare project={p} bug={b} design={design} />}
      {b.shots.some((s) => s.marks?.some((m) => m.note.trim())) && (
        <ul className="marknotes">
          {b.shots.flatMap((s, si) =>
            (s.marks ?? []).map((m, i) =>
              m.note.trim() ? (
                <li key={`${si}-${i}`}>
                  <span className="no" style={{ background: m.color, color: ['#ffcc00', '#30d158'].includes(m.color) ? '#111' : '#fff' }}>
                    {i + 1}
                  </span>
                  <span>
                    {b.shots.length > 1 && <span className="mono">图{si + 1} </span>}
                    {m.note}
                  </span>
                </li>
              ) : null
            )
          )}
        </ul>
      )}
      <dl className="fields">
        <dt>历程</dt>
        <dd>{hist}</dd>
        <dt>页面</dt>
        <dd>{b.page || '未填'}</dd>
        {(design || (p.designs?.length ?? 0) > 0) && (
          <>
            <dt>设计页</dt>
            <dd>
              {design ? designLine(b, design) : '未关联'}{' '}
              {!b.pending && (
                <button className="link" onClick={() => setPicking(true)}>
                  {design ? '更换' : '选择'}
                </button>
              )}
              {design?.figmaUrl && (
                <>
                  {' · '}
                  <a href={design.figmaUrl} target="_blank" rel="noreferrer">
                    在 Figma 打开
                  </a>
                </>
              )}
            </dd>
          </>
        )}
        <dt>问题</dt>
        <dd>{b.text}</dd>
        <dt>设备</dt>
        <dd>{d ? `${deviceName(d)} · Android ${d.androidVersion} · ${d.resolution}` : '未记录'}</dd>
        {d?.foreground && (
          <>
            <dt>前台应用</dt>
            <dd className="mono">{d.foreground}</dd>
          </>
        )}
        <dt>记录人</dt>
        <dd>{reporterLabel(b) || '未记录'}</dd>
        <dt>记录时间</dt>
        <dd>{fmtTime(b.createdAt)}</dd>
        {b.updatedBy && (
          <>
            <dt>最后修改</dt>
            <dd>
              {b.updatedBy} · {fmtTime(b.updatedAt)}
            </dd>
          </>
        )}
      </dl>
      <div className="row">
        <span className="more">
          <span className="split">
            <button
              className="btn sm primary"
              onClick={method === 'link' && b.pending ? copyImage : { image: copyImage, link: copyLink, text: copyOne }[method]}
              title="换一种发法点右边小箭头"
            >
              发给开发 · {SHARE_LABEL[method === 'link' && b.pending ? 'image' : method]}
            </button>
            <button className="btn sm primary" aria-label="换一种发给开发的方式" aria-expanded={share} onClick={() => setShare(!share)}>
              ▾
            </button>
          </span>
          {share && (
            <>
              <span className="menu-scrim" onClick={() => setShare(false)} />
              <span className="menu left share" role="menu">
                <button role="menuitemradio" aria-checked={method === 'image'} onClick={pick('image', copyImage)}>
                  <b>复制成图片</b>
                  <small>截图、圈画和问题拼成一张图，粘到飞书 / 微信</small>
                </button>
                <button role="menuitemradio" aria-checked={method === 'link'} onClick={pick('link', copyLink)} disabled={!!b.pending} title={b.pending ? '上传到服务端后才有链接' : undefined}>
                  <b>复制链接</b>
                  <small>{b.pending ? '上传到服务端后才有链接' : '开发在公司网络里点开，网页上直接看这一条'}</small>
                </button>
                <button role="menuitemradio" aria-checked={method === 'text'} onClick={pick('text', copyOne)}>
                  <b>只复制文字</b>
                  <small>项目、模块和问题一行字</small>
                </button>
              </span>
            </>
          )}
        </span>
        <button className="btn sm" onClick={copyAi} disabled={!!b.pending} title={b.pending ? '上传到服务端后才有编号' : '复制一段提示词，发给 AI 让它修这条'}>
          复制给 AI
        </button>
        <button className="btn sm" onClick={props.onEdit}>
          编辑
        </button>
        <button className="btn sm danger" onClick={del} onBlur={() => setConfirmDel(false)}>
          {confirmDel ? '再点一次确认删除' : '删除反馈'}
        </button>
      </div>
      {picking && <DesignPicker project={p} current={design?.id ?? ''} onClose={() => setPicking(false)} onPick={(d) => setDesign(d?.id ?? null)} />}
      {viewing && annot < 0 && (
        <ShotViewer
          project={p}
          bug={b}
          view={r}
          onClose={() => setViewing(false)}
          onStep={props.onStep}
          onAnnotate={(i) => setAnnot(i)}
        />
      )}
      {annot >= 0 && b.shots[annot] && (
        <Annotator
          src={shotUrl(p.id, b.shots[annot].file)}
          marks={b.shots[annot].marks ?? []}
          title={`#${b.seq} ${bugLine(b)} · 图 ${annot + 1}`}
          onClose={() => setAnnot(-1)}
          onSave={(m, png) => saveMarks(annot, m, png)}
          compare={p.designs?.length && !b.shots[annot].ref ? { project: p, design: design ?? null, onPick: (d) => void setDesign(d?.id ?? null) } : undefined}
        />
      )}
    </div>
  )
}

type ShareMethod = 'image' | 'link' | 'text'
const SHARE_LABEL: Record<ShareMethod, string> = { image: '复制成图片', link: '复制链接', text: '只复制文字' }
function recallShare(): ShareMethod {
  try {
    const v = localStorage.getItem('bugshot.share')
    return v === 'link' || v === 'text' ? v : 'image'
  } catch {
    return 'image'
  }
}
function rememberShare(m: ShareMethod) {
  try {
    localStorage.setItem('bugshot.share', m)
  } catch {
    /* 记不住就每次用复制成图片 */
  }
}
