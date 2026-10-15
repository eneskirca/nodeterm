import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Source Control retries `publish` right after running `gh auth login` in a terminal
// (renderer/lib/publishFallback). A cached "not signed in" must not outlive that login.
let fakeGh = ''
vi.mock('./gh-path', () => ({ ghPath: () => fakeGh }))

describe.skipIf(process.platform === 'win32')('GitService.publish — gh auth after a terminal login', () => {
  let dir: string
  const saved: Record<string, string | undefined> = {}
  const ENV = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL']

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-gh-auth-'))
    for (const k of ENV) saved[k] = process.env[k]
    // No git credential helper may answer for this test: the token fallback must find nothing.
    process.env.HOME = dir
    process.env.XDG_CONFIG_HOME = dir
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'no-gitconfig')
    fakeGh = path.join(dir, 'gh')
    fs.writeFileSync(
      fakeGh,
      `#!/bin/sh\nif [ "$1" = auth ]; then [ -f '${dir}/authed' ] && exit 0; exit 1; fi\necho "$@" >> '${dir}/calls'\nexit 0\n`,
      { mode: 0o755 }
    )
  })

  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    fs.rmSync(dir, { recursive: true, force: true })
    vi.resetModules()
  })

  it('re-asks gh after a cached negative, so the post-login retry publishes', async () => {
    vi.resetModules()
    const { GitService } = await import('./git-service')
    const git = new GitService()
    await expect(git.publish(dir, 'owner/repo', true)).resolves.toMatchObject({ ok: false, needsAuth: true })
    fs.writeFileSync(path.join(dir, 'authed'), '')
    await expect(git.publish(dir, 'owner/repo', true)).resolves.toEqual({ ok: true, message: 'Published to GitHub.' })
    expect(fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim()).toBe('repo create owner/repo --private --source=. --push')
  })

  it('asks the git credential helper for a STORED token only (GCM_INTERACTIVE=never)', async () => {
    // A credential helper that records the env it was run with and answers nothing.
    const helper = path.join(dir, 'helper.sh')
    fs.writeFileSync(helper, `#!/bin/sh\necho "gcm=$GCM_INTERACTIVE" >> '${dir}/helper-env'\nexit 0\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(dir, 'no-gitconfig'), `[credential]\n\thelper = ${helper}\n`)
    vi.resetModules()
    const { GitService } = await import('./git-service')
    await expect(new GitService().publish(dir, 'owner/repo', true)).resolves.toMatchObject({ ok: false, needsAuth: true })
    expect(fs.readFileSync(path.join(dir, 'helper-env'), 'utf8')).toContain('gcm=never')
  })
})
