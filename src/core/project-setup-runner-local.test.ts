import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SETUP_OUTPUT_CAP,
  WINDOWS_NO_SH_MESSAGE,
  isPowerShellScript,
  makeLocalSetupRunner,
  resolveProjectSetupTarget,
  type ProjectSetupTargetInfo
} from './project-setup-runner-local'
import type { WorktreeListResult } from '../shared/worktree'

describe('makeLocalSetupRunner', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-setup-runner-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const run = (
    script: string,
    opts: { env?: Record<string, string>; shell?: string; timeoutMs?: number; signal?: AbortSignal } = {}
  ) => {
    const runner = makeLocalSetupRunner({ shell: opts.shell, timeoutMs: opts.timeoutMs })
    const chunks: string[] = []
    const controller = new AbortController()
    const promise = runner({
      script,
      cwd: tmpDir,
      env: opts.env ?? {},
      onChunk: (text) => chunks.push(text),
      signal: opts.signal ?? controller.signal
    })
    return { promise, chunks, controller }
  }

  it('env vars passed to the runner are visible to the script', async () => {
    const { promise, chunks } = run('echo "$NODETERM_ROOT_PATH"', {
      env: { NODETERM_ROOT_PATH: '/some/root/path' }
    })
    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(chunks.join('')).toContain('/some/root/path')
  })

  it('propagates the script exit code', async () => {
    const { promise } = run('exit 7')
    const result = await promise
    expect(result.exitCode).toBe(7)
  })

  it('runs in the given cwd', async () => {
    const { promise, chunks } = run('pwd')
    await promise
    // macOS temp dirs resolve through a /private symlink — compare realpaths.
    expect(chunks.join('').trim()).toBe(fs.realpathSync(tmpDir))
  })

  it('never rejects: a spawn error resolves exitCode 127 with the message as a chunk', async () => {
    const { promise, chunks } = run('echo hi', { shell: '/nonexistent/nope-shell-binary' })
    const result = await promise
    expect(result.exitCode).toBe(127)
    expect(chunks.join('').length).toBeGreaterThan(0)
  })

  it('caps combined output at SETUP_OUTPUT_CAP and appends exactly one truncation note', async () => {
    const { promise, chunks } = run('yes 0123456789abcdef0123456789abcdef 2>&1', { timeoutMs: 500 })
    const result = await promise
    const combined = chunks.join('')
    // A generous margin over the cap: the last chunk that crosses the budget can carry a partial
    // line plus the truncation note, but nothing appended AFTER truncation.
    expect(Buffer.byteLength(combined, 'utf-8')).toBeLessThan(SETUP_OUTPUT_CAP + 200)
    expect(combined.match(/truncated/g)?.length).toBe(1)
    // Killed by the timeout's SIGKILL (yes never exits on its own).
    expect(result.exitCode).not.toBe(0)
  }, 10_000)

  it('an abort signal kills the process promptly', async () => {
    const controller = new AbortController()
    const { promise } = run('sleep 30', { timeoutMs: 60_000, signal: controller.signal })
    const start = Date.now()
    setTimeout(() => controller.abort(), 30)
    const result = await promise
    expect(Date.now() - start).toBeLessThan(3000)
    expect(result.exitCode).not.toBe(0)
  }, 10_000)

  it('coalesces rapid writes into fewer onChunk calls than lines written (debounced)', async () => {
    const { promise, chunks } = run('echo one; echo two; echo three')
    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(chunks.length).toBeLessThan(3)
    const combined = chunks.join('')
    expect(combined).toContain('one')
    expect(combined).toContain('two')
    expect(combined).toContain('three')
  })
})

describe('makeLocalSetupRunner on Windows (platform injected)', () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-setup-win-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const go = (runner: ReturnType<typeof makeLocalSetupRunner>, script: string) => {
    const chunks: string[] = []
    const promise = runner({
      script,
      cwd: tmpDir,
      env: {},
      onChunk: (t) => chunks.push(t),
      signal: new AbortController().signal
    })
    return { promise, chunks }
  }

  it('with no Git Bash, spawns nothing and says how to fix it, as exit 127', async () => {
    const marker = path.join(tmpDir, 'ran')
    const runner = makeLocalSetupRunner({ platform: 'win32', resolveWinSh: () => null })
    const { promise, chunks } = go(runner, `touch '${marker}'`)
    expect(await promise).toEqual({ exitCode: 127 })
    expect(chunks.join('')).toContain(WINDOWS_NO_SH_MESSAGE)
    expect(chunks.join('')).toContain('Install Git for Windows')
    expect(fs.existsSync(marker)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'runs through the resolved sh, in the project folder, with CHERE_INVOKING set',
    async () => {
      const runner = makeLocalSetupRunner({ platform: 'win32', resolveWinSh: () => '/bin/sh' })
      const { promise, chunks } = go(runner, 'echo "inv=$CHERE_INVOKING"; pwd')
      expect(await promise).toEqual({ exitCode: 0 })
      expect(chunks.join('')).toContain('inv=1')
      expect(chunks.join('')).toContain(fs.realpathSync(tmpDir))
    }
  )

  it.skipIf(process.platform === 'win32')('runs a pwsh-shebang script under PowerShell via -EncodedCommand', async () => {
    const fake = path.join(tmpDir, 'fake-pwsh')
    fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
    const script = "#!/usr/bin/env pwsh\nWrite-Host 'it''s here'\n"
    let shCalled = false
    const runner = makeLocalSetupRunner({
      platform: 'win32',
      resolveWinSh: () => {
        shCalled = true
        return '/bin/sh'
      },
      resolveWinPwsh: () => fake
    })
    const { promise, chunks } = go(runner, script)
    expect(await promise).toEqual({ exitCode: 0 })
    const argv = chunks.join('').trim().split('\n')
    expect(argv.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    expect(Buffer.from(argv[5], 'base64').toString('utf16le')).toBe(script)
    expect(shCalled).toBe(false)
  })

  it('leaves POSIX untouched: a pwsh shebang still runs under sh -lc off Windows', async () => {
    let resolved = false
    const runner = makeLocalSetupRunner({
      platform: 'linux',
      resolveWinSh: () => {
        resolved = true
        return null
      }
    })
    const { promise, chunks } = go(runner, '#!/usr/bin/env pwsh\necho posix')
    expect(await promise).toEqual({ exitCode: 0 })
    expect(chunks.join('')).toContain('posix')
    expect(resolved).toBe(false)
  })
})

describe('isPowerShellScript', () => {
  it('matches only a first-line pwsh/powershell shebang', () => {
    expect(isPowerShellScript('#!/usr/bin/env pwsh\nnpm ci')).toBe(true)
    expect(isPowerShellScript('\uFEFF#!powershell.exe\r\nnpm ci')).toBe(true)
    expect(isPowerShellScript('#!/bin/sh\n# pwsh later')).toBe(false)
    expect(isPowerShellScript('npm ci && pwsh -c x')).toBe(false)
  })
})

describe('resolveProjectSetupTarget', () => {
  const okList = (paths: string[]): ((repoPath: string) => Promise<WorktreeListResult>) =>
    async () => ({ ok: true, entries: paths.map((p) => ({ path: p, branch: null, head: null, isBare: false })) })

  it('refuses an unknown project id (null info)', async () => {
    const result = await resolveProjectSetupTarget('missing', undefined, null, okList([]))
    expect(result).toBeNull()
  })

  it('refuses an inline/cwd-less local project (no cwd, no ssh)', async () => {
    const info: ProjectSetupTargetInfo = { name: 'inline' }
    const result = await resolveProjectSetupTarget('p1', undefined, info, okList([]))
    expect(result).toBeNull()
  })

  it('builds a local target with no worktreePath', async () => {
    const info: ProjectSetupTargetInfo = { name: 'proj', cwd: '/repo' }
    const result = await resolveProjectSetupTarget('p1', undefined, info, okList([]))
    expect(result).toEqual({ projectId: 'p1', projectName: 'proj', rootPath: '/repo' })
  })

  it('accepts a worktreePath equal to rootPath', async () => {
    const info: ProjectSetupTargetInfo = { name: 'proj', cwd: '/repo' }
    const result = await resolveProjectSetupTarget('p1', '/repo', info, okList([]))
    expect(result?.worktreePath).toBe(path.resolve('/repo'))
  })

  it('accepts a worktreePath matching a listed git worktree (sibling directory, NOT nested)', async () => {
    const info: ProjectSetupTargetInfo = { name: 'proj', cwd: '/repo' }
    const wt = '/repo.worktrees/my-branch'
    const result = await resolveProjectSetupTarget('p1', wt, info, okList(['/repo', wt]))
    expect(result?.worktreePath).toBe(path.resolve(wt))
  })

  it('refuses a worktreePath that is not a listed worktree', async () => {
    const info: ProjectSetupTargetInfo = { name: 'proj', cwd: '/repo' }
    const result = await resolveProjectSetupTarget('p1', '/etc/passwd', info, okList(['/repo']))
    expect(result).toBeNull()
  })

  it('refuses a relative worktreePath (must be absolute)', async () => {
    const info: ProjectSetupTargetInfo = { name: 'proj', cwd: '/repo' }
    const result = await resolveProjectSetupTarget('p1', 'relative/path', info, okList(['/repo']))
    expect(result).toBeNull()
  })

  it('refuses when the worktree listing itself failed (ok:false)', async () => {
    const info: ProjectSetupTargetInfo = { name: 'proj', cwd: '/repo' }
    const listFails = async (): Promise<WorktreeListResult> => ({ ok: false, entries: [] })
    const result = await resolveProjectSetupTarget('p1', '/repo.worktrees/b', info, listFails)
    expect(result).toBeNull()
  })

  it('refuses when the worktree listing throws', async () => {
    const info: ProjectSetupTargetInfo = { name: 'proj', cwd: '/repo' }
    const listThrows = async (): Promise<WorktreeListResult> => {
      throw new Error('git not found')
    }
    const result = await resolveProjectSetupTarget('p1', '/repo.worktrees/b', info, listThrows)
    expect(result).toBeNull()
  })

  it('builds an ssh target with no worktreePath', async () => {
    const ssh = { server: { host: 'h', user: 'u' }, remoteCwd: '/srv/app' }
    const info: ProjectSetupTargetInfo = { name: 'proj', ssh }
    const result = await resolveProjectSetupTarget('p1', undefined, info, okList([]))
    expect(result).toEqual({ projectId: 'p1', projectName: 'proj', rootPath: '/srv/app', ssh })
  })

  it('refuses an ssh target with a worktreePath — worktrees are local-only', async () => {
    const ssh = { server: { host: 'h', user: 'u' }, remoteCwd: '/srv/app' }
    const info: ProjectSetupTargetInfo = { name: 'proj', ssh }
    const result = await resolveProjectSetupTarget('p1', '/srv/app', info, okList([]))
    expect(result).toBeNull()
  })
})
