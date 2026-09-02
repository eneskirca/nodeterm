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

    it('completes the JSON-RPC fallback through the sibling PowerShell shim', async () => {
      const cmd = path.join(dir, 'codex.cmd')
      fs.writeFileSync(cmd, '@exit /b 99\r\n')
      fs.writeFileSync(
        path.join(dir, 'codex.ps1'),
        [
          'while (($line = [Console]::In.ReadLine()) -ne $null) {',
          "  if ($line -match '\"id\":1') {",
          "    [Console]::Out.WriteLine('{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}')",
          "  } elseif ($line -match '\"id\":2') {",
          "    [Console]::Out.WriteLine('{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"rateLimits\":{\"primary\":{\"usedPercent\":42,\"limitWindowSeconds\":18000}}}}')",
          '  }',
          '}'
        ].join('\n')
      )

      const usage = await fetchCodexUsageViaAppServerAt(cmd, dir)
      expect(usage?.status).toBe('ok')
      expect(usage?.limits).toMatchObject([
        { kind: 'session', usedPercent: 42, windowMinutes: 300 }
      ])
    })
  }
)
