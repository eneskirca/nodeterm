// Launch-time repair of the codex hook install (ensureCodexHooksCurrent).
//
// Codex runs a hook only when ~/.codex/config.toml holds a matching `trusted_hash`, and reads it at
// session start. These pin that drift is repaired before a Codex pane spawns, that a CURRENT
// install is not rewritten (codex writes config.toml too), and that a broken install never throws
// into the spawn path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let home = ''
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home }
})

import {
  codexHookDrift,
  ensureCodexHooksCurrent,
  ensureCodexHooksForAccounts,
  installCodexHooks
} from './codex'
import { codexAccountHome } from '../../codex-accounts-core'
import { assertTomlTablesUnique } from './codex-trust'

const toml = (): string => path.join(home, '.codex', 'config.toml')
const hooks = (): string => path.join(home, '.codex', 'hooks.json')

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ensure-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('ensureCodexHooksCurrent', () => {
  it('installs on a home that has never had the hooks', () => {
    expect(codexHookDrift()).not.toEqual([])
    ensureCodexHooksCurrent()
    expect(codexHookDrift()).toEqual([])
    expect(fs.readFileSync(toml(), 'utf8')).toContain('trusted_hash')
  })

  it('does not rewrite a current install', () => {
    installCodexHooks()
    const past = new Date(Date.now() - 60_000)
    for (const f of [toml(), hooks()]) fs.utimesSync(f, past, past)
    const before = [toml(), hooks()].map((f) => fs.statSync(f).mtimeMs)
    ensureCodexHooksCurrent()
    expect([toml(), hooks()].map((f) => fs.statSync(f).mtimeMs)).toEqual(before)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('repairs config.toml that lost the trust entries (the incident shape)', () => {
    installCodexHooks()
    // What was found on the machine: the user's own config kept, nodeterm's trust blocks gone.
    fs.writeFileSync(toml(), 'model = "gpt-5"\n')
    expect(codexHookDrift()).toEqual(['config.toml trust (8/8)'])
    ensureCodexHooksCurrent()
    expect(codexHookDrift()).toEqual([])
    expect(fs.readFileSync(toml(), 'utf8')).toContain('model = "gpt-5"')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('config.toml trust'))
  })

  it('repairs a trust hash that no longer matches the hook', () => {
    installCodexHooks()
    const text = fs.readFileSync(toml(), 'utf8')
    fs.writeFileSync(toml(), text.replace(/trusted_hash = "sha256:[0-9a-f]+"/, 'trusted_hash = "sha256:00"'))
    expect(codexHookDrift()).toEqual(['config.toml trust (1/8)'])
    ensureCodexHooksCurrent()
    expect(codexHookDrift()).toEqual([])
  })

  it('repairs hooks.json that lost our entries, keeping the user hooks', () => {
    installCodexHooks()
    const user = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }
    fs.writeFileSync(hooks(), JSON.stringify(user))
    expect(codexHookDrift()).toContain('hooks.json entries')
    ensureCodexHooksCurrent()
    expect(codexHookDrift()).toEqual([])
    expect(fs.readFileSync(hooks(), 'utf8')).toContain('echo mine')
  })

  it('never throws when the install cannot be read', () => {
    fs.mkdirSync(toml(), { recursive: true }) // config.toml is a DIRECTORY: every read fails
    expect(() => ensureCodexHooksCurrent()).not.toThrow()
  })
})

// The live failure on a Windows desktop (2026-10-07): config.toml held our trust tables spelled
// with LITERAL-string keys (`[hooks.state.'C:\…']`), the repair appended basic-string copies of the
// same keys, and Codex refused to start ("duplicate key").
describe('trust tables in another TOML spelling', () => {
  const headers = (): string[] =>
    fs.readFileSync(toml(), 'utf8').split('\n').filter((l) => l.startsWith('[hooks.state.'))
  /** Rewrite `which` of our basic-string headers as literal-string ones (the key is unchanged). */
  const toLiteral = (which: (i: number) => boolean): void => {
    let i = 0
    const text = fs.readFileSync(toml(), 'utf8').replace(/^\[hooks\.state\."(.*)"\]$/gm, (line, key: string) =>
      // A TOML basic string's escapes (`\\`, `\"`, `\uXXXX`) are JSON's: decode it in one pass.
      which(i++) ? `[hooks.state.'${JSON.parse(`"${key}"`) as string}']` : line
    )
    fs.writeFileSync(toml(), text)
  }
  const drift = (): void =>
    fs.writeFileSync(toml(), fs.readFileSync(toml(), 'utf8').replace(/sha256:[0-9a-f]+/g, 'sha256:00'))

  it('a current config spelled with literal keys is current — nothing is written', () => {
    installCodexHooks()
    toLiteral(() => true)
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(toml(), past, past)
    const before = fs.statSync(toml()).mtimeMs
    expect(codexHookDrift()).toEqual([])
    ensureCodexHooksCurrent()
    expect(fs.statSync(toml()).mtimeMs).toBe(before)
  })

  it.each([
    ['all literal', (): boolean => true],
    ['mixed', (i: number): boolean => i % 2 === 0]
  ])('drifted hashes under %s keys are repaired in place, one table per key', (_label, which) => {
    installCodexHooks()
    toLiteral(which)
    drift()
    expect(codexHookDrift()).toEqual(['config.toml trust (8/8)'])
    ensureCodexHooksCurrent()
    expect(codexHookDrift()).toEqual([])
    expect(headers()).toHaveLength(8)
    expect(() => assertTomlTablesUnique(fs.readFileSync(toml(), 'utf8'))).not.toThrow()
  })

  it('writes NOTHING when the result would still define a table twice, and does not throw', () => {
    fs.mkdirSync(path.dirname(toml()), { recursive: true })
    const broken = '[profiles.a]\nmodel = "x"\n\n[profiles.a]\nmodel = "y"\n'
    fs.writeFileSync(toml(), broken)
    expect(() => ensureCodexHooksCurrent()).not.toThrow()
    expect(fs.readFileSync(toml(), 'utf8')).toBe(broken)
    expect(fs.existsSync(hooks())).toBe(false) // hooks.json is not written ahead of a refused trust edit
  })
})


// Managed Codex accounts: a pane bound to one runs with CODEX_HOME = that account's private home,
// and codex reads hooks.json + config.toml trust from THERE, not from ~/.codex.
describe('managed Codex account homes', () => {
  const USER_DATA = '/isolated/userdata'
  const sys = (): string => path.join(home, '.codex')
  const acct = (id: string): string => codexAccountHome(USER_DATA, id)
  const files = (h: string): string[] => [path.join(h, 'config.toml'), path.join(h, 'hooks.json')]
  const stamps = (h: string): number[] => files(h).map((f) => fs.statSync(f).mtimeMs)
  const age = (h: string): void => {
    const past = new Date(Date.now() - 60_000)
    for (const f of files(h)) fs.utimesSync(f, past, past)
  }

  beforeEach(() => {
    for (const id of ['acct-a', 'acct-b']) fs.mkdirSync(acct(id), { recursive: true })
    for (const h of [sys(), acct('acct-a'), acct('acct-b')]) {
      installCodexHooks(h)
      age(h)
    }
  })

  it('every home starts current, and checking them rewrites nothing', () => {
    const before = [sys(), acct('acct-a'), acct('acct-b')].map(stamps)
    for (const h of [sys(), acct('acct-a'), acct('acct-b')]) ensureCodexHooksCurrent(h)
    expect([sys(), acct('acct-a'), acct('acct-b')].map(stamps)).toEqual(before)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('drift in one account home is repaired in THAT home only', () => {
    fs.writeFileSync(path.join(acct('acct-a'), 'config.toml'), 'model = "o4"\n')
    const others = [sys(), acct('acct-b')].map(stamps)
    expect(codexHookDrift(acct('acct-a'))).toEqual(['config.toml trust (8/8)'])
    ensureCodexHooksCurrent(acct('acct-a'))
    expect(codexHookDrift(acct('acct-a'))).toEqual([])
    expect(fs.readFileSync(path.join(acct('acct-a'), 'config.toml'), 'utf8')).toContain('model = "o4"')
    expect([sys(), acct('acct-b')].map(stamps)).toEqual(others)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(acct('acct-a')))
  })

  it('a managed pane never touches ~/.codex, even when ~/.codex has never been installed', () => {
    fs.rmSync(sys(), { recursive: true, force: true })
    fs.writeFileSync(path.join(acct('acct-b'), 'hooks.json'), '{}')
    ensureCodexHooksCurrent(acct('acct-b'))
    expect(codexHookDrift(acct('acct-b'))).toEqual([])
    expect(fs.existsSync(sys())).toBe(false)
  })

  it('a missing account home is not created', () => {
    const ghost = acct('acct-ghost')
    ensureCodexHooksCurrent(ghost)
    expect(fs.existsSync(ghost)).toBe(false)
  })

  it('boot: repairs drifted account homes, skips unsafe ids and missing homes', () => {
    fs.writeFileSync(path.join(acct('acct-b'), 'config.toml'), '')
    const sysBefore = stamps(sys())
    const aBefore = stamps(acct('acct-a'))
    ensureCodexHooksForAccounts(USER_DATA, [
      { id: 'acct-a' },
      { id: 'acct-b' },
      { id: '../escape' },
      { id: 'acct-ghost' }
    ])
    expect(codexHookDrift(acct('acct-b'))).toEqual([])
    expect(stamps(acct('acct-a'))).toEqual(aBefore)
    expect(stamps(sys())).toEqual(sysBefore)
    expect(fs.existsSync(acct('acct-ghost'))).toBe(false)
  })

  // initializeAccountHome symlinks hooks.json + config.toml to ~/.codex. A repair must write
  // THROUGH the link, or the account silently stops sharing the system install.
  it('repairs through a linked account home without breaking the links', (ctx) => {
    const linked = acct('acct-linked')
    fs.mkdirSync(linked, { recursive: true })
    try {
      for (const f of ['config.toml', 'hooks.json']) {
        fs.symlinkSync(path.join(sys(), f), path.join(linked, f), 'file')
      }
    } catch {
      ctx.skip() // Windows without symlink privilege
    }
    fs.writeFileSync(path.join(sys(), 'config.toml'), '')
    expect(codexHookDrift(linked)).not.toEqual([])
    ensureCodexHooksCurrent(linked)
    expect(codexHookDrift(linked)).toEqual([])
    for (const f of ['config.toml', 'hooks.json']) {
      expect(fs.lstatSync(path.join(linked, f)).isSymbolicLink()).toBe(true)
    }
    expect(codexHookDrift(sys())).toEqual([])
  })
})

describe('PtyManager wiring', () => {
  it("checks the SESSION's CODEX_HOME, for local codex panes of a known account only", () => {
    const text = fs
      .readFileSync(path.join(__dirname, '..', '..', 'pty-manager.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    // Through the consent-gated lifecycle (issue #744), never the raw installer.
    const at = text.indexOf('currentIntegrationLifecycle()?.ensureCodexHooksForLaunch(codexScope.CODEX_HOME)')
    expect(at).toBeGreaterThan(0)
    expect(text.split('ensureCodexHooksForLaunch(').length - 1).toBe(1)
    expect(text).not.toContain('ensureCodexHooksCurrent')
    // Inside the LOCAL codex-scope block, which sets CODEX_HOME from the same codexScope.
    const scope = text.slice(text.lastIndexOf('if (needsCodexAccountScope(', at), at)
    expect(scope).toContain('!options.sshRemote')
    expect(scope).toContain('env.CODEX_HOME = codexScope.CODEX_HOME')
    expect(scope).toContain("capabilityAgentId(options.agentId as AgentId) === 'codex'")
    expect(scope).toContain('!options.accountId || this.isCodexAccount(options.accountId)')
  })

  // The repairs write the user's real ~/.codex, so only the consent lifecycle may call them: a
  // direct call from a shell or the spawn path re-installs hooks for a user who declined codex.
  it('only core/agent-integrations.ts reaches the codex repair functions', () => {
    const src = path.join(__dirname, '..', '..', '..')
    const callers: string[] = []
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          const t = fs.readFileSync(p, 'utf8')
          if (/\bensureCodexHooks(Current|ForAccounts)\b/.test(t)) callers.push(path.relative(src, p).split(path.sep).join('/'))
        }
      }
    }
    walk(src)
    expect(callers.sort()).toEqual(['core/agent-integrations.ts', 'core/agents/hooks/codex.ts'])
  })
})
