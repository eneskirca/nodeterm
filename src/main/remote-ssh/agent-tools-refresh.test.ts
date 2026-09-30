// `RemoteHooks.refreshAgentTools`, run for real under /bin/sh against a fake host tree: the one
// check that keeps an SSH host's canvas/context shims, skills and instruction blocks equal to what
// THIS build would write — rewriting only what differs, and never what it cannot read.
import { spawnSync } from 'child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTROL_SHIM_SCRIPT,
  buildCanvasControlInstructions,
  buildCanvasSkillBody,
  mergeCanvasControlBlock
} from '../../core/canvas-control-core'
import { CONTEXT_SHIM_SCRIPT, buildContextLinkSkillBody } from '../../core/context-link-core'
import { RemoteHooks, type RemoteRunner } from './remote-hooks'

const conn = { host: 'fixture', user: 'fixture' }
let home: string
let warn: ReturnType<typeof vi.spyOn>
let info: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "nt-refresh-' h-"))
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  info = vi.spyOn(console, 'info').mockImplementation(() => {})
})
/** Did any log line claim a rewrite? It must mean a file was actually written. */
const claimedRewrite = () => info.mock.calls.flat().some((a: unknown) => typeof a === 'string' && a.includes('rewrote'))
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

const SHIM = () => `${home}/.nodeterm/nodeterm.sh`
const CTX = () => `${home}/.nodeterm/context.sh`
const SKILL = () => `${home}/.claude/skills/manage-nodeterm-canvas/SKILL.md`
const CTX_SKILL = () => `${home}/.claude/skills/get-linked-context/SKILL.md`
const accountDir = (id: string) => `${home}/.nodeterm/claude-accounts/${id}`

interface HostRunner extends RemoteRunner {
  /** Every remote command, in order. */
  calls: string[]
}

/** Runs each remote command in /bin/sh with only a host's environment. */
function hostRunner(opts: { env?: Record<string, string>; path?: string; failProbe?: boolean } = {}): HostRunner {
  const calls: string[] = []
  return {
    calls,
    run: async (args, stdin) => {
      const command = args.at(-1)!
      calls.push(command)
      if (opts.failProbe && command.includes('NT_AGENT_TOOLS_CHECK')) return { code: 255, stdout: '' }
      // cwd = $HOME, as an ssh exec channel starts there: a relative path the host resolves must
      // land under the fake home, never in the repo running the test.
      const r = spawnSync('/bin/sh', ['-c', command], {
        cwd: home,
        env: { PATH: opts.path ?? process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...opts.env },
        input: stdin,
        encoding: 'utf8'
      })
      if (r.error) throw r.error
      return { code: r.status ?? 1, stdout: r.stdout }
    }
  }
}

const probes = (r: HostRunner) => r.calls.filter((c) => c.includes('NT_AGENT_TOOLS_CHECK'))
/** Every write publishes by renaming onto the target (owned files AND the guarded transaction). */
const publishes = (r: HostRunner) => r.calls.filter((c) => c.includes('mv -f -- '))
const publishedTo = (r: HostRunner, p: string) => publishes(r).some((c) => c.includes(p.replace(/'/g, "'\\''")))
const read = (p: string) => readFileSync(p, 'utf8')
function put(p: string, content: string): void {
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, content)
}

/** A host exactly as this build leaves it. */
async function freshHost(accounts: string[] = []): Promise<void> {
  for (const id of accounts) mkdirSync(accountDir(id), { recursive: true })
  await new RemoteHooks(hostRunner()).refreshAgentTools(conn, '/fixture.sock', home, accounts, 'connect')
}

describe.skipIf(process.platform === 'win32')('RemoteHooks.refreshAgentTools (real /bin/sh)', () => {
  it('a fresh host gets every file this build writes', async () => {
    const outcome = await new RemoteHooks(hostRunner()).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')
    expect(outcome).toBe('refreshed')
    expect(read(SHIM())).toBe(CONTROL_SHIM_SCRIPT)
    expect(read(CTX())).toBe(CONTEXT_SHIM_SCRIPT)
    expect(read(SKILL())).toBe(buildCanvasSkillBody(SHIM()))
    expect(read(CTX_SKILL())).toBe(buildContextLinkSkillBody(CTX()))
    for (const f of ['.codex/AGENTS.md', '.gemini/GEMINI.md', '.config/opencode/AGENTS.md']) {
      const text = read(path.join(home, f))
      expect(text).toContain('nodeterm:manage-canvas:start')
      expect(text).toContain('nodeterm:get-linked-context:start')
    }
    expect(read(path.join(home, '.copilot/copilot-instructions.md'))).toContain('nodeterm:manage-canvas:start')
  })

  it('a current host costs ONE read and not a single write', async () => {
    await freshHost(['acc-1'])
    const runner = hostRunner()
    const outcome = await new RemoteHooks(runner).refreshAgentTools(conn, '/fixture.sock', home, ['acc-1'], 'connect')
    expect(outcome).toBe('current')
    // Exactly the probe: a block that only LOOKED stale would cost a merge read here, and a file
    // that only looked stale a write.
    expect(runner.calls).toHaveLength(1)
    expect(probes(runner)).toHaveLength(1)
  })

  it('rewrites exactly the stale files, keeping the user text around a stale block', async () => {
    await freshHost()
    put(SHIM(), '#!/bin/sh\necho "an older build"\n')
    put(SKILL(), '---\nname: manage-nodeterm-canvas\n---\nold verbs\n')
    const gemini = path.join(home, '.gemini/GEMINI.md')
    const current = read(gemini)
    const withOldCanvas = mergeCanvasControlBlock(current, 'OLD canvas instructions')
    put(gemini, `# mine\n${withOldCanvas}`)
    const runner = hostRunner()
    const outcome = await new RemoteHooks(runner).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')
    expect(outcome).toBe('refreshed')
    expect(read(SHIM())).toBe(CONTROL_SHIM_SCRIPT)
    expect(read(SKILL())).toBe(buildCanvasSkillBody(SHIM()))
    const merged = read(gemini)
    expect(merged.startsWith('# mine\n')).toBe(true)
    expect(merged).not.toContain('OLD canvas instructions')
    expect(merged).toContain(buildCanvasControlInstructions(SHIM()).trim())
    expect(merged).toContain('nodeterm:get-linked-context:start')
    expect(publishes(runner)).toHaveLength(3)
    expect(publishedTo(runner, SHIM())).toBe(true)
    expect(publishedTo(runner, SKILL())).toBe(true)
    expect(publishedTo(runner, gemini)).toBe(true)
  })

  // Measured before the fix: 41,693 → 81,279 → 120,865 → 160,451 bytes over a connect and three
  // hourly re-checks — the merge took the stray end marker for "no block" and appended each time.
  // Two hosts, because two halves had the bug: on a normal host the PROBE must find the block (else
  // it reads stale every check); on a host whose awk fails every block is merged on every check,
  // so the MERGE itself must find it.
  it.each([
    ['a normal host', false],
    ['a host whose awk fails (every block merged every check)', true]
  ])('a stray end marker left by a hand-deleted block costs ONE append, not one per check — %s', async (_n, badAwk) => {
    await freshHost()
    const bin = mkdtempSync(path.join(tmpdir(), 'nt-bad-awk-'))
    try {
      writeFileSync(path.join(bin, 'awk'), '#!/bin/sh\nexit 2\n', { mode: 0o755 })
      const opts = badAwk ? { path: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` } : {}
      const codex = path.join(home, '.codex/AGENTS.md')
      // Both of our blocks gone from the file, each leaving its end line behind.
      let text = read(codex)
      for (const m of ['manage-canvas', 'get-linked-context']) {
        const start = text.indexOf(`<!-- nodeterm:${m}:start -->`)
        const end = text.indexOf(`<!-- nodeterm:${m}:end -->`)
        text = text.slice(0, start) + text.slice(end)
      }
      put(codex, `# mine\n${text}`)
      await new RemoteHooks(hostRunner(opts)).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')
      const size = read(codex).length
      expect(read(codex).match(/manage-canvas:start/g)).toHaveLength(1)
      expect(read(codex).match(/get-linked-context:start/g)).toHaveLength(1)
      for (let i = 0; i < 2; i++) {
        const runner = hostRunner(opts)
        expect(await new RemoteHooks(runner).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')).toBe('current')
        expect(read(codex).length).toBe(size)
        expect(publishes(runner)).toHaveLength(0)
        // On a normal host the probe agrees with the merge outright: no merge read at all.
        if (!badAwk) expect(runner.calls).toHaveLength(1)
      }
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })

  it('writes what is missing and nothing else', async () => {
    await freshHost()
    rmSync(CTX())
    rmSync(path.dirname(CTX_SKILL()), { recursive: true })
    const runner = hostRunner()
    await new RemoteHooks(runner).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')
    expect(read(CTX())).toBe(CONTEXT_SHIM_SCRIPT)
    expect(read(CTX_SKILL())).toBe(buildContextLinkSkillBody(CTX()))
    expect(publishes(runner)).toHaveLength(2)
  })

  it('never writes over what it cannot read — and does not call that host confirmed', async () => {
    await freshHost()
    rmSync(SKILL())
    mkdirSync(SKILL()) // a directory where our file should be
    const codex = path.join(home, '.codex/AGENTS.md')
    rmSync(codex)
    symlinkSync(path.join(home, 'no-such-dotfile'), codex) // a dangling dotfile link
    put(SHIM(), 'stale\n')
    const runner = hostRunner()
    const rh = new RemoteHooks(runner)
    expect(await rh.refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')).toBe('failed')
    expect(lstatSync(SKILL()).isDirectory()).toBe(true)
    expect(readdirSync(SKILL())).toEqual([])
    expect(lstatSync(codex).isSymbolicLink()).toBe(true)
    expect(readlinkSync(codex)).toBe(path.join(home, 'no-such-dotfile'))
    expect(existsSync(path.join(home, 'no-such-dotfile'))).toBe(false)
    // The rest of the host is still brought up to date…
    expect(read(SHIM())).toBe(CONTROL_SHIM_SCRIPT)
    expect(publishes(runner)).toHaveLength(1)
    // …and the refusal is said out loud, naming what was skipped.
    expect(warn.mock.calls.flat().join('\n')).toContain('SKILL.md')
    // Not confirmed ⇒ the reuse branch keeps trying (on its backoff), instead of calling it done.
    expect(await rh.refreshAgentTools(conn, '/fixture.sock', home, [], 'reuse', Date.now() + 60_000)).toBe('failed')
  })

  it("refreshes a managed account's skills — and never resurrects an account dir the host no longer has", async () => {
    await freshHost(['acc-1'])
    put(`${accountDir('acc-1')}/skills/manage-nodeterm-canvas/SKILL.md`, 'written when the account was added\n')
    const runner = hostRunner()
    await new RemoteHooks(runner).refreshAgentTools(conn, '/fixture.sock', home, ['acc-1', 'gone', '../escape'], 'connect')
    expect(read(`${accountDir('acc-1')}/skills/manage-nodeterm-canvas/SKILL.md`)).toBe(buildCanvasSkillBody(SHIM()))
    expect(read(`${accountDir('acc-1')}/skills/get-linked-context/SKILL.md`)).toBe(buildContextLinkSkillBody(CTX()))
    expect(existsSync(accountDir('gone'))).toBe(false)
    expect(existsSync(path.join(home, '.nodeterm/escape'))).toBe(false)
    expect(runner.calls.some((c) => c.includes('escape'))).toBe(false)
    expect(publishes(runner)).toHaveLength(1)
  })

  it('writes the copilot block where the installer would: a safe COPILOT_HOME, else ~/.copilot', async () => {
    const elsewhere = path.join(home, 'copilot-home')
    await new RemoteHooks(hostRunner({ env: { COPILOT_HOME: elsewhere } })).refreshAgentTools(
      conn,
      '/fixture.sock',
      home,
      [],
      'connect'
    )
    expect(read(path.join(elsewhere, 'copilot-instructions.md'))).toContain('nodeterm:manage-canvas:start')
    expect(existsSync(path.join(home, '.copilot'))).toBe(false)

    // A relative COPILOT_HOME is refused by the installer's validator, which falls back to
    // ~/.copilot; the refresh must land in the same place, never under the refused value. The file
    // the probe reads there (relative to the session's cwd) even holds a CURRENT block — a probe
    // taken at its word would call copilot done and ~/.copilot would never get one.
    const current = read(path.join(elsewhere, 'copilot-instructions.md'))
    put(path.join(home, 'relative-dir/copilot-instructions.md'), current)
    const runner = hostRunner({ env: { COPILOT_HOME: 'relative-dir' } })
    await new RemoteHooks(runner).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')
    expect(read(path.join(home, '.copilot/copilot-instructions.md'))).toContain('nodeterm:manage-canvas:start')
    expect(read(path.join(home, 'relative-dir/copilot-instructions.md'))).toBe(current)

    // The probe can never vouch for ~/.copilot under that env, so every check re-merges it — and a
    // merge that changes nothing is NOT a rewrite: no write, no "rewrote" line, outcome current.
    info.mockClear()
    const again = hostRunner({ env: { COPILOT_HOME: 'relative-dir' } })
    expect(await new RemoteHooks(again).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')).toBe('current')
    expect(publishes(again)).toHaveLength(0)
    expect(claimedRewrite()).toBe(false)
  })

  it('a host whose awk fails has its blocks MERGED instead (which write only on a change) — never a false rewrite', async () => {
    await freshHost()
    const bin = mkdtempSync(path.join(tmpdir(), 'nt-bad-awk-'))
    try {
      writeFileSync(path.join(bin, 'awk'), '#!/bin/sh\nexit 2\n', { mode: 0o755 })
      info.mockClear()
      const runner = hostRunner({ path: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` })
      expect(await new RemoteHooks(runner).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')).toBe('current')
      expect(publishes(runner)).toHaveLength(0)
      expect(claimedRewrite()).toBe(false)
      // …and said once, so a host that never confirms by checksum is visible in the log.
      expect(warn.mock.calls.flat().join('\n')).toMatch(/could not checksum 7 instruction block/)
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })

  it('an account dir removed between the probe and the write is not brought back', async () => {
    mkdirSync(accountDir('acc-1'), { recursive: true })
    const base = hostRunner()
    const racing: HostRunner = {
      calls: base.calls,
      run: async (args, stdin) => {
        const r = await base.run(args, stdin)
        // The probe saw the dir; it is gone before the skill write lands.
        if (args.at(-1)!.includes('NT_AGENT_TOOLS_CHECK')) rmSync(accountDir('acc-1'), { recursive: true })
        return r
      }
    }
    await new RemoteHooks(racing).refreshAgentTools(conn, '/fixture.sock', home, ['acc-1'], 'connect')
    expect(existsSync(accountDir('acc-1'))).toBe(false)
    // The system files still landed: a vanished account costs only its own skills.
    expect(read(SHIM())).toBe(CONTROL_SHIM_SCRIPT)
  })

  it('a probe that could not run changes nothing', async () => {
    put(SHIM(), 'stale\n')
    const runner = hostRunner({ failProbe: true })
    expect(await new RemoteHooks(runner).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')).toBe('failed')
    expect(read(SHIM())).toBe('stale\n')
    expect(runner.calls).toHaveLength(1)
  })

  it('the reuse branch costs nothing once the host is confirmed, and concurrent callers share one probe', async () => {
    const runner = hostRunner()
    const rh = new RemoteHooks(runner)
    // Two projects on one host connecting at once: ONE probe, one set of writes.
    const [a, b] = await Promise.all([
      rh.refreshAgentTools(conn, '/a.sock', home, [], 'connect'),
      rh.refreshAgentTools(conn, '/b.sock', home, [], 'connect')
    ])
    expect([a, b]).toEqual(['refreshed', 'refreshed'])
    expect(probes(runner)).toHaveLength(1)
    const before = runner.calls.length
    expect(await rh.refreshAgentTools(conn, '/a.sock', home, [], 'reuse')).toBe('skipped')
    expect(runner.calls.length).toBe(before)
    // A tunnel repair looks again even so.
    expect(await rh.refreshAgentTools(conn, '/a.sock', home, [], 'repair')).toBe('current')
    expect(probes(runner)).toHaveLength(2)
  })

  describe('a host with no cksum', () => {
    // Every tool this machine has EXCEPT cksum — thousands of links, so built once for the block.
    let bin: string
    beforeAll(() => {
      bin = mkdtempSync(path.join(tmpdir(), 'nt-no-cksum-'))
      for (const d of ['/usr/bin', '/bin']) {
        let names: string[] = []
        try {
          names = readdirSync(d)
        } catch {
          continue
        }
        for (const n of names) {
          if (n === 'cksum') continue
          try {
            symlinkSync(path.join(d, n), path.join(bin, n))
          } catch {
            // linked from the other directory already
          }
        }
      }
    })
    afterAll(() => rmSync(bin, { recursive: true, force: true }))

    it('still never writes into what it cannot read, and still honours the account-dir gate', async () => {
      mkdirSync(SKILL(), { recursive: true }) // a directory where our file should be
      mkdirSync(accountDir('acc-1'), { recursive: true })
      const runner = hostRunner({ path: bin })
      expect(await new RemoteHooks(runner).refreshAgentTools(conn, '/fixture.sock', home, ['acc-1', 'gone'], 'connect')).toBe(
        'failed'
      )
      expect(readdirSync(SKILL())).toEqual([])
      expect(read(`${accountDir('acc-1')}/skills/manage-nodeterm-canvas/SKILL.md`)).toBe(buildCanvasSkillBody(SHIM()))
      expect(existsSync(accountDir('gone'))).toBe(false)
      expect(read(SHIM())).toBe(CONTROL_SHIM_SCRIPT)
    })

    it('writes what it can read without comparison, as every connect did before the check existed', async () => {
      put(SHIM(), 'stale\n')
      const runner = hostRunner({ path: bin })
      const rh = new RemoteHooks(runner)
      expect(await rh.refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')).toBe('refreshed')
      expect(read(SHIM())).toBe(CONTROL_SHIM_SCRIPT)
      expect(read(CTX_SKILL())).toBe(buildContextLinkSkillBody(CTX()))
      // …but the hourly re-look of a host it already brought up to date writes nothing blind.
      const writes = publishes(runner).length
      expect(await rh.refreshAgentTools(conn, '/fixture.sock', home, [], 'reuse', Date.now() + 2 * 60 * 60_000)).toBe(
        'current'
      )
      expect(publishes(runner).length).toBe(writes)
    })
  })
})
