import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { releaseNotes } from '../scripts/release-notes.mjs'
import { latestTagged, releaseNotesText, serverCompat } from '../src/shared/logic'
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

  it('CHANGELOG-server.md 里有当前服务端版本', () => {
    const notes = releaseNotes(readFileSync('CHANGELOG-server.md', 'utf8'), pkg.serverVersion)
    expect(notes).toContain('### 新增')
  })

  it('GitHub 渲染的 HTML 转成纯文本', () => {
    const html = '<h3>新增</h3>\n<ul>\n<li><strong>对标机</strong>：一次截两台 &amp; 对比</li>\n<li>乙</li>\n</ul>\n<h3>修复</h3>\n<ul>\n<li>丙</li>\n</ul>'
    expect(releaseNotesText(html)).toBe('新增\n\n• 对标机：一次截两台 & 对比\n• 乙\n\n修复\n\n• 丙')
    expect(releaseNotesText('### 新增\n\n- **甲**：说明')).toBe('新增\n\n• 甲：说明')
  })
})

describe('客户端和服务端分开发版', () => {
  it('服务端只找 server-v 开头的最新正式版', () => {
    const rels = [
      { tag_name: 'v0.9.0' },
      { tag_name: 'server-v0.8.10' },
      { tag_name: 'server-v0.8.9' },
      { tag_name: 'server-v0.9.0', draft: true },
      { tag_name: 'server-v1.0.0-beta', prerelease: true },
      { tag_name: 'server-v0.8.2' }
    ]
    expect(latestTagged(rels, 'server-v')?.tag_name).toBe('server-v0.8.10')
    expect(latestTagged([{ tag_name: 'v0.7.1' }], 'server-v')).toBeNull()
  })

  it('不要求同一版本，只看接口', () => {
    // v0.7.1 及以前的服务端没有 api，当作 1
    expect(serverCompat({ version: '0.7.1', protocol: 1 }, 1, 1)).toBeNull()
    expect(serverCompat({ version: '0.8.0', protocol: 1, api: 3 }, 1, 2)).toBeNull()
    expect(serverCompat({ version: '0.8.0', protocol: 1, api: 1 }, 1, 2)).toContain('请先升级服务端')
    expect(serverCompat({ version: '0.7.1', protocol: 1 }, 2, 1)).toContain('请先升级服务端')
    expect(serverCompat({ version: '2.0.0', protocol: 3 }, 2, 1)).toContain('请升级客户端')
  })
})
