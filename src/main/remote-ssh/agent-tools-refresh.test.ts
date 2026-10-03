// `RemoteHooks.refreshAgentTools`, run for real under /bin/sh against a fake host tree: the one
// check that keeps an SSH host's canvas/context shims, skills and instruction blocks equal to what
// THIS build would write — rewriting only what differs, and never what it cannot read.
import { allRemote } from './remote-hooks.test-plan'
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
import { CONTROL_SHIM_SCRIPT, buildCanvasSkillBody } from '../../core/canvas-control-core'
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
/** The env-independent dir codex/gemini/copilot/opencode/grok all read (#744). */
const AGENTS_SKILL = () => `${home}/.agents/skills/manage-nodeterm-canvas/SKILL.md`
const AGENTS_CTX_SKILL = () => `${home}/.agents/skills/get-linked-context/SKILL.md`
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
  await new RemoteHooks(hostRunner(), allRemote).refreshAgentTools(conn, '/fixture.sock', home, accounts, 'connect')
}

describe.skipIf(process.platform === 'win32')('RemoteHooks.refreshAgentTools (real /bin/sh)', () => {
  it('a fresh host gets every file this build writes', async () => {
    const outcome = await new RemoteHooks(hostRunner(), allRemote).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')
    expect(outcome).toBe('refreshed')
    expect(read(SHIM())).toBe(CONTROL_SHIM_SCRIPT)
    expect(read(CTX())).toBe(CONTEXT_SHIM_SCRIPT)
    expect(read(SKILL())).toBe(buildCanvasSkillBody(SHIM()))
    expect(read(CTX_SKILL())).toBe(buildContextLinkSkillBody(CTX()))
    expect(read(AGENTS_SKILL())).toBe(buildCanvasSkillBody(SHIM()))
    expect(read(AGENTS_CTX_SKILL())).toBe(buildContextLinkSkillBody(CTX()))
    // Skills replaced the instruction blocks (#744): no global instruction file is created.
    for (const f of ['.codex/AGENTS.md', '.gemini/GEMINI.md', '.config/opencode/AGENTS.md', '.copilot/copilot-instructions.md']) {
      expect(existsSync(path.join(home, f)), f).toBe(false)
    }
  })

  it('an unanswered host gets nothing at all — not even a probe (#744)', async () => {
    const runner = hostRunner()
    const undecided = () => ({ install: new Set<string>(), remove: new Set<string>(), decided: false })
    expect(await new RemoteHooks(runner, undecided).refreshAgentTools(conn, '/fixture.sock', home, ['acc-1'], 'connect')).toBe('skipped')
    expect(runner.calls).toHaveLength(0)
    expect(existsSync(path.join(home, '.nodeterm'))).toBe(false)
  })

  it('a current host costs ONE read and not a single write', async () => {
    await freshHost(['acc-1'])
    const runner = hostRunner()
    const outcome = await new RemoteHooks(runner, allRemote).refreshAgentTools(conn, '/fixture.sock', home, ['acc-1'], 'connect')
    expect(outcome).toBe('current')
    // Exactly the probe: a block that only LOOKED stale would cost a merge read here, and a file
    // that only looked stale a write.
    expect(runner.calls).toHaveLength(1)
    expect(probes(runner)).toHaveLength(1)
  })

  it('rewrites exactly the stale files', async () => {
    await freshHost()
    put(SHIM(), '#!/bin/sh\necho "an older build"\n')
    put(SKILL(), '---\nname: manage-nodeterm-canvas\n---\nold verbs\n')
    put(AGENTS_SKILL(), '---\nname: manage-nodeterm-canvas\n---\nold verbs\n')
    const runner = hostRunner()
    const outcome = await new RemoteHooks(runner, allRemote).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')
    expect(outcome).toBe('refreshed')
    expect(read(SHIM())).toBe(CONTROL_SHIM_SCRIPT)
    expect(read(SKILL())).toBe(buildCanvasSkillBody(SHIM()))
    expect(read(AGENTS_SKILL())).toBe(buildCanvasSkillBody(SHIM()))
    expect(publishes(runner)).toHaveLength(3)
    expect(publishedTo(runner, SHIM())).toBe(true)
    expect(publishedTo(runner, SKILL())).toBe(true)
    expect(publishedTo(runner, AGENTS_SKILL())).toBe(true)
  })

  it('writes what is missing and nothing else', async () => {
    await freshHost()
    rmSync(CTX())
    rmSync(path.dirname(CTX_SKILL()), { recursive: true })
    const runner = hostRunner()
    await new RemoteHooks(runner, allRemote).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')
    expect(read(CTX())).toBe(CONTEXT_SHIM_SCRIPT)
    expect(read(CTX_SKILL())).toBe(buildContextLinkSkillBody(CTX()))
    expect(publishes(runner)).toHaveLength(2)
  })

  it('never writes over what it cannot read — and does not call that host confirmed', async () => {
    await freshHost()
    rmSync(SKILL())
    mkdirSync(SKILL()) // a directory where our file should be
    const codex = AGENTS_SKILL()
    rmSync(codex)
    symlinkSync(path.join(home, 'no-such-dotfile'), codex) // a dangling link where our file should be
    put(SHIM(), 'stale\n')
    const runner = hostRunner()
    const rh = new RemoteHooks(runner, allRemote)
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
    await new RemoteHooks(runner, allRemote).refreshAgentTools(conn, '/fixture.sock', home, ['acc-1', 'gone', '../escape'], 'connect')
    expect(read(`${accountDir('acc-1')}/skills/manage-nodeterm-canvas/SKILL.md`)).toBe(buildCanvasSkillBody(SHIM()))
    expect(read(`${accountDir('acc-1')}/skills/get-linked-context/SKILL.md`)).toBe(buildContextLinkSkillBody(CTX()))
    expect(existsSync(accountDir('gone'))).toBe(false)
    expect(existsSync(path.join(home, '.nodeterm/escape'))).toBe(false)
    expect(runner.calls.some((c) => c.includes('escape'))).toBe(false)
    expect(publishes(runner)).toHaveLength(1)
  })

  it("puts the shared skills in ~/.agents/skills whatever the host's COPILOT_HOME / GROK_HOME / XDG say", async () => {
    const env = { COPILOT_HOME: path.join(home, 'cp'), GROK_HOME: path.join(home, 'gk'), XDG_CONFIG_HOME: path.join(home, 'xdg') }
    await new RemoteHooks(hostRunner({ env }), allRemote).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')
    expect(read(AGENTS_SKILL())).toBe(buildCanvasSkillBody(SHIM()))
    for (const d of ['cp', 'gk', 'xdg']) expect(existsSync(path.join(home, d)), d).toBe(false)
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
    await new RemoteHooks(racing, allRemote).refreshAgentTools(conn, '/fixture.sock', home, ['acc-1'], 'connect')
    expect(existsSync(accountDir('acc-1'))).toBe(false)
    // The system files still landed: a vanished account costs only its own skills.
    expect(read(SHIM())).toBe(CONTROL_SHIM_SCRIPT)
  })

  it('a probe that could not run changes nothing', async () => {
    put(SHIM(), 'stale\n')
    const runner = hostRunner({ failProbe: true })
    expect(await new RemoteHooks(runner, allRemote).refreshAgentTools(conn, '/fixture.sock', home, [], 'connect')).toBe('failed')
    expect(read(SHIM())).toBe('stale\n')
    expect(runner.calls).toHaveLength(1)
  })

  it('the reuse branch costs nothing once the host is confirmed, and concurrent callers share one probe', async () => {
    const runner = hostRunner()
    const rh = new RemoteHooks(runner, allRemote)
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
      expect(await new RemoteHooks(runner, allRemote).refreshAgentTools(conn, '/fixture.sock', home, ['acc-1', 'gone'], 'connect')).toBe(
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
      const rh = new RemoteHooks(runner, allRemote)
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
