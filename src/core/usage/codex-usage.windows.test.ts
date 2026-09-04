import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fetchCodexUsageViaAppServerAt } from './codex-usage'

describe.skipIf(process.platform !== 'win32')(
  'fetchCodexUsageViaAppServerAt - Windows npm shim',
  () => {
    let dir: string

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-codex-usage-shim-'))
    })

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('completes the JSON-RPC fallback through the cmd shim', async () => {
      const cmd = path.join(dir, 'codex.cmd')
      const script = path.join(dir, 'codex.js')
      fs.writeFileSync(
        script,
        [
          "const readline = require('readline')",
          "const input = readline.createInterface({ input: process.stdin })",
          "input.on('line', (line) => {",
          "  const request = JSON.parse(line)",
          "  if (request.id === 1) console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))",
          "  if (request.id === 2) console.log(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { rateLimits: { primary: { usedPercent: 42, limitWindowSeconds: 18000 } } } }))",
          '})'
        ].join('\n')
      )
      fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)

      const usage = await fetchCodexUsageViaAppServerAt(cmd, dir)
      expect(usage?.status).toBe('ok')
      expect(usage?.limits).toMatchObject([
        { kind: 'session', usedPercent: 42, windowMinutes: 300 }
      ])
    })
  }
)
