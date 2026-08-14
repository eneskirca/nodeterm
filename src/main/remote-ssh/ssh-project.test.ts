import { promises as fs, writeFileSync } from 'fs'
import { request as httpRequest } from 'http'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshProjectManager, lastSshErrorLine } from './ssh-project'
import { AskpassServer } from './ssh-askpass'
import { AppSshAgent } from './ssh-agent'
import { controlPathFor } from '../../core/remote-ssh/control-master'
import type { SshConnection } from '@shared/ssh'

const conn: SshConnection = { host: 'h', user: 'u' }

function makeMgr() {
  const statuses: string[] = []
  // spawnMaster: returns a fake child that "stays up"; run: resolves stdout for one-shot ssh.
  const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn() }))
  const run = vi.fn(async (_args: string[], _stdin?: string) => ({ code: 0, stdout: 'src/\nbin/\n' }))
  const runScp = vi.fn(async (_args: string[]) => ({ code: 0 }))
  const mgr = new SshProjectManager({
    userDataDir: '/ud',
    spawnMaster,
    run,
    runScp,
    getHook: () => ({ port: 51234, token: 'tok', version: '1' }),
    onStatus: (e) => statuses.push(e.status)
  })
  return { mgr, statuses, spawnMaster, run }
}

describe('SshProjectManager', () => {
  it('connect emits connecting→connected and returns the control path', async () => {
    const { mgr, statuses } = makeMgr()
    const { controlPath } = await mgr.connect('p1', conn)
    expect(controlPath).toBe(controlPathFor('p1'))
    // (A later `connected` event can carry the async claude-CLI probe's answer, see below.)
    expect(statuses.slice(0, 2)).toEqual(['connecting', 'connected'])
  })

  it('connect is idempotent, second call reuses the live master', async () => {
    const { mgr, spawnMaster } = makeMgr()
    await mgr.connect('p1', conn)
    await mgr.connect('p1', conn)
    expect(spawnMaster).toHaveBeenCalledTimes(1)
  })

  it('listDir parses remote dir entries', async () => {
    const { mgr } = makeMgr()
    await mgr.connect('p1', conn)
    const { dirs } = await mgr.listDir('p1', '~')
    expect(dirs).toEqual(['bin', 'src'])
  })

  it('refForProject resolves {conn, controlPath} after connect, undefined otherwise', async () => {
    const { mgr } = makeMgr()
    expect(mgr.refForProject('p1')).toBeUndefined()
    await mgr.connect('p1', conn)
    expect(mgr.refForProject('p1')).toEqual({ conn, controlPath: controlPathFor('p1') })
    expect(mgr.refForProject('nope')).toBeUndefined()
  })

  it('refForRemoteCwd resolves {conn, controlPath} by the connected project remote cwd', async () => {
    const { mgr } = makeMgr()
    await mgr.connect('p1', conn, '/srv/repo')
    expect(mgr.refForRemoteCwd('/srv/repo')).toEqual({ conn, controlPath: controlPathFor('p1') })
    expect(mgr.refForRemoteCwd('/nope')).toBeUndefined()
  })

  it('writePendingAnswer writes the answer file over the master (atomic tmp+mv, decision on stdin)', async () => {
    const { mgr, run } = makeMgr()
    await mgr.connect('p1', conn)
    const ok = await mgr.writePendingAnswer('p1', 'node-1-2', 'allow')
    expect(ok).toBe(true)
    const call = run.mock.calls.find((c) => (c[0] as string[]).join(' ').includes('.answer'))
    expect(call).toBeTruthy()
    const cmd = (call![0] as string[]).join(' ')
    expect(cmd).toContain('umask 077')
    expect(cmd).toContain('.nodeterm/pending')
    // atomic tmp+mv: write to <id>.answer.tmp then rename onto <id>.answer.
    expect(cmd).toMatch(/cat > [\s\S]*\.answer\.tmp/)
    expect(cmd).toMatch(/mv -f [\s\S]*\.answer\.tmp[\s\S]*\.answer/)
    expect(call![1]).toBe('allow') // decision written on stdin
  })

  it('writePendingAnswer refuses an invalid pendingId and a disconnected project (no run)', async () => {
    const { mgr, run } = makeMgr()
    // Not connected → false, no ssh command issued.
    expect(await mgr.writePendingAnswer('p1', 'ok-id', 'allow')).toBe(false)
    await mgr.connect('p1', conn)
    const before = run.mock.calls.length
    expect(await mgr.writePendingAnswer('p1', '../evil', 'allow')).toBe(false)
    // @ts-expect-error, runtime guard against a bad decision value
    expect(await mgr.writePendingAnswer('p1', 'ok-id', 'always')).toBe(false)
    expect(run.mock.calls.length).toBe(before) // neither refusal touched ssh
  })

  it('uploadFile uploads via scp under <remoteHome>/.nodeterm/uploads/<token> and returns the abs path', async () => {
    const scpCalls: string[][] = []
    const run = vi.fn(async (args: string[]) =>
      args.join(' ').includes('printf %s') ? { code: 0, stdout: '/home/u' } : { code: 0, stdout: '' }
    )
    const runScp = vi.fn(async (args: string[]) => {
      scpCalls.push(args)
      return { code: 0 }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp,
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn()
    })
    await mgr.connect('p1', conn, '/srv/repo')
    const out = await mgr.uploadFile('p1', '/local/img.png', 'img.png')
    expect(out).toMatch(/^\/home\/u\/\.nodeterm\/uploads\/[a-z0-9]+\/img\.png$/)
    // scp targeted that exact absolute remote path (conn is { host: 'h', user: 'u' }).
    expect(scpCalls[0].join(' ')).toContain(`u@h:${out}`)
  })

  it('uploadFile basenames a traversal fileName so it cannot escape the token dir', async () => {
    const scpCalls: string[][] = []
    const run = vi.fn(async (args: string[]) =>
      args.join(' ').includes('printf %s') ? { code: 0, stdout: '/home/u' } : { code: 0, stdout: '' }
    )
    const runScp = vi.fn(async (args: string[]) => {
      scpCalls.push(args)
      return { code: 0 }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp,
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn()
    })
    await mgr.connect('p1', conn, '/srv/repo')
    // basename('../../evil') === 'evil' → sanitized to <dir>/evil; never escapes the token dir.
    const out = await mgr.uploadFile('p1', '/local/evil', '../../evil')
    expect(out).toMatch(/^\/home\/u\/\.nodeterm\/uploads\/[a-z0-9]+\/evil$/)
    expect(out).not.toContain('..')
    expect(scpCalls[0].join(' ')).toContain(`u@h:${out}`)
  })

  it('connect writes + source-files the remote tmux.conf and returns its absolute path', async () => {
    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push({ args, stdin })
      return args.join(' ').includes('printf %s')
        ? { code: 0, stdout: '/home/u' }
        : { code: 0, stdout: '' }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn()
    })
    const { tmuxConfPath } = await mgr.connect('p1', conn)
    expect(tmuxConfPath).toBe('/home/u/.nodeterm/tmux.conf')
    // The conf was written via `cat >` (with the conf body as stdin) and then source-file'd.
    const write = calls.find((c) => c.args.join(' ').includes(`cat > '/home/u/.nodeterm/tmux.conf'`))
    expect(write).toBeDefined()
    expect(write?.stdin).toContain('set -g mouse on')
    expect(calls.some((c) => c.args.join(' ').includes(`source-file '/home/u/.nodeterm/tmux.conf'`))).toBe(true)
  })

  /**
   * SECURITY — the remote `$HOME` is a HOST ANSWER, i.e. data. Both places `ssh-project` reads it
   * validate it (`isSafeRemoteHome`) before it becomes a remote path: `connect`, where it steers
   * the tmux.conf write AND is retained as `remoteHome` (which the PTY manager then splices into a
   * tmux `-e CLAUDE_CONFIG_DIR=…` pair), and `uploadFile`, which resolves it on demand.
   *
   * These two sites had NO test in the first version of this fix — reverting them left the suite
   * green, which made the mutation claim wrong. That is what these pin.
   */
  const mgrWithHome = (home: string) => {
    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push({ args, stdin })
      return args.join(' ').includes('printf %s') ? { code: 0, stdout: home } : { code: 0, stdout: '' }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn()
    })
    return { mgr, calls }
  }

  it('connect REFUSES a remote $HOME carrying a newline (no path built, nothing retained)', async () => {
    const { mgr, calls } = mgrWithHome('/home/u\nid > /tmp/pwned')
    const { tmuxConfPath } = await mgr.connect('p1', conn)
    // Fail-open: the features needing an absolute home are off, the connection itself still works.
    expect(tmuxConfPath).toBeUndefined()
    expect(mgr.remoteHomeFor('p1')).toBeUndefined()
    // and the hostile bytes reached no remote command line.
    expect(calls.some((c) => c.args.join(' ').includes('id > /tmp/pwned'))).toBe(false)
  })

  it('connect ACCEPTS a home with a space (the validator must not break real macOS homes)', async () => {
    const { mgr } = mgrWithHome('/Users/Enes Kirca')
    const { tmuxConfPath } = await mgr.connect('p1', conn)
    expect(tmuxConfPath).toBe('/Users/Enes Kirca/.nodeterm/tmux.conf')
    expect(mgr.remoteHomeFor('p1')).toBe('/Users/Enes Kirca')
  })

  it('uploadFile REFUSES a probed $HOME carrying a newline', async () => {
    const { mgr } = mgrWithHome('/home/u\nid')
    await mgr.connect('p1', conn) // connect also refuses it, so upload must re-probe and refuse too
    expect(await mgr.uploadFile('p1', '/local/f.png', 'f.png')).toBeNull()
  })

  it('connect leaves tmuxConfPath undefined when the remote conf write fails (no -f to a missing conf)', async () => {
    // The runner resolves (does not throw) on a non-zero remote exit. Fail the `cat >`/mkdir write
    // with code 1 while letting the $HOME probe succeed so remoteHome resolves, this isolates the
    // write-failure path. tmuxConfPath must stay undefined (so no `-f <missing-conf>`), yet connect
    // still succeeds and returns the control path.
    const run = vi.fn(async (args: string[]) => {
      const cmd = args.join(' ')
      if (cmd.includes('printf %s')) return { code: 0, stdout: '/home/u' }
      if (cmd.includes('cat > ') || cmd.includes('mkdir -p')) return { code: 1, stdout: '' }
      return { code: 0, stdout: '' }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn()
    })
    const { controlPath, tmuxConfPath } = await mgr.connect('p1', conn)
    expect(tmuxConfPath).toBeUndefined()
    expect(controlPath).toBe(controlPathFor('p1'))
  })

  // --- remote `claude --version` probe ------------------------------------------------------
  //
  // The probe runs through a LOGIN shell, so the user's profile can print banners to stdout. The
  // value is marker-delimited and only what sits between the markers is parsed, a banner version
  // (`Ubuntu 22.04.3`) must NEVER be read as claude's version, or every Claude node in the project
  // would launch `--permission-mode auto` on a CLI that exits 1 on it.
  const BANNER = 'Welcome, Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-89-generic)\nkernel 6.8.0-106\n'

  /** A manager whose remote claude probe answers with `banner + <markers>version</markers>`.
   *  Pass an array to script successive probe attempts (retry coverage); the last entry repeats. */
  function mgrWithClaude(versionOut: string | null | (string | null)[], retryDelaysMs?: number[]) {
    const outputs = Array.isArray(versionOut) ? versionOut : [versionOut]
    let probeCalls = 0
    const events: {
      status: string
      claudeAutoPermissionMode?: boolean
      remoteClaudeVersion?: string | null
    }[] = []
    const run = vi.fn(async (args: string[]) => {
      const cmd = args.join(' ')
      if (cmd.includes('__NT_V_START__')) {
        const out = outputs[Math.min(probeCalls++, outputs.length - 1)]
        return { code: 0, stdout: out === null ? BANNER : `${BANNER}${out}` }
      }
      if (cmd.includes('printf %s')) return { code: 0, stdout: '/home/u' }
      return { code: 0, stdout: '' }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: (e) =>
        events.push({
          status: e.status,
          claudeAutoPermissionMode: e.claudeAutoPermissionMode,
          remoteClaudeVersion: e.remoteClaudeVersion
        }),
      ...(retryDelaysMs ? { probeRetryDelaysMs: retryDelaysMs } : {})
    })
    return { mgr, events, run, probeCallCount: () => probeCalls }
  }

  const probeEvent = (
    events: { claudeAutoPermissionMode?: boolean; remoteClaudeVersion?: string | null }[]
  ) => events.find((e) => e.claudeAutoPermissionMode !== undefined)

  const probeEvents = (
    events: { claudeAutoPermissionMode?: boolean; remoteClaudeVersion?: string | null }[]
  ) => events.filter((e) => e.claudeAutoPermissionMode !== undefined)

  it('a login-shell BANNER around an OLD claude never reports auto support (merge blocker)', async () => {
    const { mgr, events } = mgrWithClaude('__NT_V_START__2.0.30 (Claude Code)__NT_V_END__')
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvent(events)).toBeDefined())
    // The banner's `22.04.3` is NOT the version: the CLI is 2.0.30 → no `--permission-mode auto`.
    expect(probeEvent(events)?.claudeAutoPermissionMode).toBe(false)
  })

  it('a banner with no claude output at all is a FAILED probe, not a modern CLI', async () => {
    const { mgr, events } = mgrWithClaude(null) // markers absent → unknown
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvent(events)).toBeDefined())
    expect(probeEvent(events)?.claudeAutoPermissionMode).toBe(false)
  })

  it('a modern claude behind a banner does report auto support', async () => {
    const { mgr, events } = mgrWithClaude('__NT_V_START__2.1.90 (Claude Code)__NT_V_END__')
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvent(events)).toBeDefined())
    expect(probeEvent(events)?.claudeAutoPermissionMode).toBe(true)
  })

  it('the status event carries the probed remote version (for the tab-menu hint)', async () => {
    const { mgr, events } = mgrWithClaude('__NT_V_START__2.0.30 (Claude Code)__NT_V_END__')
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvent(events)).toBeDefined())
    expect(probeEvent(events)?.remoteClaudeVersion).toBe('2.0.30 (Claude Code)')
  })

  it('a FAILED probe reports version null (distinguishable from "old CLI") and retries', async () => {
    // First attempt: markers absent (claude not found, e.g. a transient PATH/login-shell hiccup);
    // second attempt: a modern CLI. The first answer must land immediately (fail-open `false`,
    // version null) so launch paths never wait on retries, and the retry must upgrade it to `true`.
    const { mgr, events } = mgrWithClaude(
      [null, '__NT_V_START__2.1.90 (Claude Code)__NT_V_END__'],
      [1]
    )
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvents(events).length).toBeGreaterThanOrEqual(2))
    const probes = probeEvents(events)
    expect(probes[0]).toMatchObject({ claudeAutoPermissionMode: false, remoteClaudeVersion: null })
    expect(probes[probes.length - 1]).toMatchObject({
      claudeAutoPermissionMode: true,
      remoteClaudeVersion: '2.1.90 (Claude Code)'
    })
  })

  it('a definite version answer stops the retries (a CLI does not upgrade mid-connection)', async () => {
    const { mgr, events, probeCallCount } = mgrWithClaude(
      '__NT_V_START__2.0.30 (Claude Code)__NT_V_END__',
      [1, 1, 1]
    )
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvent(events)).toBeDefined())
    // Give any (wrong) retry loop time to fire before counting.
    await new Promise((r) => setTimeout(r, 30))
    expect(probeCallCount()).toBe(1)
  })

  it('gives up retrying after the configured attempts when claude never appears', async () => {
    const { mgr, events, probeCallCount } = mgrWithClaude(null, [1, 1])
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvents(events).length).toBeGreaterThanOrEqual(3))
    await new Promise((r) => setTimeout(r, 30))
    expect(probeCallCount()).toBe(3) // initial attempt + 2 retries, then stop
    expect(probeEvents(events).every((e) => e.claudeAutoPermissionMode === false)).toBe(true)
  })

  it('a reused connection returns the probed answer + version with the connect result', async () => {
    const { mgr, events } = mgrWithClaude('__NT_V_START__2.1.90 (Claude Code)__NT_V_END__')
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvent(events)).toBeDefined())
    const res = await mgr.connect('p1', conn)
    expect(res.claudeAutoPermissionMode).toBe(true)
    expect(res.remoteClaudeVersion).toBe('2.1.90 (Claude Code)')
  })

  it('connect does NOT wait on the claude probe (it runs after `connected`)', async () => {
    // The probe's `$SHELL -lc` sources nvm/conda inits and can take seconds; every remote terminal
    // in the project waits on connect, so the probe must be off that path.
    const events: string[] = []
    let releaseProbe: (() => void) | undefined
    const run = vi.fn(async (args: string[]) => {
      const cmd = args.join(' ')
      if (cmd.includes('__NT_V_START__')) {
        await new Promise<void>((r) => (releaseProbe = r)) // never resolves during this test
        return { code: 0, stdout: '' }
      }
      return { code: 0, stdout: '' }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: (e) => events.push(e.status)
    })
    const res = await mgr.connect('p1', conn) // resolves while the probe is still hanging
    expect(events).toEqual(['connecting', 'connected'])
    expect(res.claudeAutoPermissionMode).toBeUndefined() // unknown ⇒ bare command (fail-open)
    releaseProbe?.()
  })

  it('remoteAccountAdd reads the version from the markers, not from banner noise', async () => {
    // Same probe, other consumer: an OLD remote CLI must still report versionSupported=false so the
    // keychain-collision warning survives (the banner's `22.04.3` would have suppressed it).
    const { mgr } = mgrWithClaude('__NT_V_START__2.0.14 (Claude Code)__NT_V_END__')
    await mgr.connect('p1', conn)
    expect((await mgr.remoteAccountAdd('p1', 'acc1'))?.versionSupported).toBe(false)

    const modern = mgrWithClaude('__NT_V_START__2.1.0 (Claude Code)__NT_V_END__')
    await modern.mgr.connect('p2', conn)
    expect((await modern.mgr.remoteAccountAdd('p2', 'acc1'))?.versionSupported).toBe(true)

    // Probe failed entirely (no markers) → fail-open true: adding an account is never blocked.
    const unknown = mgrWithClaude(null)
    await unknown.mgr.connect('p3', conn)
    expect((await unknown.mgr.remoteAccountAdd('p3', 'acc1'))?.versionSupported).toBe(true)
  })

  // --- downloadFile (remote → this machine) -------------------------------------------------
  // These run against a REAL temp directory: collision resolution, the `.part` staging file and
  // the rename are filesystem behavior, and mocking the fs would only test the mock.
  describe('downloadFile', () => {
    const tmpDirs: string[] = []
    async function destDir(): Promise<string> {
      const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-dl-'))
      tmpDirs.push(d)
      return d
    }
    afterEach(async () => {
      for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
    })

    /** `isDir` decides what the remote `test -d` probe answers; scp "succeeds" by creating the
     *  local target it was told to write, so the rename step is exercised for real. */
    function makeDlMgr(isDir = false, scpCode = 0) {
      const scpCalls: string[][] = []
      const run = vi.fn(async (args: string[]) => ({
        code: args.join(' ').includes('test -d') ? (isDir ? 0 : 1) : 0,
        stdout: ''
      }))
      const runScp = vi.fn(async (args: string[]) => {
        scpCalls.push(args)
        if (scpCode === 0) {
          const local = args[args.length - 1]
          if (isDir) await fs.mkdir(local, { recursive: true })
          else await fs.writeFile(local, 'payload')
        }
        return { code: scpCode }
      })
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
        run,
        runScp,
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn()
      })
      return { mgr, scpCalls, runScp }
    }

    it('lands the file under its remote basename and stages through .part', async () => {
      const { mgr, scpCalls } = makeDlMgr()
      await mgr.connect('p1', conn, '/srv/repo')
      const dir = await destDir()
      const res = await mgr.downloadFile('p1', '/srv/repo/notes.md', dir)
      expect(res).toEqual({ ok: true, localPath: path.join(dir, 'notes.md'), dir: false })
      expect(await fs.readFile(path.join(dir, 'notes.md'), 'utf8')).toBe('payload')
      // scp wrote to `<target>.part`, never straight to the final name.
      expect(scpCalls[0][scpCalls[0].length - 1]).toBe(path.join(dir, 'notes.md.part'))
      expect(await fs.readdir(dir)).toEqual(['notes.md'])
    })

    it('never overwrites an existing file, it takes the next (n) name', async () => {
      const { mgr } = makeDlMgr()
      await mgr.connect('p1', conn, '/srv/repo')
      const dir = await destDir()
      await fs.writeFile(path.join(dir, 'notes.md'), 'mine')
      const res = await mgr.downloadFile('p1', '/srv/repo/notes.md', dir)
      expect(res).toMatchObject({ ok: true, localPath: path.join(dir, 'notes (2).md') })
      expect(await fs.readFile(path.join(dir, 'notes.md'), 'utf8')).toBe('mine')
    })

    it('passes -r for a remote directory (probed on the host, not taken from the renderer)', async () => {
      const { mgr, scpCalls } = makeDlMgr(true)
      await mgr.connect('p1', conn, '/srv/repo')
      const dir = await destDir()
      const res = await mgr.downloadFile('p1', '/srv/repo/docs', dir)
      expect(res).toMatchObject({ ok: true, dir: true })
      expect(scpCalls[0]).toContain('-r')
    })

    it('a failed transfer leaves nothing behind, no target, no .part', async () => {
      const { mgr } = makeDlMgr(false, 1)
      await mgr.connect('p1', conn, '/srv/repo')
      const dir = await destDir()
      const res = await mgr.downloadFile('p1', '/srv/repo/notes.md', dir)
      expect(res.ok).toBe(false)
      expect(await fs.readdir(dir)).toEqual([])
    })

    it('refuses a remote path that names nothing downloadable, without invoking scp', async () => {
      const { mgr, runScp } = makeDlMgr()
      await mgr.connect('p1', conn, '/srv/repo')
      const dir = await destDir()
      for (const p of ['/', '/srv/repo/..', '~']) {
        expect((await mgr.downloadFile('p1', p, dir)).ok).toBe(false)
      }
      expect(runScp).not.toHaveBeenCalled()
    })

    it('fails (never throws) when the project is not connected', async () => {
      const { mgr } = makeDlMgr()
      expect(await mgr.downloadFile('nope', '/x/y.txt', await destDir())).toMatchObject({ ok: false })
    })
  })

  it('uploadFile fails open (null) when not connected', async () => {
    const { mgr } = makeMgr()
    expect(await mgr.uploadFile('nope', '/x', 'x')).toBeNull()
  })

  it('uploadFile rejects a non-absolute localPath (argv flag-smuggling guard)', async () => {
    const scpCalls: string[][] = []
    const run = vi.fn(async (args: string[]) =>
      args.join(' ').includes('printf %s') ? { code: 0, stdout: '/home/u' } : { code: 0, stdout: '' }
    )
    const runScp = vi.fn(async (args: string[]) => { scpCalls.push(args); return { code: 0 } })
    const mgr = new SshProjectManager({
      userDataDir: '/ud', spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run, runScp, getHook: () => ({ port: 1, token: 't', version: '1' }), onStatus: vi.fn()
    })
    await mgr.connect('p1', conn, '/srv/repo')
    // A leading `-` would be parsed by scp as an OPTION (e.g. -oProxyCommand=…) → reject; also relative.
    expect(await mgr.uploadFile('p1', '-oProxyCommand=touch /tmp/pwned', 'x.png')).toBeNull()
    expect(await mgr.uploadFile('p1', 'relative/path.png', 'x.png')).toBeNull()
    expect(scpCalls).toHaveLength(0) // scp never invoked for an unsafe localPath
  })

  // --- leftover ControlMaster socket handling -----------------------------------------------
  //
  // A master socket FILE can outlive its process (app crash, `kill -9`, host sleep). ssh's
  // ControlMaster=auto refuses to bind over an existing socket file, so a stale one makes every
  // `-O check` fail and connect() time out with a generic error, the field-reported "SSH
  // connection error" with no cause. A fresh connect must clear a dead leftover before spawning.
  describe('leftover master socket', () => {
    const isCheck = (args: string[]) => args[0] === '-O' && args[1] === 'check'

    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    it('unlinks a DEAD leftover socket before spawning a fresh master', async () => {
      const statuses: string[] = []
      let masterUp = false
      const spawnMaster = vi.fn(() => {
        masterUp = true
        return { kill: vi.fn(), on: vi.fn() }
      })
      // The leftover master is dead → `-O check` fails until we spawn our own.
      const run = vi.fn(async (args: string[]) =>
        isCheck(args) ? { code: masterUp ? 0 : 1, stdout: '' } : { code: 0, stdout: '' }
      )
      vi.spyOn(fs, 'stat').mockResolvedValue({ isSocket: () => true } as never)
      const rmSpy = vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: (e) => statuses.push(e.status)
      })
      const { controlPath } = await mgr.connect('p1', conn)
      expect(rmSpy).toHaveBeenCalledWith(controlPathFor('p1'), { force: true })
      expect(spawnMaster).toHaveBeenCalledTimes(1)
      expect(controlPath).toBe(controlPathFor('p1'))
      expect(statuses.slice(0, 2)).toEqual(['connecting', 'connected'])
    })

    it('adopts a LIVE orphan master (whose hook tunnel verifies) instead of spawning a second one', async () => {
      const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn() }))
      // Live master answers `-O check`; its reverse hook tunnel VERIFIES (the curl returns 204), so
      // `remoteHooks.setup` succeeds and the orphan is kept, no fresh master is built.
      const run = vi.fn(async (args: string[]) => {
        const j = args.join(' ')
        if (j.includes('$HOME')) return { code: 0, stdout: '/home/u' }
        if (j.includes('%{http_code}')) return { code: 0, stdout: '204' }
        return { code: 0, stdout: '' }
      })
      vi.spyOn(fs, 'stat').mockResolvedValue({ isSocket: () => true } as never)
      const rmSpy = vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
      const statuses: string[] = []
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: (e) => statuses.push(e.status)
      })
      await mgr.connect('p1', conn)
      expect(spawnMaster).not.toHaveBeenCalled() // reused, not respawned
      expect(rmSpy).not.toHaveBeenCalled() // a live socket is never unlinked
      expect(statuses.slice(0, 2)).toEqual(['connecting', 'connected'])
    })

    it('rebuilds a FRESH master when the adopted orphan cannot re-establish the hook tunnel', async () => {
      // Fresh-launch-straight-to-SSH field bug: the adopted live-orphan master still serves the
      // PREVIOUS run's reverse-hook forward (dead port), so `setup()`'s tunnel never verifies over it.
      // The reverse tunnel, and with it every remote agent's status hooks, must come back WITHOUT
      // any local activity, so connect() drops the orphan and rebuilds a fresh master, over which the
      // tunnel verifies. The `%{http_code}` curl answers 000 (dead) until a fresh master is spawned.
      let respawned = false
      const seq: string[] = []
      const spawnMaster = vi.fn(() => {
        respawned = true
        seq.push('spawn')
        return { kill: vi.fn(), on: vi.fn() }
      })
      const run = vi.fn(async (args: string[]) => {
        const j = args.join(' ')
        if (j.includes('$HOME')) return { code: 0, stdout: '/home/u' }
        if (j.includes('%{http_code}')) return { code: 0, stdout: respawned ? '204' : '000' }
        return { code: 0, stdout: '' }
      })
      vi.spyOn(fs, 'stat').mockResolvedValue({ isSocket: () => true } as never)
      const rmSpy = vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
      const statuses: string[] = []
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 51234, token: 'tok', version: '1' }),
        onStatus: (e) => statuses.push(e.status),
        // The rebuild is the SECOND spawn site: it too must have the app agent listening before
        // ssh authenticates, or the rebuilt master's unlocked key goes nowhere. The fresh-spawn
        // ordering test cannot catch this site; asserting it here does.
        ensureAgent: vi.fn(async () => {
          await new Promise((r) => setImmediate(r))
          seq.push('agent')
        })
      })
      const info = await mgr.connect('p1', conn)
      // The orphan was dropped (its `-O exit` ran + socket unlinked) and a fresh master spawned once.
      expect(run.mock.calls.some(([a]) => a[0] === '-O' && a[1] === 'exit')).toBe(true)
      expect(rmSpy).toHaveBeenCalledWith(controlPathFor('p1'), { force: true })
      expect(spawnMaster).toHaveBeenCalledTimes(1)
      expect(seq).toEqual(['agent', 'spawn']) // agent up BEFORE the rebuilt master, on this site too
      // The retried setup over the fresh master verified → the remote endpoint file is advertised.
      expect(info.hookEndpointPath).toBe('/home/u/.nodeterm/hook-endpoint-p1.env')
      expect(statuses.slice(0, 2)).toEqual(['connecting', 'connected'])
    })

    it('the orphan-rebuild wait runs on connect-loop terms, not a fixed 5s inner loop', async () => {
      // F6 regression: the rebuilt master can need an askpass passphrase (agent cold), which takes
      // longer than any fixed few-second loop. The old inner `for (j < 50)` wait expired while the
      // dialog was still open and then FELL THROUGH into the success block: status said connected,
      // no socket was bound, and hookEndpointPath was lost (the very field bug the rebuild cures).
      // Here the rebuilt master stays alive (prompting) for ~7s before binding, which is past the
      // 5s base budget and far past what the old inner loop allowed. The connect must wait it out
      // and only then report connected WITH the verified endpoint path.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockResolvedValue({ isSocket: () => true } as never)
      vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
      vi.useFakeTimers()
      let respawned = false
      let checksAfterRespawn = 0
      const BIND_AT = 70 // 100ms cadence ⇒ ~7s: past BASE_WAIT_MS and past the old 50-check loop
      const spawnMaster = vi.fn(() => {
        respawned = true
        return { kill: vi.fn(), on: vi.fn(), stderr: () => '', exited: () => false }
      })
      const run = vi.fn(async (args: string[]) => {
        const j = args.join(' ')
        if (args[0] === '-O' && args[1] === 'check') {
          if (!respawned) return { code: 0, stdout: '' } // the live orphan answers
          checksAfterRespawn++
          return { code: checksAfterRespawn >= BIND_AT ? 0 : 1, stdout: '' }
        }
        if (j.includes('$HOME')) return { code: 0, stdout: '/home/u' }
        if (j.includes('%{http_code}')) return { code: 0, stdout: respawned ? '204' : '000' }
        return { code: 0, stdout: '' }
      })
      const statuses: string[] = []
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 51234, token: 'tok', version: '1' }),
        onStatus: (e) => statuses.push(e.status)
      })
      const connectPromise = mgr.connect('p1', conn)
      await vi.advanceTimersByTimeAsync(15_000)
      const info = await connectPromise
      expect(spawnMaster).toHaveBeenCalledTimes(1)
      expect(checksAfterRespawn).toBeGreaterThanOrEqual(BIND_AT)
      // The retried setup over the (slow) fresh master verified, so the endpoint is not dropped.
      expect(info.hookEndpointPath).toBe('/home/u/.nodeterm/hook-endpoint-p1.env')
      expect(statuses).toContain('connected')
    })

    it('a rebuilt master that never comes up FAILS the connect instead of reporting connected', async () => {
      // The other half of F6: the old fall-through declared success unconditionally, so a rebuilt
      // master that died (cancelled prompt, auth failure) still produced status 'connected' with
      // no socket behind it. It must fail, with the REBUILT master's stderr as the cause.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockResolvedValue({ isSocket: () => true } as never)
      vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
      vi.useFakeTimers()
      let respawned = false
      const spawnMaster = vi.fn(() => {
        respawned = true
        return {
          kill: vi.fn(),
          on: vi.fn(),
          stderr: () => 'root@h: Permission denied (publickey).',
          exited: () => true
        }
      })
      const run = vi.fn(async (args: string[]) => {
        const j = args.join(' ')
        if (args[0] === '-O' && args[1] === 'check') return { code: respawned ? 1 : 0, stdout: '' }
        if (j.includes('$HOME')) return { code: 0, stdout: '/home/u' }
        if (j.includes('%{http_code}')) return { code: 0, stdout: '000' } // tunnel never verifies
        return { code: 0, stdout: '' }
      })
      const statuses: string[] = []
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 51234, token: 'tok', version: '1' }),
        onStatus: (e) => statuses.push(e.status)
      })
      const assertion = expect(mgr.connect('p1', conn)).rejects.toThrow('Permission denied (publickey)')
      await vi.advanceTimersByTimeAsync(3000)
      await assertion
      expect(statuses).not.toContain('connected')
      expect(statuses).toContain('error')
    })

    it('a dead adopted orphan fails on the base budget with a generic error, even while ANOTHER prompt is up', async () => {
      // F3+F9: the adopted-orphan handle has no exited()/pid()/stderr(). It also positively
      // cannot prompt (it authenticated in a previous run), so (a) an outstanding prompt that
      // necessarily belongs to a DIFFERENT project must not stretch this failure from 5s to the
      // 300s prompt ceiling, and (b) the 60s global cancel clock must not relabel the failure
      // as "cancelled". Here the orphan answers the adoption probe then dies: both fallbacks
      // scream true, and the connect must ignore them.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockResolvedValue({ isSocket: () => true } as never)
      vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
      vi.useFakeTimers()
      let probed = false
      const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn() }))
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === '-O' && args[1] === 'check') {
          if (!probed) {
            probed = true
            return { code: 0, stdout: '' } // adoption probe: the orphan still answered…
          }
          return { code: 1, stdout: '' } // …and died before the wait loop's first check
        }
        return { code: 0, stdout: '' }
      })
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        askpassIsPrompting: () => true, // another project's dialog is open the whole time
        askpassWasCancelled: (pid) => pid === undefined // the global-clock fallback would say yes
      })
      // Generic failure, not the passphrase-cancel message, and within ~5s, not 300s: if either
      // guess leaked through, this either times out (extended wait) or throws the wrong message.
      const assertion = expect(mgr.connect('p1', conn)).rejects.toThrow(
        'Could not establish the SSH connection.'
      )
      await vi.advanceTimersByTimeAsync(6000)
      await assertion
      expect(spawnMaster).not.toHaveBeenCalled() // adopted, never respawned
    })

    it('skips the probe entirely when no socket file exists (the normal path)', async () => {
      const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn() }))
      const checks: string[][] = []
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === '-O' && args[1] === 'check') checks.push(args)
        return { code: 0, stdout: '' }
      })
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const rmSpy = vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn()
      })
      await mgr.connect('p1', conn)
      expect(spawnMaster).toHaveBeenCalledTimes(1)
      expect(rmSpy).not.toHaveBeenCalled() // nothing to clean
      // Only the connect loop's `-O check` runs, no extra leftover-probe round-trip.
      expect(checks.length).toBeGreaterThanOrEqual(1)
    })
  })

  // --- the reverse hook tunnel came back --------------------------------------------------------
  //
  // Hook POSTs are fire-and-forget, so every agent event fired while the master was down is gone.
  // Production hangs the working-agent resync off this hook; the gate it needs is "a master was
  // genuinely (re-)established", which connect()'s own control flow already answers.
  describe('tunnel-verified hook', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    /** A manager whose remote hook tunnel VERIFIES: `$HOME` resolves and the verify curl answers
     *  204, exactly as in the live-orphan tests above (the shared `makeMgr` runner answers neither,
     *  so its tunnel never verifies and no endpoint path is ever produced). No leftover socket, so
     *  connect() takes the ordinary fresh-master path — a genuine establish. */
    function makeVerifiedMgr(
      onTunnelVerified: (projectId: string, controlPath: string, conn: SshConnection) => void,
      httpCode = '204'
    ) {
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const run = vi.fn(async (args: string[]) => {
        const j = args.join(' ')
        if (j.includes('$HOME')) return { code: 0, stdout: '/home/u' }
        if (j.includes('%{http_code}')) return { code: 0, stdout: httpCode }
        return { code: 0, stdout: '' }
      })
      return new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        onTunnelVerified
      })
    }

    it('fires after a genuine re-establish, naming the project, its control path and its connection', async () => {
      const onTunnelVerified = vi.fn()
      const mgr = makeVerifiedMgr(onTunnelVerified)
      await mgr.connect('p1', conn, '/remote/cwd')
      // The connection rides along because the resync builds its own remote commands with it.
      expect(onTunnelVerified).toHaveBeenCalledWith('p1', controlPathFor('p1'), conn)
    })

    it('fires only once the project entry is written — the resync needs the cached remote $HOME', async () => {
      // Ordering, not decoration. The resync's transcript leg resolves the host's transcript root
      // through `remoteHomeForControlPath`, and that reads the field off the project entry — which
      // is created at master spawn WITHOUT it. Firing before the entry update therefore handed the
      // locator `undefined` every single time, not occasionally. That leg is the only one that can
      // tell "the CLI still owns the pane but the turn ended" (a finished Claude sitting at its
      // prompt) from "still working"; without it the feature degrades to catching an exited CLI.
      let mgr: SshProjectManager | undefined
      let homeAtHookTime: string | undefined | 'hook-never-fired' = 'hook-never-fired'
      mgr = makeVerifiedMgr((_projectId, controlPath) => {
        homeAtHookTime = mgr?.remoteHomeForControlPath(controlPath)
      })
      await mgr.connect('p1', conn, '/remote/cwd')
      expect(homeAtHookTime).toBe('/home/u')
    })

    it('does NOT fire on the reuse branch — a live master never lost its tunnel', async () => {
      const onTunnelVerified = vi.fn()
      const mgr = makeVerifiedMgr(onTunnelVerified)
      await mgr.connect('p1', conn, '/remote/cwd')
      onTunnelVerified.mockClear()
      await mgr.connect('p1', conn, '/remote/cwd') // `-O check` answers → early return
      expect(onTunnelVerified).not.toHaveBeenCalled()
    })

    it('does NOT fire when the tunnel failed verification (there is nothing to resync through)', async () => {
      const onTunnelVerified = vi.fn()
      const mgr = makeVerifiedMgr(onTunnelVerified, '000') // dead listener → setup() returns null
      await mgr.connect('p1', conn, '/remote/cwd')
      expect(onTunnelVerified).not.toHaveBeenCalled()
    })

    it('a THROWING hook still leaves the connect successful — the resync is never load-bearing', async () => {
      // The contract is structural, not a property of today's callback: what this hook drives will
      // grow, and a throw inside it must never surface to the user as a dead SSH project. Same rule
      // as `onStatus` above, which used to abort connect() mid-flight.
      const mgr = makeVerifiedMgr(() => {
        throw new Error('resync blew up')
      })
      const res = await mgr.connect('p1', conn, '/remote/cwd')
      expect(res.controlPath).toBe(controlPathFor('p1'))
      // Everything AFTER the hook still ran: the connect result is complete, not truncated.
      expect(res.hookEndpointPath).toBe('/home/u/.nodeterm/hook-endpoint-p1.env')
      expect(res.remoteHome).toBe('/home/u')
    })
  })

  // --- concurrent connect for one project ---------------------------------------------------
  //
  // Four callers can fire at once (watchdog revalidateAll, powerMonitor resume, the renderer's
  // SshReconnector backoff, a tab switch). They used to race through the `existing` branch and
  // kill each other's in-flight master, which surfaced as an empty-stderr generic failure while
  // the surviving master was torn down underneath the winner.
  describe('concurrent connect', () => {
    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    it('coalesces simultaneous connects into ONE master', async () => {
      const { mgr, spawnMaster } = makeMgr()
      const [a, b, c] = await Promise.all([
        mgr.connect('p1', conn),
        mgr.connect('p1', conn),
        mgr.connect('p1', conn)
      ])
      expect(spawnMaster).toHaveBeenCalledTimes(1)
      expect(a.controlPath).toBe(controlPathFor('p1'))
      expect(b).toEqual(a)
      expect(c).toEqual(a)
    })

    it('a watchdog revalidate during an in-flight connect does not kill its master', async () => {
      const { mgr, spawnMaster } = makeMgr()
      const first = mgr.connect('p1', conn)
      const viaWatchdog = mgr.revalidateAll() // hits connect() for the same project
      await Promise.all([first, viaWatchdog])
      expect(spawnMaster).toHaveBeenCalledTimes(1)
      const killed = spawnMaster.mock.results[0].value as { kill: ReturnType<typeof vi.fn> }
      expect(killed.kill).not.toHaveBeenCalled()
      expect(mgr.refForProject('p1')).toBeTruthy()
    })

    it('a disconnected project starts a FRESH connect instead of coalescing onto the stale attempt', async () => {
      // Without disconnect clearing `inFlight`, a connect() issued after a disconnect coalesces
      // onto the doomed attempt (its master was killed) and returns that result instead of
      // establishing a live master. Clearing inFlight on disconnect makes the reconnect spawn a
      // new master rather than recycling the dead attempt.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      let releaseCheck: (() => void) | undefined
      let gate: Promise<void> | null = new Promise((r) => (releaseCheck = r))
      const spawnMaster = vi.fn((_args: string[]) => ({ kill: vi.fn(), on: vi.fn(), stderr: () => '', exited: () => false }))
      const run = vi.fn(async (args: string[]) => {
        // Hold the connect's first `-O check` so it is genuinely in flight when we disconnect.
        if (args[0] === '-O' && args[1] === 'check' && gate) {
          const g = gate
          gate = null
          await g
        }
        return { code: 0, stdout: '' }
      })
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn()
      })
      const first = mgr.connect('p1', conn) // blocked mid-connect
      // Let the first attempt pass its (microtask-ish) setup so it spawns + registers conns before
      // we tear it down; otherwise disconnect() runs before the attempt has registered and finds
      // nothing to disconnect (a false pass that wouldn't exercise the inFlight fix).
      await new Promise((resolve) => setImmediate(resolve))
      await mgr.disconnect('p1') // tears the master down and (the fix) clears inFlight
      const second = mgr.connect('p1', conn) // reconnect while the old attempt is still queued
      releaseCheck!()
      await Promise.all([first, second])
      expect(spawnMaster).toHaveBeenCalledTimes(2) // the second connect spawned a fresh master
      expect(mgr.refForProject('p1')).toBeTruthy()
    })

    it('a coalesced join still applies its remoteCwd once the shared attempt lands', async () => {
      // The `existing` reuse branch updates remoteCwd on every call; the coalescing join used to
      // drop it, leaving refForRemoteCwd unable to route remote git ops for the joiner's folder.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      let releaseCheck: (() => void) | undefined
      let gate: Promise<void> | null = new Promise((r) => (releaseCheck = r))
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === '-O' && args[1] === 'check' && gate) {
          const g = gate
          gate = null
          await g // hold the first attempt so the second call really joins it
        }
        return { code: 0, stdout: '' }
      })
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn()
      })
      const first = mgr.connect('p1', conn) // e.g. the watchdog: no remoteCwd
      const second = mgr.connect('p1', conn, '/srv/repo') // the tab switch names the folder
      releaseCheck!()
      await Promise.all([first, second])
      expect(mgr.refForRemoteCwd('/srv/repo')).toEqual({ conn, controlPath: controlPathFor('p1') })
    })

    it('an edited endpoint unlinks the old socket so the leftover probe cannot re-adopt it', async () => {
      // disconnect() FIRES `-O exit` without awaiting it, and kill() does nothing to a master that
      // already daemonized, so the old master is typically still answering when the leftover-socket
      // probe runs a few lines later. The probe would adopt it as a live orphan and leave the
      // project on the OLD endpoint. The fs mock is STATEFUL on purpose: a stat that keeps
      // reporting a socket after rm() cannot tell the two behaviors apart, and an earlier version
      // of this test passed against the bug for exactly that reason.
      let socketOnDisk = true
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockImplementation(async () => {
        if (socketOnDisk) return { isSocket: () => true } as never
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      vi.spyOn(fs, 'rm').mockImplementation(async () => {
        socketOnDisk = false
      })
      const spawnMaster = vi.fn(() => {
        socketOnDisk = true // a fresh master binds its own socket
        return { kill: vi.fn(), on: vi.fn(), stderr: () => '', exited: () => false }
      })
      // Everything answers, INCLUDING the remote hook setup, so an adopted orphan would be kept
      // rather than rescued by the orphan-rebuild path (which would spawn and mask the bug).
      const run = vi.fn(async (args: string[]) => {
        const j = args.join(' ')
        if (j.includes('$HOME')) return { code: 0, stdout: '/home/u' }
        if (j.includes('%{http_code}')) return { code: 0, stdout: '204' }
        return { code: 0, stdout: '' }
      })
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn()
      })
      await mgr.connect('p1', { host: 'old.example.com', user: 'u' })
      spawnMaster.mockClear()
      run.mockClear()
      await mgr.connect('p1', { host: 'new.example.com', user: 'u' })
      // A FRESH master was built for the new host. Without the unlink the probe finds the old
      // socket still answering and adopts it, and spawnMaster is never called at all.
      expect(spawnMaster).toHaveBeenCalledTimes(1)
      // and the teardown was aimed at the OLD endpoint before the socket went away.
      expect(run.mock.calls.some(([a]) => a.includes('exit') && a.includes('u@old.example.com'))).toBe(true)
    })

    it('revalidateAll re-reads each project rather than trusting a stale snapshot', async () => {
      // The race needs a pass that is ALREADY RUNNING when the user repoints a server: the loop
      // snapshots every entry up front, so a later iteration would reconnect its project using the
      // conn as it was before the edit, tearing down the master just built for the new endpoint.
      // A single-project test cannot express this, because the snapshot and its use are adjacent.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
      let releaseSlow: (() => void) | undefined
      const slowGate = new Promise<void>((r) => (releaseSlow = r))
      let gateArmed = false
      const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), stderr: () => '', exited: () => false }))
      const run = vi.fn(async (args: string[]) => {
        // Hold the FIRST project's revalidate open so the edit below lands mid-pass.
        if (gateArmed && args.includes('u@slow.example.com')) await slowGate
        return { code: 0, stdout: '' }
      })
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn()
      })
      await mgr.connect('slow', { host: 'slow.example.com', user: 'u' })
      await mgr.connect('p2', { host: 'old.example.com', user: 'u' })

      gateArmed = true
      const pass = mgr.revalidateAll() // snapshots BOTH projects, then blocks on 'slow'
      await new Promise((r) => setTimeout(r, 0))
      await mgr.connect('p2', { host: 'new.example.com', user: 'u' }) // the user repoints p2
      const spawnsAfterEdit = spawnMaster.mock.calls.length
      releaseSlow?.()
      await pass

      // The pass must reuse p2's NEW master, not re-establish the endpoint its snapshot recorded.
      expect(mgr.refForProject('p2')?.conn.host).toBe('new.example.com')
      expect(spawnMaster.mock.calls.length).toBe(spawnsAfterEdit)
      expect(run.mock.calls.some(([a]) => a.includes('exit') && a.includes('u@new.example.com'))).toBe(false)
    })

    it('a connect naming an EDITED endpoint never shares the in-flight attempt to the old one', async () => {
      // Joining across different endpoints handed the caller a connection to the WRONG server
      // (the old attempt's result). The joiner must wait the old attempt out and then establish
      // a master to ITS endpoint, tearing the old-endpoint master down on the way.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      let releaseCheck: (() => void) | undefined
      let gate: Promise<void> | null = new Promise((r) => (releaseCheck = r))
      const targets: string[] = []
      const spawnMaster = vi.fn((args: string[]) => {
        targets.push(args[args.length - 1]) // masterArgs puts user@host last
        return { kill: vi.fn(), on: vi.fn() }
      })
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === '-O' && args[1] === 'check' && gate) {
          const g = gate
          gate = null
          await g
        }
        return { code: 0, stdout: '' }
      })
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn()
      })
      const first = mgr.connect('p1', { host: 'h1', user: 'u' })
      const second = mgr.connect('p1', { host: 'h2', user: 'u' })
      releaseCheck!()
      await first
      await second
      expect(spawnMaster).toHaveBeenCalledTimes(2)
      expect(targets).toEqual(['u@h1', 'u@h2'])
      // The map now owns the NEW endpoint, and the old-endpoint master was truly exited
      // (`-O exit` over its socket, so a daemonized ControlPersist master dies too).
      expect(mgr.refForProject('p1')?.conn).toEqual({ host: 'h2', user: 'u' })
      expect(run.mock.calls.some(([a]) => (a as string[])[0] === '-O' && (a as string[])[1] === 'exit')).toBe(true)
    })

    it('maps an asking master pid back to its user@host so the passphrase dialog can name the server', async () => {
      // The askpass request carries only the asking ssh pid (the helper's $PPID). Without this
      // lookup the dialog can only name a key file, which is ambiguous when one key serves several
      // servers and the prompt came from the watchdog rather than the connect dialog.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), pid: () => 4242 })),
        run: vi.fn(async () => ({ code: 0, stdout: '' })),
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn()
      })
      await mgr.connect('p1', { host: 'h1', user: 'u' })
      expect(mgr.targetForMasterPid('4242')).toBe('u@h1')
      expect(mgr.targetForMasterPid('9999')).toBeUndefined() // an adopted orphan names nothing
      expect(mgr.targetForMasterPid('')).toBeUndefined()
    })

    it('an endpoint-edit connect stays coalesce-able while it waits (a second connect must not kill the waiting master)', async () => {
      // The endpoint-change branch tears the old master down through disconnect(), which drops the
      // project's `inFlight` entry. That entry belongs to the attempt that is STILL RUNNING, and
      // the attempt then parks in the master wait loop for as long as the passphrase prompt takes.
      // With it gone, a concurrent connect for the same project no longer coalesces: it takes the
      // reuse branch, its `-O check` fails against the not-yet-bound socket, and it KILLS the
      // master that is sitting on the prompt and spawns a second one for the same control path.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const h1 = { host: 'h1', user: 'u' }
      const h2 = { host: 'h2', user: 'u' }
      const targets: string[] = []
      const kills: string[] = []
      const spawnMaster = vi.fn((args: string[]) => {
        const t = args[args.length - 1]
        targets.push(t)
        return { kill: vi.fn(() => kills.push(t)), on: vi.fn() }
      })
      // h2's socket does not answer until `bound` flips: exactly the window in which ssh is
      // waiting on the askpass prompt.
      let bound = false
      let sawH2Check: (() => void) | undefined
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === '-O' && args[1] === 'check' && args[args.length - 1] === 'u@h2') {
          sawH2Check?.()
          return { code: bound ? 0 : 1, stdout: '' }
        }
        return { code: 0, stdout: '' }
      })
      const nextH2Check = (): Promise<void> => new Promise<void>((r) => (sawH2Check = r))
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn()
      })
      await mgr.connect('p1', h1)
      const edited = mgr.connect('p1', h2) // endpoint edit: tears h1 down, then waits on h2
      await nextH2Check() // it is now parked in the wait loop, master alive, socket silent
      const concurrent = mgr.connect('p1', h2) // watchdog / second tab / reconnect dialog
      // Coalesced onto the SAME attempt, so nothing re-enters connectOnce to kill the waiter.
      expect(concurrent).toBe(edited)
      bound = true
      await Promise.all([edited, concurrent])
      expect(targets).toEqual(['u@h1', 'u@h2']) // one master per endpoint, no double spawn
      expect(kills).not.toContain('u@h2') // the waiting master survived
      expect(mgr.refForProject('p1')?.conn).toEqual(h2)
    })

    it('a reconnect after a server EDIT re-establishes on the new endpoint instead of reusing the old master', async () => {
      // Sequential flavor of the same defect: with a LIVE cached master, `-O check` answers for
      // the OLD server, and the reuse branch would return it for the edited conn.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const targets: string[] = []
      const spawnMaster = vi.fn((args: string[]) => {
        targets.push(args[args.length - 1])
        return { kill: vi.fn(), on: vi.fn() }
      })
      const run = vi.fn(async (_args: string[]) => ({ code: 0, stdout: '' }))
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn()
      })
      await mgr.connect('p1', { host: 'h1', user: 'u' })
      await mgr.connect('p1', { host: 'h1', user: 'u', label: 'renamed' }) // display-only change
      expect(spawnMaster).toHaveBeenCalledTimes(1) // a rename never tears down a healthy master
      await mgr.connect('p1', { host: 'h2', user: 'u' })
      expect(spawnMaster).toHaveBeenCalledTimes(2)
      expect(targets).toEqual(['u@h1', 'u@h2'])
      expect(mgr.refForProject('p1')?.conn).toEqual({ host: 'h2', user: 'u' })
    })

    it('a failed attempt never tears down a replacement master it does not own', async () => {
      // The loser of a race must kill its OWN master, not whatever sits in the map by then.
      // connect() awaits real fs promises, which fake timers cannot flush; stub them first.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      vi.useFakeTimers()
      let spawns = 0
      const spawnMaster = vi.fn(() => {
        spawns++
        return { kill: vi.fn(), on: vi.fn(), stderr: () => '', exited: () => spawns === 1 }
      })
      const run = vi.fn(async (args: string[]) =>
        args[0] === '-O' && args[1] === 'check' ? { code: 1, stdout: '' } : { code: 0, stdout: '' }
      )
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn()
      })
      const assertion = expect(mgr.connect('p1', conn)).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(2000)
      await assertion
      // Its own master was killed exactly once, and nothing else was touched.
      const own = spawnMaster.mock.results[0].value as { kill: ReturnType<typeof vi.fn> }
      expect(own.kill).toHaveBeenCalled()
    })
  })

  it('bounds the wait by WALL CLOCK, not attempt count, when each check is slow', async () => {
    // Regression: the loop counted attempts, but every attempt is a real `ssh -O check` process
    // whose cost is not fixed (up to run()'s 15s execFile timeout against a bound-but-unresponsive
    // master). An attempt-count ceiling therefore has no fixed wall-clock meaning: the same count
    // spans seconds or minutes depending on per-check cost. Here each check takes 3s and the
    // master is dead, so the 5s budget must end it in a couple of checks rather than tens.
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
    vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    vi.useFakeTimers()
    let checks = 0
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === '-O' && args[1] === 'check') {
        checks++
        await new Promise((r) => setTimeout(r, 3000)) // a slow, blocking check
        return { code: 1, stdout: '' }
      }
      return { code: 0, stdout: '' }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), stderr: () => '' })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn()
    })
    const assertion = expect(mgr.connect('p1', conn)).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
    // 5s budget at 3s per check: a small handful, nowhere near an attempt-count ceiling.
    expect(checks).toBeLessThanOrEqual(4)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('still connects when the socket binds only AFTER the master exits (ControlPersist handoff)', async () => {
    // What MASTER_EXIT_GRACE_CHECKS exists for: with ControlPersist the foreground ssh binds the
    // socket and then daemonizes and EXITS on success, so our poll can observe "exited" before it
    // observes the socket answering. Zero grace would declare that successful connect a failure.
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
    vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    vi.useFakeTimers()
    let checks = 0
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === '-O' && args[1] === 'check') {
        checks++
        return { code: checks >= 3 ? 0 : 1, stdout: '' } // answers on a check AFTER the exit
      }
      return { code: 0, stdout: '' }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      // exited() is true from the very first poll: the daemonize already happened.
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), stderr: () => '', exited: () => true })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn()
    })
    const connectPromise = mgr.connect('p1', conn)
    await vi.advanceTimersByTimeAsync(2000)
    const { controlPath } = await connectPromise
    expect(controlPath).toBe(controlPathFor('p1'))
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('the prompt-extended wait actually ENDS at its ceiling instead of waiting forever', async () => {
    // A master that stays alive without ever binding (hung askpass curl, wedged handshake) gets
    // the 300s prompt ceiling, and that ceiling must terminate: an accidental infinite wait
    // would leave the project on "connecting" forever with nothing to report it.
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
    vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    vi.useFakeTimers()
    let checks = 0
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === '-O' && args[1] === 'check') checks++
      return { code: args[0] === '-O' && args[1] === 'check' ? 1 : 0, stdout: '' }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), stderr: () => '', exited: () => false })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn()
    })
    const assertion = expect(mgr.connect('p1', conn)).rejects.toThrow(
      'Could not establish the SSH connection.'
    )
    await vi.advanceTimersByTimeAsync(310_000) // just past the 300s prompt ceiling
    await assertion
    // It really rode the EXTENDED window (not the 5s base) and then stopped.
    expect(checks).toBeGreaterThan(1000)
    vi.useRealTimers()
    vi.restoreAllMocks()
  }, 20_000)

  // --- SSH_ASKPASS wiring (passphrase-protected identity files) ----------------------------
  describe('askpass wiring', () => {
    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    // Same guard the 'master watchdog' tests use below: connect() awaits real fs promises
    // (mkdir/stat), which fake timers can't flush deterministically, see that block's comment.
    function stubFsForFakeTimers() {
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    }

    it('spawnMaster receives the env masterEnvFor(identityFile) returns', async () => {
      const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn() }))
      const run = vi.fn(async (_args: string[]) => ({ code: 0, stdout: '' }))
      const masterEnvFor = vi.fn(
        (identityFile?: string): Record<string, string> =>
          identityFile ? { SSH_ASKPASS: '/ud/ssh-askpass.sh', NODETERM_ASKPASS_IDENTITY: identityFile } : {}
      )
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        masterEnvFor
      })
      const withKey = { host: 'h', user: 'u', identityFile: '/home/u/.ssh/id_ed25519' }
      await mgr.connect('p1', withKey)
      expect(masterEnvFor).toHaveBeenCalledWith(withKey.identityFile)
      expect(spawnMaster).toHaveBeenCalledWith(expect.any(Array), {
        SSH_ASKPASS: '/ud/ssh-askpass.sh',
        NODETERM_ASKPASS_IDENTITY: withKey.identityFile
      })
    })

    it('brings the app-private ssh-agent up BEFORE the master is spawned', async () => {
      // Order is the whole point: ssh reads SSH_AUTH_SOCK at auth time, so an agent that is not
      // listening yet means `AddKeysToAgent=yes` stores the unlocked key nowhere and every connect
      // in this app run prompts again.
      const seq: string[] = []
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster: vi.fn(() => {
          seq.push('spawn')
          return { kill: vi.fn(), on: vi.fn() }
        }),
        run: vi.fn(async () => ({ code: 0, stdout: '' })),
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        ensureAgent: vi.fn(async () => {
          await new Promise((r) => setImmediate(r)) // a real start awaits the socket binding
          seq.push('agent')
        })
      })
      await mgr.connect('p1', { host: 'h', user: 'u' })
      expect(seq).toEqual(['agent', 'spawn'])
    })

    it('a failing ensureAgent never fails the connect (a missing agent costs a prompt, not a session)', async () => {
      const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn() }))
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run: vi.fn(async () => ({ code: 0, stdout: '' })),
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        ensureAgent: vi.fn(async () => {
          throw new Error('no ssh-agent on PATH')
        })
      })
      await expect(mgr.connect('p1', { host: 'h', user: 'u' })).resolves.toBeTruthy()
      expect(spawnMaster).toHaveBeenCalledTimes(1)
    })

    it('a final disconnect DURING the pre-registration probes cancels the attempt instead of leaking a master', async () => {
      // The window: connectOnce is still inside mkdir/stat/ensureAgent and has put nothing in
      // `conns` yet, so a project delete (or a cancelled connect-dialog browse) has no master to
      // tear down. Pre-fix, disconnect() returned untouched and the attempt completed as a master
      // nothing owned: revalidateAll kept it alive until quit, and with `conns` pinned non-empty
      // the idle key-forget never fired again.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      let releaseAgent!: () => void
      const gate = new Promise<void>((r) => {
        releaseAgent = r
      })
      const master = { kill: vi.fn(), on: vi.fn() }
      const onIdle = vi.fn()
      const onStatus = vi.fn()
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster: vi.fn(() => master),
        run: vi.fn(async () => ({ code: 0, stdout: '' })),
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus,
        onIdle,
        ensureAgent: vi.fn(() => gate)
      })
      const attempt = mgr.connect('p1', { host: 'h', user: 'u' })
      attempt.catch(() => {}) // settled and asserted below
      await new Promise((r) => setImmediate(r)) // let the attempt park inside ensureAgent
      await mgr.disconnect('p1', { final: true }) // the project is deleted mid-attempt
      // Nothing is connected, and the delete is user-facing: this IS the manager going idle.
      expect(onIdle).toHaveBeenCalledTimes(1)
      releaseAgent()
      await expect(attempt).rejects.toThrow(/cancelled/)
      // The just-spawned master was killed, nothing registered, and 'connected' never fired.
      expect(master.kill).toHaveBeenCalled()
      expect(onStatus.mock.calls.map((c) => c[0].status)).not.toContain('connected')
    })

    it('a cancel BEFORE ensureAgent cannot defuse the idle key-forget its own disconnect armed', async () => {
      // The ordering the previous test does not cover, wired like production: disconnect lands
      // while the attempt is still in fs.mkdir, BEFORE ensureAgent was ever invoked. onIdle arms
      // the agent's scheduled stop; the doomed attempt then resumes, and start()'s first act is
      // cancelScheduledStop() - without the pre-ensureAgent ticket check it would silently disarm
      // the key-forget it triggered, and the unlocked key would survive to the 12h backstop.
      const sockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-agent-'))
      const sockPath = path.join(sockDir, 'a.sock')
      const agent = new AppSshAgent((args) => {
        void args
        writeFileSync(sockPath, '') // "bind" instantly so start() resolves without polling out
        return { kill: vi.fn(), on: vi.fn() }
      }, sockPath)
      await agent.start() // the agent already holds a key from an earlier connection
      expect(agent.isRunning()).toBe(true)

      let releaseMkdir!: () => void
      const mkdirGate = new Promise<void>((r) => {
        releaseMkdir = r
      })
      vi.spyOn(fs, 'mkdir').mockImplementation(() => mkdirGate as Promise<undefined>)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
        run: vi.fn(async () => ({ code: 0, stdout: '' })),
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        ensureAgent: () => agent.start(),
        onIdle: () => agent.scheduleStop(50)
      })
      const attempt = mgr.connect('p1', { host: 'h', user: 'u' })
      attempt.catch(() => {})
      await new Promise((r) => setImmediate(r)) // park inside fs.mkdir, before ensureAgent
      await mgr.disconnect('p1', { final: true }) // arms the 50ms key-forget
      releaseMkdir()
      await expect(attempt).rejects.toThrow(/cancelled/)
      await new Promise((r) => setTimeout(r, 200))
      expect(agent.isRunning()).toBe(false) // the scheduled stop survived the doomed attempt
      agent.stop()
      await fs.rm(sockDir, { recursive: true, force: true }).catch(() => {})
    })

    it('reports idle ONLY on a user-facing disconnect that leaves nothing connected', async () => {
      // `onIdle` is what forgets the unlocked key. Internal teardowns empty `conns` routinely (an
      // endpoint edit, a failed connect, the watchdog dropping a stale master), and treating those
      // as "the user is done with SSH" would drop the key mid-reconnect.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const onIdle = vi.fn()
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
        run: vi.fn(async () => ({ code: 0, stdout: '' })),
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        onIdle
      })
      await mgr.connect('p1', { host: 'h1', user: 'u' })
      await mgr.connect('p2', { host: 'h2', user: 'u' })

      await mgr.disconnect('p1', { final: true }) // p2 still holds a master: not idle
      expect(onIdle).not.toHaveBeenCalled()

      // The load-bearing case: an INTERNAL teardown that leaves nothing connected. An endpoint
      // edit, a failed connect and the watchdog's stale-master drop all look exactly like this,
      // and forgetting the key here would re-prompt in the middle of a reconnect.
      await mgr.disconnect('p2')
      expect(onIdle).not.toHaveBeenCalled()

      await mgr.connect('p2', { host: 'h2', user: 'u' })
      await mgr.disconnect('p2', { final: true })
      expect(onIdle).toHaveBeenCalledTimes(1)
    })

    it('quit exits the daemonized masters, not just the child we spawned', async () => {
      // ControlPersist=300 outlives kill(): without a synchronous `-O exit` a relaunch inside five
      // minutes adopts the still-authenticated master and connects with no passphrase, even though
      // the app-private agent (and the unlocked key) died at quit.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const runSync = vi.fn()
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
        run: vi.fn(async () => ({ code: 0, stdout: '' })),
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        runSync
      })
      await mgr.connect('p1', { host: 'h1', user: 'u' })
      mgr.disconnectAll()
      expect(runSync).toHaveBeenCalledTimes(1)
      const args = runSync.mock.calls[0][0] as string[]
      expect(args.slice(0, 2)).toEqual(['-O', 'exit'])
      expect(args[args.length - 1]).toBe('u@h1')
    })

    it('a stale attempt that outlived a disconnect+reconnect does not clobber the live entry', async () => {
      // The success tail runs AFTER remoteHooks.setup (several round-trips). A disconnect and a
      // fresh reconnect inside that window leave a DIFFERENT attempt's master in the map; the
      // stale attempt writing its results onto it clobbered the live hookEndpointPath with
      // undefined (dead RUNNING badges) and emitted a second 'connected'. The guard: only the
      // attempt that still OWNS the map entry may write or report.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      let released = false
      let releaseFirstSetup: (() => void) | undefined
      const firstSetupGate = new Promise<void>((r) => (releaseFirstSetup = r))
      let hookProbes = 0
      const run = vi.fn(async (args: string[]) => {
        const j = args.join(' ')
        if (j.includes('$HOME')) return { code: 0, stdout: '/home/u' }
        if (j.includes('%{http_code}')) {
          // Attempt 1's tunnel verification parks here; the live attempt (probing while attempt 1
          // is still parked) verifies immediately. Everything AFTER the release belongs to
          // attempt 1's bounded retry, and stays dead so its setup conclusively returns null -
          // the case whose `hookEndpointPath = undefined` used to clobber the live entry.
          if (++hookProbes === 1) {
            await firstSetupGate
            return { code: 0, stdout: '000' }
          }
          return { code: 0, stdout: released ? '000' : '204' }
        }
        return { code: 0, stdout: '' }
      })
      const statuses: string[] = []
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 51234, token: 'tok', version: '1' }),
        onStatus: (e) => statuses.push(e.status)
      })
      const conn = { host: 'h', user: 'u' }
      const stale = mgr.connect('p1', conn) // parks inside setup's tunnel verification
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      await mgr.disconnect('p1') // user tears the project down mid-setup
      const live = await mgr.connect('p1', conn) // fresh attempt, completes fully
      expect(live.hookEndpointPath).toBe('/home/u/.nodeterm/hook-endpoint-p1.env')
      released = true
      releaseFirstSetup!()
      await stale // settles without owning the entry
      // The live entry survived the stale attempt: the endpoint is intact (a reuse connect
      // returns the cached entry - under the unguarded code the stale write set it to undefined,
      // which is the dead-RUNNING-badges failure). Status counts are not asserted: the live
      // attempt's claude probe legitimately re-pushes 'connected' on its own schedule.
      const reused = await mgr.connect('p1', conn)
      expect(reused.hookEndpointPath).toBe('/home/u/.nodeterm/hook-endpoint-p1.env')
    })

    it('a publickey denial with NO passphrase ask gets the agent-only hint, ONE attempt, no retry', async () => {
      // The agent-only credential case (smartcard, 1Password/Secretive with no IdentityAgent line):
      // no key FILE exists, so no prompt can rescue it, and our private agent hides the user's own.
      // The answer is a HINT naming the documented fix (IdentityAgent), never a second attempt: an
      // automatic ambient-agent retry fired on every ordinary auth failure (launchd exports
      // SSH_AUTH_SOCK on every Mac) and carried AddKeysToAgent=yes into the login agent - the leak
      // this design exists to close.
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const spawnMaster = vi.fn(() => ({
        kill: vi.fn(),
        on: vi.fn(),
        stderr: () => 'u@h: Permission denied (publickey).',
        exited: () => true,
        pid: () => 4242
      }))
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run: vi.fn(async (args: string[]) =>
          args[0] === '-O' && args[1] === 'check' ? { code: 1, stdout: '' } : { code: 0, stdout: '' }
        ),
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        askpassAsked: () => false // askpass never fired for this master: no key file was in play
      })
      await expect(mgr.connect('p1', { host: 'h', user: 'u' })).rejects.toThrow(/IdentityAgent/)
      expect(spawnMaster).toHaveBeenCalledTimes(1) // exactly one attempt - never a blind retry
    })

    it('the same denial WITH a passphrase ask keeps the plain error (a key file was in play)', async () => {
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster: vi.fn(() => ({
          kill: vi.fn(),
          on: vi.fn(),
          stderr: () => 'u@h: Permission denied (publickey).',
          exited: () => true,
          pid: () => 77
        })),
        run: vi.fn(async (args: string[]) =>
          args[0] === '-O' && args[1] === 'check' ? { code: 1, stdout: '' } : { code: 0, stdout: '' }
        ),
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        askpassAsked: () => true
      })
      await expect(mgr.connect('p1', { host: 'h', user: 'u' })).rejects.toThrow(
        /Permission denied \(publickey\)\.$/
      )
    })

    it('a cancelled passphrase prompt surfaces a dedicated message instead of the generic one', async () => {
      stubFsForFakeTimers()
      vi.useFakeTimers()
      const spawnMaster = vi.fn(() => ({
        kill: vi.fn(),
        on: vi.fn(),
        stderr: () => 'root@h: Permission denied (publickey).'
      }))
      // `-O check` never succeeds, the connect retry loop exhausts and hits the failure branch.
      const run = vi.fn(async (args: string[]) =>
        args[0] === '-O' && args[1] === 'check' ? { code: 1, stdout: '' } : { code: 0, stdout: '' }
      )
      const withKey = { host: 'h', user: 'u', identityFile: '/home/u/.ssh/id_ed25519' }
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        masterEnvFor: () => ({}),
        askpassWasCancelled: () => true
      })
      // Attach the rejection assertion BEFORE advancing timers: advancing drives the rejection
      // synchronously inside this call, and attaching afterwards races Node's unhandled-rejection
      // detector against `expect().rejects`, attaching first closes that window.
      const assertion = expect(mgr.connect('p1', withKey)).rejects.toThrow(
        'SSH connection cancelled: this key needs its passphrase.'
      )
      await vi.advanceTimersByTimeAsync(6000) // flush the base wall-clock wait
      await assertion
    })

    it('attributes a cancel to the exact master pid through the real AskpassServer wiring', async () => {
      // Pins the production wiring `askpassWasCancelled: (pid) => askpassServer.wasCancelledBy(pid)`
      // together with a spawner handle that reports its child's pid, i.e. that connect() actually
      // threads master.pid() through. The different-pid case is the load-bearing half: had connect()
      // passed undefined, wasCancelledBy falls back to the 60s global-clock answer, BOTH connects
      // below would read as cancelled, and one project's Cancel would relabel another project's
      // genuine auth failure as "needs its passphrase" (the bug the pid keying exists to prevent).
      // Real timers: the exit-grace loop is only ~5 checks x 100ms per connect.
      const s = new AskpassServer()
      s.setPromptHandler(async () => null) // the user hits Cancel
      await s.start(path.join(os.tmpdir(), `nt-ap-proj-${process.pid}.sock`))
      try {
        // Drive the decline the way the real helper does: a POST whose caller field is the $PPID
        // the askpass script reports, which is the pid of the master the app spawned. fetch()
        // cannot speak unix sockets, so this is the raw http.request equivalent.
        await new Promise<void>((resolve, reject) => {
          const req = httpRequest(
            {
              socketPath: s.getSockPath(),
              path: '/prompt',
              method: 'POST',
              headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'x-nodeterm-askpass-token': s.getToken()
              }
            },
            (res) => {
              res.resume()
              res.on('end', () => resolve())
            }
          )
          req.on('error', reject)
          req.end(
            new URLSearchParams({
              identity: '/home/u/.ssh/id_ed25519',
              caller: '4242',
              prompt: "Enter passphrase for key '/home/u/.ssh/id_ed25519': "
            }).toString()
          )
        })
        const mgrWithMasterPid = (pid: number) =>
          new SshProjectManager({
            userDataDir: '/ud',
            spawnMaster: vi.fn(() => ({
              kill: vi.fn(),
              on: vi.fn(),
              stderr: () => 'root@h: Permission denied (publickey).',
              exited: () => true,
              pid: () => pid
            })),
            run: async (args: string[]) =>
              args[0] === '-O' && args[1] === 'check' ? { code: 1, stdout: '' } : { code: 0, stdout: '' },
            runScp: async () => ({ code: 0 }),
            getHook: () => ({ port: 1, token: 't', version: '1' }),
            onStatus: vi.fn(),
            masterEnvFor: () => ({}),
            askpassWasCancelled: (masterPid) => s.wasCancelledBy(masterPid)
          })
        // The master whose prompt was declined gets the passphrase-specific message.
        await expect(mgrWithMasterPid(4242).connect('p-cancel-mine', conn)).rejects.toThrow(
          'SSH connection cancelled: this key needs its passphrase.'
        )
        // A DIFFERENT master pid, same stderr, still inside the fallback's 60s window: it must
        // keep its real error. Pid attribution, not the clock, decides the message.
        await expect(mgrWithMasterPid(9999).connect('p-cancel-other', conn)).rejects.toThrow(
          'Could not establish the SSH connection: root@h: Permission denied (publickey).'
        )
      } finally {
        s.stop()
      }
    }, 15_000)

    it('fails fast with the master stderr when the master process exits (no blind 5s wait)', async () => {
      stubFsForFakeTimers()
      vi.useFakeTimers()
      const spawnMaster = vi.fn(() => ({
        kill: vi.fn(),
        on: vi.fn(),
        stderr: () => 'root@h: Permission denied (publickey).',
        exited: () => true
      }))
      const run = vi.fn(async (args: string[]) =>
        args[0] === '-O' && args[1] === 'check' ? { code: 1, stdout: '' } : { code: 0, stdout: '' }
      )
      const checkCount = () => run.mock.calls.filter((c) => (c[0] as string[])[1] === 'check').length
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn()
      })
      const assertion = expect(mgr.connect('p1', conn)).rejects.toThrow('Permission denied (publickey)')
      await vi.advanceTimersByTimeAsync(2000)
      await assertion
      // Exit grace is a handful of checks, far fewer than the base 50-attempt window.
      expect(checkCount()).toBeLessThan(10)
    })

    it('keeps waiting while a keyed master process is still alive (slow handshake or prompt)', async () => {
      stubFsForFakeTimers()
      vi.useFakeTimers()
      let checkCalls = 0
      const SUCCEED_AT = 80 // past the base wall-clock budget (BASE_WAIT_MS): proves the alive-master extension
      const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), exited: () => false }))
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === '-O' && args[1] === 'check') {
          checkCalls++
          return { code: checkCalls >= SUCCEED_AT ? 0 : 1, stdout: '' }
        }
        return { code: 0, stdout: '' }
      })
      const withKey = { host: 'h', user: 'u', identityFile: '/home/u/.ssh/id_ed25519' }
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        masterEnvFor: () => ({})
      })
      const connectPromise = mgr.connect('p1', withKey)
      await vi.advanceTimersByTimeAsync(12000)
      const { controlPath } = await connectPromise
      expect(controlPath).toBe(controlPathFor('p1'))
      expect(checkCalls).toBeGreaterThanOrEqual(SUCCEED_AT)
    })

    it('requests the askpass env for a server with no configured identity file', async () => {
      stubFsForFakeTimers()
      vi.useFakeTimers()
      const masterEnvFor = vi.fn((): Record<string, string> => ({}))
      const withKey = { host: 'h', user: 'u' } // no identityFile, the common real-world case
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster: vi.fn(() => ({
          kill: vi.fn(),
          on: vi.fn(),
          stderr: () => 'root@h: Permission denied (publickey).',
          exited: () => true
        })),
        run: vi.fn(async (args: string[]) =>
          args[0] === '-O' && args[1] === 'check' ? { code: 1, stdout: '' } : { code: 0, stdout: '' }
        ),
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        masterEnvFor
      })
      const assertion = expect(mgr.connect('p1', withKey)).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(2000)
      await assertion
      // The askpass env is requested for EVERY connect, including servers with no configured
      // identity file: ssh offers the default identities, which are the ones likely encrypted.
      expect(masterEnvFor).toHaveBeenCalled()
    })

    it('extends the wait past the base ~5s while a passphrase prompt is still outstanding', async () => {
      stubFsForFakeTimers()
      vi.useFakeTimers()
      const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn() }))
      let checkCalls = 0
      const SUCCEED_AT = 80 // past the base wall-clock budget (BASE_WAIT_MS), proves the wait actually extended
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === '-O' && args[1] === 'check') {
          checkCalls++
          return { code: checkCalls >= SUCCEED_AT ? 0 : 1, stdout: '' }
        }
        return { code: 0, stdout: '' }
      })
      const withKey = { host: 'h', user: 'u', identityFile: '/home/u/.ssh/id_ed25519' }
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn(),
        masterEnvFor: () => ({}),
        askpassIsPrompting: () => true
      })
      const connectPromise = mgr.connect('p1', withKey)
      await vi.advanceTimersByTimeAsync(9000) // well past the base 5s ceiling
      const { controlPath } = await connectPromise
      expect(controlPath).toBe(controlPathFor('p1'))
      expect(checkCalls).toBeGreaterThanOrEqual(SUCCEED_AT)
    })
  })
})

describe('master watchdog', () => {
  // Real (tiny) intervals + vi.waitFor: connect() awaits real fs promises, which fake timers
  // can't flush deterministically.
  afterEach(() => vi.restoreAllMocks())

  function makeWatchedMgr() {
    // Keep the re-establish path off the real fs, controlPathFor hashes into the REAL
    // ~/.nodeterm/ssh-cm, and an unmocked stat+rm could unlink a genuinely live socket there.
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as never)
    vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
    const statuses: string[] = []
    // `-O check` fails while checkFails is true; spawning a fresh master heals it, models a
    // master that died behind our back and comes back only when the watchdog respawns it.
    let checkFails = false
    const spawnMaster = vi.fn(() => {
      checkFails = false
      return { kill: vi.fn(), on: vi.fn() }
    })
    const run = vi.fn(async (args: string[]) =>
      checkFails && args.includes('-O') ? { code: 1, stdout: '' } : { code: 0, stdout: '' }
    )
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster,
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: (e) => statuses.push(e.status)
    })
    return { mgr, statuses, spawnMaster, setMasterDead: () => (checkFails = true) }
  }

  it('a healthy master is only checked, never respawned, no reconnecting status', async () => {
    const { mgr, statuses, spawnMaster } = makeWatchedMgr()
    await mgr.connect('p1', conn)
    mgr.startWatchdog(5)
    await new Promise((r) => setTimeout(r, 60))
    mgr.stopWatchdog()
    expect(spawnMaster).toHaveBeenCalledTimes(1)
    expect(statuses).not.toContain('reconnecting')
  })

  it('an unnoticed master death is healed: reconnecting status + a fresh master', async () => {
    const { mgr, statuses, spawnMaster, setMasterDead } = makeWatchedMgr()
    await mgr.connect('p1', conn)
    setMasterDead()
    mgr.startWatchdog(5)
    try {
      await vi.waitFor(() => expect(spawnMaster).toHaveBeenCalledTimes(2))
    } finally {
      mgr.stopWatchdog()
    }
    expect(statuses).toContain('reconnecting')
    expect(statuses.at(-1)).toBe('connected')
  })

  it('startWatchdog is idempotent and stopWatchdog ends the ticking', async () => {
    const { mgr, spawnMaster, setMasterDead } = makeWatchedMgr()
    await mgr.connect('p1', conn)
    mgr.startWatchdog(5)
    mgr.startWatchdog(5)
    mgr.stopWatchdog()
    setMasterDead()
    await new Promise((r) => setTimeout(r, 40))
    expect(spawnMaster).toHaveBeenCalledTimes(1) // no tick fired after stop
  })
})

describe('lastSshErrorLine', () => {
  it('picks the actionable last line, skipping debug noise', () => {
    const stderr = [
      'debug1: Connecting to 95.217.38.239 port 22.',
      'debug1: Authenticating to 95.217.38.239 as root',
      'root@95.217.38.239: Permission denied (publickey).'
    ].join('\n')
    expect(lastSshErrorLine(stderr)).toBe('root@95.217.38.239: Permission denied (publickey).')
  })

  it('skips a trailing Warning line to keep the real cause', () => {
    const stderr = 'ssh: Could not resolve hostname niova: nodename nor servname provided\nWarning: something'
    expect(lastSshErrorLine(stderr)).toBe(
      'ssh: Could not resolve hostname niova: nodename nor servname provided'
    )
  })

  it('returns undefined for empty / whitespace-only stderr', () => {
    expect(lastSshErrorLine('   \n\n  ')).toBeUndefined()
    expect(lastSshErrorLine('')).toBeUndefined()
  })

  it('truncates a runaway line so the banner can not blow up', () => {
    const long = 'x'.repeat(500)
    const out = lastSshErrorLine(long)!
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(201)
  })
})

/**
 * Remote nodes were permanently `legacy`: the endpoint file advertised
 * `$HOME/.nodeterm/node-tokens` and nothing ever wrote it. The connect is where that dir gets
 * filled, on exactly the terms the canvas-control install already uses.
 */
describe('SshProjectManager — per-node tokens on the host', () => {
  /** A runner for a connect whose reverse hook tunnel VERIFIES (curl answers 204), which is what
   *  sets `hookEndpointPath` — the gate the token write shares with the canvas-control install. */
  function verifiedRun() {
    return vi.fn(async (args: string[], _stdin?: string) => {
      const j = args.join(' ')
      if (j.includes('$HOME')) return { code: 0, stdout: '/home/u' }
      if (j.includes('%{http_code}')) return { code: 0, stdout: '204' }
      return { code: 0, stdout: '' }
    })
  }
  /** The connect fires the write without awaiting it (best-effort setup must not delay a
   *  terminal), so the assertions run after the microtask queue drains. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  afterEach(() => vi.restoreAllMocks())

  it('materialises every canvas node id on the host, tokens on STDIN', async () => {
    const run = verifiedRun()
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn(),
      nodeIdsForProject: (id) => (id === 'p1' ? ['node-1', 'node-2'] : []),
      nodeTokenMinter: () => (nodeId) => `kid12345.mac-of-${nodeId}`
    })
    await mgr.connect('p1', conn)
    await settle()
    const cmds = run.mock.calls.map(([a]) => (a as string[]).join(' '))
    // tmp + rename (`cat >` truncates, so writing straight at the file leaves an EMPTY token
    // behind when the host is out of quota or disk — see RemoteHooks.writeNodeTokens).
    expect(cmds.some((c) => c.includes("mv -f '/home/u/.nodeterm/node-tokens/.node-1.tmp' '/home/u/.nodeterm/node-tokens/node-1'"))).toBe(true)
    expect(cmds.some((c) => c.includes("mv -f '/home/u/.nodeterm/node-tokens/.node-2.tmp' '/home/u/.nodeterm/node-tokens/node-2'"))).toBe(true)
    // never on a command line — the host's process table is readable by its other users.
    expect(cmds.some((c) => c.includes('mac-of-node-1'))).toBe(false)
    const write = run.mock.calls.find(([a]) =>
      (a as string[]).join(' ').includes("node-tokens/node-1'")
    )
    expect(write?.[1]).toBe('kid12345.mac-of-node-1\n')
  })

  it('writes nothing when this instance has no node-auth secret (legacy everywhere)', async () => {
    const run = verifiedRun()
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn(),
      nodeIdsForProject: () => ['node-1'],
      nodeTokenMinter: () => null
    })
    await mgr.connect('p1', conn)
    await settle()
    expect(run.mock.calls.some(([a]) => (a as string[]).join(' ').includes('node-tokens'))).toBe(false)
  })

  it('writeNodeTokenForNode covers a node created AFTER the connect', async () => {
    const run = verifiedRun()
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn(),
      nodeIdsForProject: () => [],
      nodeTokenMinter: () => (nodeId) => `kid12345.mac-of-${nodeId}`
    })
    const { controlPath } = await mgr.connect('p1', conn)
    await settle()
    run.mockClear()
    await mgr.writeNodeTokenForNode(controlPath, 'node-9')
    const cmds = run.mock.calls.map(([a]) => (a as string[]).join(' '))
    expect(cmds.some((c) => c.includes("mv -f '/home/u/.nodeterm/node-tokens/.node-9.tmp' '/home/u/.nodeterm/node-tokens/node-9'"))).toBe(true)
    // an unknown control path is a no-op, not a throw
    run.mockClear()
    await expect(mgr.writeNodeTokenForNode('/nope.sock', 'node-9')).resolves.toBeUndefined()
    expect(run.mock.calls).toHaveLength(0)
  })
})
