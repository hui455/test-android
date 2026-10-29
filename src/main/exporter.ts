import { createWriteStream } from 'node:fs'
import archiver from 'archiver'
import { bugLine, deviceName, bugStatusInRound, bugsCsv, feedbackText, groupByModule, roundReport } from '../shared/logic'
import type { Bug, Project } from '../shared/types'
import type { ProjectStore } from './store'

export type ExportScope = { round: number } | 'all'

const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_')
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function exportBaseName(p: Project, scope: ExportScope, date = new Date()): string {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return safe(`${p.name}_${scope === 'all' ? '全部轮次' : `第${scope.round}轮`}_${d}`)
}

/** 选出要导出的反馈：某一轮只导“仍存在 + 新增”，全部轮次导全部 */
export function exportBugs(p: Project, scope: ExportScope): { bugs: Bug[]; round: number } {
  if (scope === 'all') return { bugs: p.bugs, round: p.rounds.length }
  return { bugs: roundReport(p, scope.round).issues, round: scope.round }
}

export function shotNames(bugs: Bug[]): Map<Bug, string[]> {
  return new Map(bugs.map((b) => [b, b.shots.map((_, i) => `${safe(b.module)}_${String(b.seq).padStart(3, '0')}_${i + 1}.png`)]))
}

function reportHtml(p: Project, bugs: Bug[], round: number, names: Map<Bug, string[]>, text: string): string {
  const sections = groupByModule(bugs)
    .map(
      ([m, list]) => `<h2>${esc(m)}</h2>` +
        list
          .map(
            (b, i) => `<article><div class="h"><b>${i + 1}.</b> ${esc(bugLine(b))} <span class="s">${bugStatusInRound(b, round)}</span></div>` +
              `<div class="meta">#${b.seq} · 第${b.round}轮发现${b.device ? ` · ${esc(`${deviceName(b.device)} Android ${b.device.androidVersion}`)}` : ''}</div>` +
              ((names.get(b) ?? []).length ? `<div class="shots">${names.get(b)!.map((n) => `<a href="screenshots/${encodeURI(n)}"><img src="screenshots/${encodeURI(n)}" alt=""></a>`).join('')}</div>` : '') +
              `</article>`
          )
          .join('')
    )
    .join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)} 测试反馈</title>
<style>body{font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;max-width:960px;margin:0 auto;padding:24px 16px;color:#1b2129;background:#f7f8fa}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;color:#175cd3}article{background:#fff;border:1px solid #dde1e7;border-radius:8px;padding:12px 14px;margin:8px 0}.h{font-size:15px}.s{font-size:12px;background:#edf0f3;border-radius:4px;padding:0 6px;margin-left:6px}.meta{font-size:12px;color:#5f6b7a;margin-top:4px}.shots{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.shots img{height:280px;border:1px solid #dde1e7;border-radius:6px}pre{white-space:pre-wrap;background:#fff;border:1px solid #dde1e7;border-radius:8px;padding:12px;font-size:13px}</style></head>
<body><h1>${esc(p.name)}</h1><div class="meta">开发人员：${esc(p.developer)} · 类型：${esc(p.type)} · 共 ${bugs.length} 条</div>${sections || '<p>没有反馈</p>'}<h2>反馈原文</h2><pre>${esc(text)}</pre></body></html>`
}

export async function exportZip(store: ProjectStore, projectId: string, scope: ExportScope, outPath: string): Promise<{ bugs: number; shots: number }> {
  const p = store.get(projectId)
  const { bugs, round } = exportBugs(p, scope)
  const names = shotNames(bugs)
  const text = scope === 'all' ? p.rounds.map((r) => feedbackText(p, r.no)).join('\n\n================\n\n') : feedbackText(p, round)
  const json = {
    project: { name: p.name, developer: p.developer, type: p.type, rounds: p.rounds },
    scope: scope === 'all' ? 'all' : `round-${round}`,
    bugs: bugs.map((b) => ({ ...b, line: bugLine(b), status: bugStatusInRound(b, round), shots: names.get(b) }))
  }

  const base = exportBaseName(p, scope)
  const zip = archiver('zip', { zlib: { level: 6 } })
  const done = new Promise<void>((resolve, reject) => {
    const out = createWriteStream(outPath)
    out.on('close', () => resolve())
    out.on('error', reject)
    zip.on('error', reject)
    zip.pipe(out)
  })
  zip.append(text + '\n', { name: `${base}/反馈原文.txt` })
  zip.append(reportHtml(p, bugs, round, names, text), { name: `${base}/report.html` })
  zip.append(bugsCsv(p, bugs, round, names), { name: `${base}/bugs.csv` })
  zip.append(JSON.stringify(json, null, 2), { name: `${base}/bugs.json` })
  let shots = 0
  for (const b of bugs) {
    b.shots.forEach((s, i) => {
      zip.file(store.shotPath(p.id, s.file), { name: `${base}/screenshots/${names.get(b)![i]}` })
      shots++
    })
  }
  await zip.finalize()
  await done
  return { bugs: bugs.length, shots }
}
