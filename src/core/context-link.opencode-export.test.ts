import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isSafeOpencodeSessionId, opencodeExportAt } from './context-link'

/** A stand-in `opencode` that runs `script` under this Node: a cmd shim on Windows (the shape npm
 *  installs there), an executable sh script elsewhere. */
function writeFakeOpencode(dir: string, script: string): string {
  const js = path.join(dir, 'opencode.js')
  fs.writeFileSync(js, script)
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'opencode.cmd')
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`)
    return cmd
  }
  const sh = path.join(dir, 'opencode')
  fs.writeFileSync(sh, `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`, { mode: 0o755 })
  return sh
}

describe('opencodeExportAt output bound', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-opencode-export-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns an export larger than execFile\'s default 1 MiB buffer', async () => {
    const bytes = 3 * 1024 * 1024
    const bin = writeFakeOpencode(dir, `process.stdout.write('x'.repeat(${bytes}))\n`)
    const output = await opencodeExportAt(bin, 'ses_large')
    expect(output?.length).toBe(bytes)
  })
})

describe('isSafeOpencodeSessionId', () => {
  it('accepts the ids agents mint', () => {
    expect(isSafeOpencodeSessionId('ses_6f2a9c1d8e7b4a05')).toBe(true)
    expect(isSafeOpencodeSessionId('01a0b1f6-1990-7a62-9436-ed4e3ba84b0b')).toBe(true)
  })

  it('refuses an id opencode would read as an option', () => {
    expect(isSafeOpencodeSessionId('--help')).toBe(false)
    expect(isSafeOpencodeSessionId('-s')).toBe(false)
  })

  it('refuses empty, spaced, shell-bearing and oversized ids', () => {
    expect(isSafeOpencodeSessionId('')).toBe(false)
    expect(isSafeOpencodeSessionId('ses a')).toBe(false)
    expect(isSafeOpencodeSessionId("ses';rm -rf ~;'")).toBe(false)
    expect(isSafeOpencodeSessionId('a'.repeat(257))).toBe(false)
  })
})
