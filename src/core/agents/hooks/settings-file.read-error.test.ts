import { expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})
import { updateSettingsFile } from './settings-file'
import { ensureFullscreenTuiInFile } from './claude-tui'

it.each(['EACCES', 'EIO'])('does not treat %s as missing settings', (code) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nt-read-error-'))
  const file = path.join(dir, 'settings.json')
  try {
    writeFileSync(file, '{"model":"keep"}')
    const fail = () => { throw Object.assign(new Error('fixture read failure'), { code }) }
    vi.mocked(readFileSync).mockImplementation(fail)
    expect(updateSettingsFile(file, () => ({ hooks: {} }))).toBe(false)
    vi.mocked(readFileSync).mockImplementation(fail)
    expect(ensureFullscreenTuiInFile(file)).toBe(false)
    vi.mocked(readFileSync).mockReset()
    expect(readFileSync(file, 'utf8')).toBe('{"model":"keep"}')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
