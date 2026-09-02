/**
 * S6 ACCEPTANCE GATE — the one long end-to-end composition test (PR 9, Task 9.2a).
 *
 * The individual PRs (1–8.5) each pin their own slice in isolation. This file does the OTHER job the
 * gate needs: it walks the whole operable chain ONCE, against the REAL merged primitives, to prove
 * the pieces COMPOSE — a managed account home on a real fs, the fail-closed spawn-scope resolver, the
 * real HMAC-signed ownership record read back by the real POSIX-sh resolver under real `/bin/sh`, the
 * real main-side three-phase switch handler linking a real rollout inode, the relay catalog's
 * fail-closed ambiguity, per-account usage attribution, and the invariant that no credential ever
 * rides an argv. It is NOT a re-implementation of any of them (Global Constraint 8): every leg calls
 * the shipped export.
 *
 * WHAT THIS TEST DELIBERATELY DOES NOT DO — the legs that cannot run headless are documented as OWED
 * in docs/codex-accounts-acceptance.md rather than faked here:
 *   - the live `codex app-server` JSON-RPC (U4): `readCodexThreadAt`/`readCodexAccountAt` are the ONE
 *     boundary faked (as the per-PR suites do) — they stand in for a running daemon that this CI has
 *     no standalone Codex install to start. The rollout COPY they hand off to is the real fs primitive.
 *   - the real SSH WAN transfer landing (U1, PR 6): the remote importer is a spy; the far-side
 *     discover / rollback / `exit 17` are host behaviors, owed on a real host. The LOCAL never-overwrite
 *     twin (a different inode already at the target) IS exercised here on a real fs.
 *   - the imperative pane-recycle glue (commit→rebind→restartShell→finish): only the pure/main-side
 *     legs run here; the renderer sequencing is owed against the running app.
 *
 * MUTATION REPORT (Global Constraint 9) — recorded in the PR body. For each claim below, the named
 * source mutation was introduced and this file reddened, then reverted:
 *   M1 resolveCodexSessionScope: return the system env instead of `{unavailable}` when a selected
 *      home is missing ⇒ "an explicitly selected missing account refuses to spawn" greens wrongly ⇒ red.
 *   M2 resolveCodexThreadNodeIdentity: return `candidates[0]` instead of gating on `owners.size===1`
 *      ⇒ "the same thread id in two scopes resolves to no owner" ⇒ red.
 *   M3 commitCodexRolloutExposure: accept an EEXIST collision without the dev/ino check ⇒ "an existing
 *      different rollout is never overwritten" ⇒ red.
 *   M4 fetchCodexUsage: stop stamping `accountId` on the `unavailable` return ⇒ "usage stays
 *      per-account, never fabricated/mixed" ⇒ red.
 *   M5 codexThreadIdentityResolverSh: drop the `nt_codex_matches -eq 1` gate ⇒ the ambiguous-scan leg
 *      exports a node under `/bin/sh` ⇒ red.
 *
 * Based on @Corvin's S6 design in external PR #112 (github.com/eneskirca/nodeterm #112).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import os from 'os'
import path from 'path'

// The electron shell boundary — the switch/transfer handlers register over ipcMain.handle.
const h: { handlers: Record<string, (...a: any[]) => unknown> } = { handlers: {} }
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => unknown) => (h.handlers[ch] = fn) }
}))

// The ONE faked boundary: the live app-server JSON-RPC (probe U4, unrunnable headless). The rollout
// path it returns is a REAL file on disk that the real copy primitive then hardlinks.
const readThread = vi.fn()
const readAccount = vi.fn(async () => ({ email: 'me@example.com' }))
vi.mock('../core/codex-session-name', () => ({
  readCodexThreadAt: (..._a: any[]) => readThread(),
  readCodexAccountAt: (..._a: any[]) => readAccount()
}))
// No real `codex` binary is discovered, so no app-server subprocess is ever spawned in this run —
// which is also what lets the "no credential on any argv" leg assert against a clean spawn ledger.
vi.mock('../core/pty-manager', () => ({ findInLoginPath: vi.fn(async () => null) }))
// Keep every OTHER relay-daemon export real (mergeRelayThreadLists is exercised below); only stub the
// boot effect that would touch the real home dir.
vi.mock('./codex-relay-daemon', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./codex-relay-daemon')
  return { ...actual, ensureCodexRelayRoot: vi.fn() }
})

const remoteCodexImportThread = vi.fn(async () => ({ imported: true }))

/** A WebContents-shaped fake carrying the `.id` + listener surface the switch protocol drives. */
const makeSender = (id: number) => ({
  id,
  isDestroyed: () => false,
  once: () => {},
  removeListener: () => {}
})
const call = (channel: string, sender: any, ...args: any[]) =>
  h.handlers[channel]({ sender }, ...args)

const THREAD = 'thread-e2e-abc123'
const LOCAL = 'acctlocal1'

// Post-reset module instances, imported fresh per test so the whole graph is one consistent build.
let proxy: typeof import('../core/codex-identity-proxy')
let coreMod: typeof import('../core/codex-accounts-core')
let shMod: typeof import('../core/codex-thread-identity-sh')
let usageMod: typeof import('../core/usage/codex-usage')
let relayMod: typeof import('./codex-relay-daemon')
let IPC: typeof import('../shared/ipc').IPC

let userDataDir = ''
let systemHome = ''
let prevCodexHome: string | undefined
const createdHomes: string[] = []

beforeEach(async () => {
  h.handlers = {}
  readThread.mockReset()
  readAccount.mockReset().mockResolvedValue({ email: 'me@example.com' })
  remoteCodexImportThread.mockClear()

  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-e2e-'))
  // The system (CODEX_HOME) home MUST sit on the same filesystem as the managed short-home root
  // (`~/.nodeterm/cx`), because the switch links a real inode between them — a cross-mount placement
  // would (correctly) hit the shipped EXDEV fail-closed guard, which is not what this leg exercises.
  const ntRoot = path.join(os.homedir(), '.nodeterm')
  mkdirSync(ntRoot, { recursive: true })
  systemHome = mkdtempSync(path.join(ntRoot, 'e2e-sys-'))
  createdHomes.push(systemHome)
  prevCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = systemHome

  vi.resetModules()
  const platformMod = await import('../core/platform')
  const { fakePlatform } = await import('../core/platform-fake')
  platformMod.initPlatform(fakePlatform({ userDataDir }))

  proxy = await import('../core/codex-identity-proxy')
  coreMod = await import('../core/codex-accounts-core')
  shMod = await import('../core/codex-thread-identity-sh')
  usageMod = await import('../core/usage/codex-usage')
  relayMod = await import('./codex-relay-daemon')
  ;({ IPC } = await import('../shared/ipc'))

  // Arm the record-signing secret on THIS module graph (deterministic bytes for the record legs).
  proxy.setCodexThreadIdentityAuthSecret(new Uint8Array(32).fill(7))

  const accounts = await import('./codex-accounts')
  accounts.initCodexAccounts(() => ({ remoteCodexImportThread }) as any)
})

afterEach(async () => {
  const { resetPlatformForTests } = await import('../core/platform')
  resetPlatformForTests()
  proxy.resetCodexThreadIdentityAuthSecret()
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(systemHome, { recursive: true, force: true })
  for (const home of createdHomes.splice(0)) rmSync(home, { recursive: true, force: true })
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = prevCodexHome
  vi.clearAllTimers()
})

/** Create a managed account's real home (the exact path the module computes) and remember it for
 *  cleanup — the short home lives under `~/.nodeterm/cx`, not under the temp userDataDir. */
function makeManagedHome(id: string): string {
  const home = coreMod.codexAccountHome(userDataDir, id)
  mkdirSync(path.join(home, 'sessions'), { recursive: true })
  createdHomes.push(home)
  return home
}

describe('S6 acceptance gate — the merged machine-scoped-Codex-account chain composes', () => {
  it('walks the whole operable chain against real primitives', async () => {
    // ---- LEG A: a managed account home on real fs; the spawn scope resolves fail-closed ----------
    const localHome = makeManagedHome(LOCAL)
    // System account (no id) always resolves to ~/.codex-equivalent ($CODEX_HOME here).
    const systemScope = coreMod.resolveCodexSessionScope(userDataDir, undefined)
    expect(coreMod.isCodexScopeRefusal(systemScope)).toBe(false)
    expect((systemScope as { CODEX_HOME: string }).CODEX_HOME).toBe(systemHome)
    // The managed account resolves to its own isolated home (real existsSync against the real dir).
    const localScope = coreMod.resolveCodexSessionScope(userDataDir, LOCAL)
    expect(localScope).toEqual({ CODEX_HOME: localHome, NODETERM_CODEX_ACCOUNT_ID: LOCAL })

    // ---- LEG B: stamp a Codex node's ownership record, recover it under REAL /bin/sh -------------
    const recordRoot = path.join(userDataDir, 'codex-thread-nodes')
    const endpoint = path.join(userDataDir, 'hook-endpoint')
    proxy.writeCodexThreadIdentity(THREAD, 'node-1', endpoint, recordRoot, LOCAL)
    const boundNode = runResolver(shMod.codexThreadIdentityResolverSh(recordRoot), {
      CODEX_THREAD_ID: THREAD,
      NODETERM_CODEX_ACCOUNT_ID: LOCAL
    })
    expect(boundNode).toBe('node-1') // the real sh recovered the exact node binding from the record

    // ---- LEG C: the real main-side three-phase switch links a real rollout inode -----------------
    // A real rollout under the managed home; the faked daemon returns its REAL path.
    const sessionsDir = path.join(localHome, 'sessions', '2026', '08')
    mkdirSync(sessionsDir, { recursive: true })
    const rollout = path.join(sessionsDir, `rollout-${THREAD}.jsonl`)
    writeFileSync(rollout, `{"id":"${THREAD}"}\n`)
    readThread.mockResolvedValue({ id: THREAD, name: null, path: rollout })

    const owner = makeSender(1)
    // Switch the managed account's conversation onto the SYSTEM account (targetAccountId undefined).
    const res = (await call(
      IPC.codexAccountsSwitchThread,
      owner,
      THREAD,
      '/work',
      LOCAL,
      undefined
    )) as { threadId: string; rollbackToken?: string }
    expect(res.threadId).toBe(THREAD) // the conversation id is carried unchanged, never forked
    expect(res.rollbackToken).toBeTruthy()
    await call(IPC.codexAccountsCommitSwitch, owner, res.rollbackToken)
    const targetPath = path.join(systemHome, 'sessions', '2026', '08', `rollout-${THREAD}.jsonl`)
    const src = statSync(rollout)
    const tgt = statSync(targetPath)
    expect(tgt.ino).toBe(src.ino) // same inode ⇒ byte-identical conversation id survives the switch
    expect(tgt.dev).toBe(src.dev)
    await call(IPC.codexAccountsFinishSwitch, owner, res.rollbackToken)
    // The source (local) copy is a hardlink and is never moved: it remains fully usable.
    expect(existsSync(rollout)).toBe(true)

    // ---- LEG D: the local→SSH transfer SOURCE leg keeps the local copy and hands off the upload --
    const xfer = (await call(
      IPC.codexAccountsTransferThreadToSsh,
      owner,
      THREAD,
      '/work',
      'proj-1',
      undefined,
      LOCAL
    )) as { threadId: string; imported: boolean }
    expect(xfer.imported).toBe(true)
    expect(remoteCodexImportThread).toHaveBeenCalledTimes(1)
    // The importer is handed the containment-validated relative path + the REAL local rollout, which
    // is never moved (the far-side landing / discover / rollback are PR 6, owed on a real host).
    const [, , , sessionsRelativePath, localRolloutPath] = remoteCodexImportThread.mock
      .calls[0] as unknown[]
    expect(sessionsRelativePath).toBe(`sessions/2026/08/rollout-${THREAD}.jsonl`)
    expect(localRolloutPath).toBe(rollout)
    expect(existsSync(rollout)).toBe(true)

    // ---- LEG E: per-account usage attribution — never mixed, never fabricated --------------------
    // Neutralise PATH so the app-server tier cannot resolve a real Codex binary;
    // no auth.json means the backend tier declines without a network call.
    const prevPath = process.env.PATH
    process.env.PATH = ''
    try {
      const rowA = await usageMod.fetchCodexUsage(localHome, {
        id: LOCAL,
        label: 'Work',
        email: 'work@example.com'
      })
      const rowSystem = await usageMod.fetchCodexUsage(systemHome)
      expect(rowA.accountId).toBe(LOCAL) // the managed row is stamped with its OWN id
      expect(rowA.account).toBe('work@example.com')
      expect(rowSystem.accountId).toBeUndefined() // the un-owned system row stays explicitly un-owned
      expect(rowSystem.account).toBeNull()
    } finally {
      process.env.PATH = prevPath
    }

    // ---- LEG F: no credential rides any argv, anywhere in the run --------------------------------
    // The tmux env args (the only place the account scope reaches a shell) carry ONLY CODEX_HOME +
    // NODETERM_CODEX_ACCOUNT_ID — no token, no secret.
    const tmuxArgs = coreMod.codexTmuxEnvArgs(userDataDir, LOCAL).join(' ')
    expect(tmuxArgs).not.toMatch(/TOKEN|SECRET|auth[_-]?json|Bearer/i)
    // The generated launcher threads credentials by stdin (`curl --config -`) and the account id via
    // the POST body — never on argv.
    const launcher = proxy.buildCodexLauncherScript()
    expect(launcher).toContain('--config -')
    expect(launcher).not.toMatch(/-H ["']?X-NodeTerm/) // no header credential on a curl argv
    expect(launcher).toContain('accountId=') // scope travels in the POST body
    // The OAuth-shadowing env vars are stripped at spawn, never placed on a command line.
    expect(coreMod.stripCodexAuthEnv({ OPENAI_API_KEY: 'x', CODEX_API_KEY: 'y', PATH: '/b' })).toEqual(
      { PATH: '/b' }
    )
  })

  // ---- LEG (fail-closed) 1: an explicitly selected MISSING account refuses to spawn — no fallback -
  it('an explicitly selected account whose home is missing refuses to spawn (no system fallback)', () => {
    // M1: return the system env here instead of the refusal ⇒ this greens wrongly.
    const scope = coreMod.resolveCodexSessionScope(userDataDir, 'neverloggedin1')
    expect(coreMod.isCodexScopeRefusal(scope)).toBe(true)
    expect(scope).toEqual({ unavailable: 'codex-account' })
    // The system account, by contrast, always resolves — the strictness is for an EXPLICIT id only.
    expect(coreMod.isCodexScopeRefusal(coreMod.resolveCodexSessionScope(userDataDir, undefined))).toBe(
      false
    )
  })

  // ---- LEG (fail-closed) 2: the same thread id in two scopes resolves to NO owner ----------------
  it('ambiguous ownership fails closed in the proxy, the sh resolver, and the relay catalog', () => {
    const recordRoot = path.join(userDataDir, 'codex-thread-nodes')
    const endpoint = path.join(userDataDir, 'hook-endpoint')
    // The SAME thread id, two accounts, two different owning nodes.
    proxy.writeCodexThreadIdentity(THREAD, 'node-sys', endpoint, recordRoot) // system scope
    proxy.writeCodexThreadIdentity(THREAD, 'node-mgd', endpoint, recordRoot, LOCAL) // managed scope

    // (a) the proxy — no account hint ⇒ owners.size !== 1 ⇒ undefined (M2 reds this).
    expect(proxy.resolveCodexThreadNodeIdentity(THREAD, recordRoot)).toBeUndefined()
    // …but WITH an explicit scope, direct resume resolves within that one account.
    expect(proxy.resolveCodexThreadNodeIdentity(THREAD, recordRoot, LOCAL)).toBe('node-mgd')
    expect(proxy.resolveCodexThreadNodeIdentity(THREAD, recordRoot, undefined /* n/a */)).toBeUndefined()

    // (b) the real POSIX-sh resolver with an EMPTY scope scans every account and binds nothing when
    // the match count is not exactly one (M5 reds this).
    const boundAmbiguous = runResolver(shMod.codexThreadIdentityResolverSh(recordRoot), {
      CODEX_THREAD_ID: THREAD,
      NODETERM_CODEX_ACCOUNT_ID: ''
    })
    expect(boundAmbiguous).toBe('')

    // (c) the relay catalog — two foreign accounts advertising the same id with different (unreadable)
    // inodes stay ambiguous; the id is dropped rather than resumed under a guessed owner.
    const merged = relayMod.mergeRelayThreadLists(
      [
        { socketPath: '/a.sock', threads: [{ id: THREAD, cwd: '/w', path: '/homeA/r.jsonl' } as any] },
        { socketPath: '/b.sock', threads: [{ id: THREAD, cwd: '/w', path: '/homeB/r.jsonl' } as any] }
      ],
      '/current.sock',
      {}
    )
    expect(merged.result.data.some((t) => t.id === THREAD)).toBe(false)
    expect(merged.foreignThreads.has(THREAD)).toBe(false)
  })

  // ---- LEG (fail-closed) 3: an existing DIFFERENT rollout is never overwritten (the exit-17 twin) -
  it('the rollout copy never overwrites a different existing target (local twin of remote exit 17)', () => {
    const sourceHome = makeManagedHome('acctsrc2')
    const targetHome = makeManagedHome('accttgt2')
    const srcSessions = path.join(sourceHome, 'sessions', '2026', '08')
    const tgtSessions = path.join(targetHome, 'sessions', '2026', '08')
    mkdirSync(srcSessions, { recursive: true })
    mkdirSync(tgtSessions, { recursive: true })
    const srcRollout = path.join(srcSessions, `rollout-${THREAD}.jsonl`)
    const tgtRollout = path.join(tgtSessions, `rollout-${THREAD}.jsonl`)
    writeFileSync(srcRollout, `{"id":"${THREAD}"}\n`)
    // A DIFFERENT conversation already occupies the target path (a different inode).
    writeFileSync(tgtRollout, `{"id":"other"}\n`)

    const plan = coreMod.planCodexRolloutExposure(sourceHome, targetHome, srcRollout, THREAD)
    // M3: tolerate the EEXIST collision without the dev/ino match ⇒ this stops throwing ⇒ red.
    expect(() => coreMod.commitCodexRolloutExposure(plan)).toThrow(/already has a different rollout/)
    // The target's foreign content is left byte-for-byte intact — never clobbered.
    expect(statSync(tgtRollout).ino).not.toBe(statSync(srcRollout).ino)
  })

  // ---- LEG (fail-closed) 4: the transfer source leg fails CLOSED when no importer is wired --------
  it('the local→SSH transfer refuses (named) when no remote importer is available', async () => {
    const { initCodexAccounts } = await import('./codex-accounts')
    // Re-init with NO ssh manager (getSshManager returns undefined) — the remote leg is unavailable.
    initCodexAccounts(() => undefined)
    const localHome = makeManagedHome(LOCAL)
    const sessionsDir = path.join(localHome, 'sessions', '2026', '08')
    mkdirSync(sessionsDir, { recursive: true })
    const rollout = path.join(sessionsDir, `rollout-${THREAD}.jsonl`)
    writeFileSync(rollout, `{"id":"${THREAD}"}\n`)
    readThread.mockResolvedValue({ id: THREAD, name: null, path: rollout })
    await expect(
      call(IPC.codexAccountsTransferThreadToSsh, makeSender(1), THREAD, '/work', 'proj-1', undefined, LOCAL)
    ).rejects.toThrow(/Remote Codex import is unavailable/)
  })

  // ---- LEG (both shells): the record-signing secret arms on the Server Edition shell -------------
  it('the Server Edition arms the codex record secret raw (0600 .bin), no keychain plaintext', async () => {
    const { resetNodeAuthSecretForTests } = await import('../core/agents/node-auth-secret')
    resetNodeAuthSecretForTests()
    proxy.resetCodexThreadIdentityAuthSecret()
    expect(proxy.codexThreadIdentityAvailable()).toBe(false)
    const { armServerNodeIdentity } = await import('../server/node-identity-arm')
    const hookServer = { setNodeAuthSecret: vi.fn() }
    await armServerNodeIdentity(hookServer, () => [])
    // The headless shell has no OS keychain: the secret is the raw 0600 `.bin`, never a sealed `.json`.
    const entries = readdirSync(userDataDir)
    expect(entries).toContain('node-auth-key.bin')
    expect(entries).not.toContain('node-auth-key.json')
    expect(statSync(path.join(userDataDir, 'node-auth-key.bin')).mode & 0o777).toBe(0o600)
    // …and the Codex record layer is now armed to sign on this shell (records verify instead of throwing).
    expect(hookServer.setNodeAuthSecret).toHaveBeenCalledOnce()
    expect(proxy.codexThreadIdentityAvailable()).toBe(true)
    resetNodeAuthSecretForTests()
  })

  // ---- LEG (fail-closed): with NO secret armed, writing an ownership record throws (no record) ----
  it('an unavailable signing secret fails a record write closed rather than writing unsigned', () => {
    proxy.resetCodexThreadIdentityAuthSecret()
    const recordRoot = path.join(userDataDir, 'codex-thread-nodes')
    expect(() =>
      proxy.writeCodexThreadIdentity(THREAD, 'node-1', path.join(userDataDir, 'ep'), recordRoot, LOCAL)
    ).toThrow(/authentication is unavailable/)
    expect(existsSync(path.join(recordRoot, LOCAL, THREAD))).toBe(false)
  })
})

/** Run the generated POSIX-sh resolver prelude under REAL `/bin/sh` and echo the node id it exports
 *  (empty when it binds nothing). The record dir is baked into the script; only CODEX_THREAD_ID and
 *  NODETERM_CODEX_ACCOUNT_ID vary per call. */
function runResolver(prelude: string, env: Record<string, string>): string {
  const script = `${prelude}\nprintf '%s' "\${NODETERM_NODE_ID-}"`
  return execFileSync('/bin/sh', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8'
  }).trim()
}
