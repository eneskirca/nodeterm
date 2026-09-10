import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import { tmpdir } from 'os'
import path from 'path'

let home = ''

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('locateDevin', () => {
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'nt-locate-devin-'))
    vi.spyOn(os, 'homedir').mockReturnValue(home)
  })

  it('returns the transcript path when the file exists', async () => {
    const { locateDevin } = await import('./locate')
    const dir = path.join(home, '.local', 'share', 'devin', 'cli', 'transcripts')
    mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'quartz-lens.json')
    writeFileSync(p, '{}')
    expect(await locateDevin('quartz-lens')).toBe(p)
  })

  it('returns undefined when the file is missing', async () => {
    const { locateDevin } = await import('./locate')
    expect(await locateDevin('missing-session')).toBeUndefined()
  })
})
