import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { localAgentCwd, resolveBinary } from './commit-message'

/**
 * The 2026-08-05 report: "AI commit message" failed on every SSH project with
 *
 *     Error: spawn /Users/enes/.local/bin/claude ENOENT
 *
 * which reads as "claude is not installed" and is not. Node reports a MISSING WORKING DIRECTORY as
 * `spawn <command> ENOENT`, naming the binary rather than the directory — and the directory was an
 * SSH project's cwd, a path that exists on the server and not on the Mac doing the spawning.
 *
 * The agent spawn is local by design (only the git reads route over the ControlMaster, and the diff
 * is inside the prompt by then), so the fix is to not hand it a remote path.
 */
describe('localAgentCwd', () => {
  it('uses the project folder for a LOCAL project', () => {
    expect(localAgentCwd('/Users/enes/code/app', false, '/Users/enes')).toBe('/Users/enes/code/app')
  })

  it('falls back to home for a REMOTE project — that path is on the server', () => {
    expect(localAgentCwd('/root/nodeterm', true, '/Users/enes')).toBe('/Users/enes')
  })

  it('falls back to home for a project with no folder at all', () => {
    // The pre-existing `cwd || os.homedir()` behaviour, kept.
    expect(localAgentCwd('', false, '/Users/enes')).toBe('/Users/enes')
  })
})

describe('runAgent — where the agent is actually spawned', () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  /**
   * Drives the REAL `runAgent` with `child_process.spawn` mocked, so what is asserted is the
   * directory the process would have been started in — the thing the bug was about. The helper
   * test above cannot catch a regression that stops CALLING the helper; this one can.
   */
  async function spawnCwdFor(cwd: string, remote: boolean): Promise<string | undefined> {
    // FIRST, before the mock: this file imports `commit-message` statically for `localAgentCwd`, so
    // without a reset the dynamic import below would hand back that already-loaded instance — the
    // one that closed over the REAL `spawn` at import time. The mock would then be installed and
    // never consulted, and the test would silently run `sh` for real and observe nothing.
    vi.resetModules()
    let seen: string | undefined
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process')
      return {
        ...actual,
        default: actual,
        spawn: (_bin: string, _args: string[], opts: { cwd: string }) => {
          seen = opts.cwd
          // The narrowest fake that lets `spawnAgent`'s promise settle: streams it reads, and a
          // close event carrying a usable message so the run does not take the error path.
          const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
          const child = {
            stdout: { on: (_e: string, cb: (d: Buffer) => void) => cb(Buffer.from('a message')) },
            stderr: { on: () => {} },
            stdin: { write: () => {}, end: () => {}, on: () => {} },
            kill: () => {},
            on: (e: string, cb: (...a: unknown[]) => void) => {
              ;(listeners[e] ??= []).push(cb)
              if (e === 'close') setTimeout(() => cb(0), 0)
            }
          }
          return child
        }
      }
    })
    // Both imports have to come AFTER `doMock`, and from the SAME fresh registry: `doMock` reloads
    // the whole graph, so a resolver set through the statically-imported module would be written to
    // a different instance than the one the reloaded `commit-message` reads.
    const remoteGit = await import('./remote-ssh/remote-git')
    remoteGit.setGitRemoteResolver(remote ? () => ({}) as never : null)
    const { runAgent } = await import('./commit-message')
    // `sh` rather than the claude/codex branches: `planAgent` resolves a real binary before
    // spawning, and this test is about the cwd, not about what is installed on the test machine.
    await runAgent('prompt', cwd, {
      commitAgent: 'custom',
      commitAgentCommand: 'sh',
      commitPromptExtra: ''
    } as never)
    return seen
  }

  it('spawns in the project folder for a local project', async () => {
    expect(await spawnCwdFor('/tmp', false)).toBe('/tmp')
  })

  it('does NOT spawn in an SSH project’s remote path — that is the ENOENT', async () => {
    // `/root/nodeterm` exists on the server and nowhere on the machine doing the spawning.
    expect(await spawnCwdFor('/root/nodeterm', true)).toBe(os.homedir())
  })
})

/**
 * `resolveBinary` decides which CLI "AI commit message" and "Name with AI" spawn. It was POSIX-only
 * in two ways at once on Windows: `startsWith('/')` never recognised an absolute path there, and the
 * hardcoded fallbacks are extensionless POSIX paths that no Windows install can match.
 */
describe('resolveBinary', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-resolve-bin-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('accepts an absolute path that exists, and rejects one that does not', () => {
    // The regression: on Windows this argument is `C:\…`, which `startsWith('/')` never matched, so
    // an absolute custom command fell through to the bare-name branch and was rejected there for
    // containing `:` and `\`.
    const bin = path.join(dir, 'agent.exe')
    fs.writeFileSync(bin, '', { mode: 0o755 })
    expect(resolveBinary(bin)).toBe(bin)
    expect(resolveBinary(path.join(dir, 'absent.exe'))).toBeNull()
  })

  it('refuses a relative path — only a bare name or an absolute path may be spawned', () => {
    // Anything that is not a bare binary name stays well out of injection territory.
    expect(resolveBinary('../../evil')).toBeNull()
    expect(resolveBinary('sub/dir/agent')).toBeNull()
    expect(resolveBinary('agent; rm -rf /')).toBeNull()
  })

  it('answers null for a bare name that is nowhere', () => {
    expect(resolveBinary('nt-definitely-not-installed')).toBeNull()
  })
})

describe.skipIf(process.platform !== 'win32')('runAgent — Windows npm shim', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-commit-shim-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps a hostile prompt as one argument without invoking cmd.exe', async () => {
    const cmd = path.join(dir, 'fake agent.cmd')
    const touched = path.join(dir, 'should-not-exist.txt')
    fs.writeFileSync(cmd, '@echo off\r\nexit /b 91\r\n')
    fs.writeFileSync(
      path.join(dir, 'fake agent.ps1'),
      [
        '$bytes = [Text.Encoding]::UTF8.GetBytes($args[0])',
        '[Console]::Out.Write([Convert]::ToBase64String($bytes))'
      ].join('\r\n')
    )
    const prompt = `message & echo pwned > "${touched}"`

    vi.resetModules()
    vi.doUnmock('child_process')
    const { runAgent } = await import('./commit-message')
    const result = await runAgent(prompt, dir, {
      commitAgent: 'custom',
      commitAgentCommand: `"${cmd}" "{prompt}"`,
      commitExtraPrompt: ''
    } as never)

    expect(result).toEqual({
      ok: true,
      message: Buffer.from(prompt, 'utf8').toString('base64')
    })
    expect(fs.existsSync(touched)).toBe(false)
  })
})
