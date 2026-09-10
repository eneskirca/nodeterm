import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { opencodeExportAt } from './context-link'

describe.skipIf(process.platform !== 'win32')('opencodeExportAt - Windows npm shim', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-opencode-shim-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('runs the cmd shim without interpreting the session id', async () => {
    const cmd = path.join(dir, 'opencode.cmd')
    const script = path.join(dir, 'opencode.js')
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)

    const sessionId = 'session & untouched'
    const output = await opencodeExportAt(cmd, sessionId)
    expect(JSON.parse(output ?? 'null')).toEqual(['export', sessionId])
  })
})
