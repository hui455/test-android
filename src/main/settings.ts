import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Settings } from '../shared/types'

export const newToken = () => 'bs_' + randomBytes(9).toString('base64url')

export const defaultSettings = (): Settings => ({
  developer: '',
  customPhrases: { general: [], ad: [] },
  phraseUsage: {},
  lan: { enabled: true, port: 17800, token: newToken(), requireToken: true, readOnly: false },
  autoCheckUpdate: true,
  adbPath: ''
})

export class SettingsStore {
  private file: string
  value: Settings = defaultSettings()

  constructor(root: string) {
    this.file = join(root, 'settings.json')
  }

  async load(): Promise<Settings> {
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Settings>
        const d = defaultSettings()
        this.value = {
          ...d,
          ...saved,
          customPhrases: { ...d.customPhrases, ...saved.customPhrases },
          lan: { ...d.lan, ...saved.lan }
        }
      } catch (err) {
        console.error('设置文件损坏，使用默认设置:', err)
      }
    }
    await this.save()
    return this.value
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.value = {
      ...this.value,
      ...patch,
      customPhrases: { ...this.value.customPhrases, ...patch.customPhrases },
      lan: { ...this.value.lan, ...patch.lan }
    }
    await this.save()
    return this.value
  }

  async notePhraseUsed(text: string): Promise<Settings> {
    const usage = { ...this.value.phraseUsage, [text]: (this.value.phraseUsage[text] ?? 0) + 1 }
    return this.update({ phraseUsage: usage })
  }

  private async save() {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(this.value, null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}
