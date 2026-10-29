import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { releaseNotes } from '../scripts/release-notes.mjs'
import { releaseNotesText } from '../src/shared/logic'
import pkg from '../package.json'

const LOG = `# 更新日志

## v0.2.0

### 新增

- **甲**：说明

## v0.1.0

### 修复

- 乙
`

describe('更新说明', () => {
  it('只取对应版本那一段', () => {
    expect(releaseNotes(LOG, '0.2.0')).toBe('### 新增\n\n- **甲**：说明')
    expect(releaseNotes(LOG, 'v0.1.0')).toBe('### 修复\n\n- 乙')
    expect(releaseNotes(LOG, '0.1')).toBe('')
    expect(releaseNotes(LOG, '0.3.0')).toBe('')
  })

  it('CHANGELOG.md 里有当前版本', () => {
    const notes = releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), pkg.version)
    expect(notes).toContain('### 新增')
  })

  it('GitHub 渲染的 HTML 转成纯文本', () => {
    const html = '<h3>新增</h3>\n<ul>\n<li><strong>对标机</strong>：一次截两台 &amp; 对比</li>\n<li>乙</li>\n</ul>\n<h3>修复</h3>\n<ul>\n<li>丙</li>\n</ul>'
    expect(releaseNotesText(html)).toBe('新增\n\n• 对标机：一次截两台 & 对比\n• 乙\n\n修复\n\n• 丙')
    expect(releaseNotesText('### 新增\n\n- **甲**：说明')).toBe('新增\n\n• 甲：说明')
  })
})
