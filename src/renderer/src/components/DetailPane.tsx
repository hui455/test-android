import { useEffect, useState } from 'react'
import { bugLine } from '@shared/logic'
import type { Bug, Project } from '@shared/types'
import { shotUrl } from '../api'
import type { Run, Toast } from '../App'
import { CheckButtons } from './FeedPane'
import { deviceName, fmtTime, modCls } from './util'

export function DetailPane(props: { project: Project; bug: Bug; view: number; run: Run; toast: Toast; hasDevice: boolean; onEdit: () => void; onDeleted: () => void }) {
  const { project: p, bug: b, view: r, run, toast } = props
  const hist = [`第${b.round}轮发现`, ...Object.entries(b.checks).sort((a, c) => Number(a[0]) - Number(c[0])).map(([k, v]) => `第${k}轮${v === 'fixed' ? '已修复' : '仍存在'}`)].join(' → ')
  const d = b.device

  const needDevice = () => {
    if (!props.hasDevice) toast('没有连接设备，无法截图')
    return props.hasDevice
  }
  const addShot = async () => needDevice() && (await run('shot:add', p.id, b.id)) && toast('已追加截图')
  const retake = async (i: number) => needDevice() && (await run('shot:replace', p.id, b.id, i)) && toast(`第 ${i + 1} 张已替换为新截图`)
  const delShot = async (i: number) => (await run('shot:delete', p.id, b.id, i)) && toast('截图已删除')
  const copyOne = async () => {
    await run('copy', `${p.name} ${b.module}：${bugLine(b)}`)
    toast('已复制这条反馈')
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

  return (
    <div className="detail">
      <div className="row">
        <span className={`mod ${modCls(b.module)}`}>{b.module}</span>
        {b.mode && (
          <span className={`tag ${b.mode}`} style={{ margin: 0 }}>
            {b.mode === 'audit' ? '审核状态' : '上线模式'}
          </span>
        )}
        <span className="mono">#{b.seq}</span>
      </div>
      <h3>{bugLine(b)}</h3>
      {b.round < r && (
        <div className="row">
          <span className="lbl">第{r}轮复测：</span>
          <CheckButtons project={p} bug={b} view={r} run={run} />
        </div>
      )}
      <div className="shots">
        {b.shots.map((s, i) => (
          <div className="shotwrap" key={s.file}>
            <a className="shot" href={shotUrl(p.id, s.file)} target="_blank" rel="noreferrer">
              <img src={shotUrl(p.id, s.file)} alt={`截图 ${i + 1}`} />
            </a>
            <div className="shot-act">
              <button onClick={() => retake(i)}>重截</button>
              <button className="del" onClick={() => delShot(i)}>
                删除
              </button>
            </div>
          </div>
        ))}
        <button className="shot add" onClick={addShot}>
          + 追加截图
        </button>
      </div>
      <dl className="fields">
        <dt>历程</dt>
        <dd>{hist}</dd>
        <dt>页面</dt>
        <dd>{b.page || '未填'}</dd>
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
        <dt>记录时间</dt>
        <dd>{fmtTime(b.createdAt)}</dd>
      </dl>
      <div className="row">
        <button className="btn sm" onClick={copyOne}>
          复制这条
        </button>
        <button className="btn sm" onClick={props.onEdit}>
          编辑
        </button>
        <button className="btn sm danger" onClick={del} onBlur={() => setConfirmDel(false)}>
          {confirmDel ? '再点一次确认删除' : '删除反馈'}
        </button>
      </div>
    </div>
  )
}
