import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

describe.skipIf(process.platform !== 'win32')('GitService - Windows npm gh shim', () => {
  let dir: string
  let originalPath: string | undefined
  let originalPathext: string | undefined
  let originalCapture: string | undefined

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-gh-shim-'))
    originalPath = process.env.PATH
    originalPathext = process.env.PATHEXT
    originalCapture = process.env.NT_GH_CAPTURE
  })

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalPathext === undefined) delete process.env.PATHEXT
    else process.env.PATHEXT = originalPathext
    if (originalCapture === undefined) delete process.env.NT_GH_CAPTURE
    else process.env.NT_GH_CAPTURE = originalCapture
    fs.rmSync(dir, { recursive: true, force: true })
    vi.resetModules()
  })

  it('publishes through the PowerShell sibling with the original Windows PATH', async () => {
    const capture = path.join(dir, 'gh-call.json')
    fs.writeFileSync(path.join(dir, 'gh.cmd'), '@exit /b 99\r\n')
    fs.writeFileSync(
      path.join(dir, 'gh.ps1'),
      [
        "if ($args[0] -eq 'repo') {",
        "  [IO.File]::WriteAllText($env:NT_GH_CAPTURE, (@{ args = @($args); path = $env:PATH } | ConvertTo-Json -Compress))",
        '}',
        'exit 0'
      ].join('\r\n')
    )
    const expectedPath = `${dir};${originalPath ?? ''}`
    process.env.PATH = expectedPath
    process.env.PATHEXT = '.EXE;.CMD'
    process.env.NT_GH_CAPTURE = capture

    vi.resetModules()
    const { GitService } = await import('./git-service')
    await expect(new GitService().publish(dir, 'owner/repo', true)).resolves.toEqual({
      ok: true,
      message: 'Published to GitHub.'
    })

    const recorded = JSON.parse(fs.readFileSync(capture, 'utf8')) as {
      args: string[]
      path: string
    }
    expect(recorded.args).toEqual([
      'repo',
      'create',
      'owner/repo',
      '--private',
      '--source=.',
      '--push'
    ])
    expect(recorded.path).toBe(expectedPath)
  })
})
