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

  it('publishes through the cmd shim with the original Windows PATH', async () => {
    const capture = path.join(dir, 'gh-call.json')
    const script = path.join(dir, 'gh.js')
    fs.writeFileSync(
      script,
      [
        "const fs = require('fs')",
        "fs.writeFileSync(process.env.NT_GH_CAPTURE, JSON.stringify({ args: process.argv.slice(2), path: process.env.PATH }))"
      ].join('\n')
    )
    fs.writeFileSync(path.join(dir, 'gh.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
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
