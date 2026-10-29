import { useMemo, useState } from 'react'
import { feedbackText, roundReport } from '@shared/logic'
import type { Project, RoundResult } from '@shared/types'
import type { Run, Toast } from '../App'
import { Modal } from './Modal'
import { fmtTime } from './util'

export function CopyDialog({ project: p, view, projects, run, toast, onClose }: { project: Project; view: number; projects: Project[]; run: Run; toast: Toast; onClose: () => void }) {
  const [scope, setScope] = useState<'one' | 'all'>('one')
  const text = useMemo(
    () => (scope === 'one' ? feedbackText(p, view) : projects.map((x) => feedbackText(x, x.rounds.length)).join('\n\n================\n\n')),
    [scope, p, view, projects]
  )
  const pending = roundReport(p, view).pending.length
  const copy = async () => {
    await run('copy', text)
    toast('已复制纯文本，可直接粘到飞书表格')
  }
  return (
    <Modal onClose={onClose} label="复制文本">
      <div>
        <h3>复制文本 · 第{view}轮</h3>
        <p className="sub">只复制文字，不含截图。格式与飞书表里的“反馈原文”一致；复测轮只列“仍存在 + 新增”。</p>
      </div>
      {pending > 0 && scope === 'one' && (
        <p className="note" style={{ color: 'var(--bad)' }}>
          还有 {pending} 条没复测，不会出现在文本里。
        </p>
      )}
      <div className="checks">
        <label>
          <input type="radio" checked={scope === 'one'} onChange={() => setScope('one')} /> 当前项目第{view}轮
        </label>
        <label>
          <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> 所有项目的最新一轮
        </label>
      </div>
      <textarea className="pre" readOnly rows={14} value={text} />
      <div className="actions">
        <button className="btn" onClick={onClose}>
          关闭
        </button>
        <button className="btn primary" onClick={copy}>
          复制
        </button>
      </div>
    </Modal>
  )
}

export function ExportDialog({ project: p, view, run, toast, onClose }: { project: Project; view: number; run: Run; toast: Toast; onClose: () => void }) {
  const [all, setAll] = useState(false)
  const rep = roundReport(p, view)
  const count = all ? p.bugs.length : rep.issues.length
  const shots = (all ? p.bugs : rep.issues).reduce((n, b) => n + b.shots.length, 0)
  const doExport = async () => {
    const r = await run<{ bugs: number; shots: number; filePath: string } | null>('export', p.id, all ? 'all' : { round: view })
    if (r) {
      toast(`已导出 ${r.bugs} 条反馈、${r.shots} 张截图`)
      onClose()
    }
  }
  return (
    <Modal onClose={onClose} label="导出 zip">
      <div>
        <h3>导出“{p.name}”</h3>
        <p className="sub">
          {count} 条反馈，{shots} 张截图
        </p>
      </div>
      <div className="checks">
        <label>
          <input type="radio" checked={!all} onChange={() => setAll(false)} /> 第{view}轮（仍存在 + 新增）
        </label>
        <label>
          <input type="radio" checked={all} onChange={() => setAll(true)} /> 全部轮次的全部反馈
        </label>
      </div>
      <div className="pre tree">
        {`压缩包内容
├─ 反馈原文.txt     和“复制文本”相同
├─ report.html      图文报告，双击浏览
├─ bugs.csv         Excel / 飞书可导入
├─ bugs.json        结构化数据，AI agent 可读
└─ screenshots/     ${shots} 张`}
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn primary" onClick={doExport}>
          选择位置并导出
        </button>
      </div>
    </Modal>
  )
}

export function EndRoundDialog({ project: p, run, toast, onClose }: { project: Project; run: Run; toast: Toast; onClose: () => void }) {
  const r = p.rounds.length
  const rd = p.rounds[r - 1]
  const rep = roundReport(p, r)
  // 没复测的按仍存在算，会带到下一轮
  const issues = rep.still.length + rep.pending.length + rep.fresh.length
  const [result, setResult] = useState<RoundResult>(issues ? 'fail' : 'pass')
  const end = async () => {
    if (await run('round:end', p.id, result)) {
      toast(`第${r}轮已结束：${result === 'pass' ? '测试通过' : '测试不通过，等开发修复后复测'}`)
      onClose()
    }
  }
  return (
    <Modal onClose={onClose} label="结束测试">
      <div>
        <h3>结束第{r}轮测试</h3>
        <p className="sub">
          {p.name} · 开始于 {fmtTime(rd.start)}
        </p>
      </div>
      <p className="note">
        {r > 1 && `复测 ${rep.carried.length} 条：已修复 ${rep.fixed.length}，仍存在 ${rep.still.length}。`}本轮新增 {rep.fresh.length} 条。
        {issues ? `共 ${issues} 个问题，建议记为测试不通过。` : '没有遗留问题，建议记为测试通过。'}
      </p>
      {rep.pending.length > 0 && (
        <p className="note" style={{ color: 'var(--bad)' }}>
          还有 {rep.pending.length} 条没复测，结束后会带到下一轮继续复测。
        </p>
      )}
      <div className="row">
        <span className="lbl">本轮结果</span>
        <span className="result">
          <button className="bad" aria-pressed={result === 'fail'} onClick={() => setResult('fail')}>
            测试不通过
          </button>
          <button className="ok" aria-pressed={result === 'pass'} onClick={() => setResult('pass')}>
            测试通过
          </button>
        </span>
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>
          继续测试
        </button>
        <button className="btn primary" onClick={end}>
          结束测试
        </button>
      </div>
    </Modal>
  )
}
