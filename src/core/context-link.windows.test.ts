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

  it('runs the sibling PowerShell shim without interpreting the session id', async () => {
    const cmd = path.join(dir, 'opencode.cmd')
    fs.writeFileSync(cmd, '@exit /b 99\r\n')
    fs.writeFileSync(
      path.join(dir, 'opencode.ps1'),
      '[Console]::Out.Write(($args | ConvertTo-Json -Compress))\n'
    )

    const sessionId = 'session & untouched'
    const output = await opencodeExportAt(cmd, sessionId)
    expect(JSON.parse(output ?? 'null')).toEqual(['export', sessionId])
  })
})
