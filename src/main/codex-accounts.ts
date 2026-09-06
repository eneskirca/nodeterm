// Impure lifecycle for machine-scoped managed Codex accounts (S6 PR 5) — the leg that makes
// account-scoping REACHABLE for LOCAL accounts. Mirrors `claude-accounts.ts` (add / device-login /
// cancel / remove) and adds the three-phase, owner-authorized SAME-MACHINE switch (resume the same
// conversation id, never fork) plus the SOURCE side of moving an idle conversation to an SSH
// account. The account LIST is renderer-owned in `settings.json` (`codexAccounts`); this module owns
// only the filesystem, the per-account app-server daemon, and the switch reservation state.
//
// The copy primitives are NOT re-implemented here: `planCodexRolloutExposure` /
// `commitCodexRolloutExposure` (src/core/codex-accounts-core.ts, PR 3) are the atomic, never-
// overwrite hardlink. Based on @Corvin's `codex-accounts.ts` in PR #112, re-sliced onto the PR 3/4
// primitives with the SSH transfer source leg (its remote landing is PR 6).
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { ipcMain, type WebContents } from 'electron'
import { IPC } from '../shared/ipc'
import {
  assertCodexAccountId,
  commitCodexRolloutExposure,
  codexAccountHome,
  codexHomeForAccount,
  codexSessionEnv,
  codexSocketForAccount,
  ensureSharedCodexDaemon,
  legacyCodexAccountHome,
  migrateLegacyCodexAccountHome,
  migrateLegacyCodexAccountHomes,
  planCodexRolloutExposure,
  type CodexRolloutExposurePlan
} from '../core/codex-accounts-core'
import { readCodexAccountAt, readCodexThreadAt } from '../core/codex-session-name'
import { directExecutableInvocation } from '../core/exec-path'
import { ensureCodexRelayRoot } from './codex-relay-daemon'
import { platform } from '../core/platform'
import { findInLoginPath } from '../core/pty-manager'
import type { SshProjectManager } from './remote-ssh/ssh-project'

const execFileP = promisify(execFile)
const LOGIN_POLL_MS = 2000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** Non-secret runtime assets symlinked from the system home into each managed home: shared
 *  installation, never a credential or the thread SQLite DB. */
const SHARED_ENTRIES = ['config.toml', 'AGENTS.md', 'skills', 'plugins', 'packages', 'rules', 'hooks.json']
const SWITCH_RESERVATION_TTL_MS = 60_000
/** A threadId that could reach the filesystem as a path component. Same shape as ACCOUNT_ID_RE. */
const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** PR 6 provides this on the SSH manager. Typed structurally here so PR 5 can hand the source leg
 *  off without depending on PR 6's implementation. */
type CodexSshImporter = {
  remoteCodexImportThread?(
    projectId: string,
    accountId: string | undefined,
    threadId: string,
    sessionsRelativePath: string,
    localRolloutPath: string
  ): Promise<{ imported: boolean }>
}

const waiters = new Map<string, { cancelled: boolean }>()

/**
 * One in-flight switch reservation. Holds the planned (but maybe not yet committed) exposure, the
 * two account ids it pins (so removal refuses while it holds them — Property 10), the owning
 * WebContents (every phase must be driven by the SAME renderer — Property owner-authorized), and
 * the auto-release wiring (owner `destroyed` or the TTL).
 */
type PendingSwitchExposure = {
  exposure?: CodexRolloutExposurePlan
  sourceAccountId?: string
  targetAccountId?: string
  committed: boolean
  owner: WebContents
  ownerDestroyed: () => void
  timer: ReturnType<typeof setTimeout>
}
const pendingSwitchExposures = new Map<string, PendingSwitchExposure>()
const removingCodexAccounts = new Set<string>()

function releasePendingSwitch(token: string): void {
  const pending = pendingSwitchExposures.get(token)
  if (!pending) return
  pendingSwitchExposures.delete(token)
  clearTimeout(pending.timer)
  if (!pending.owner.isDestroyed()) pending.owner.removeListener('destroyed', pending.ownerDestroyed)
}

export function localCodexAccountHome(accountId: string): string {
  return codexAccountHome(platform().userDataDir, accountId)
}

export function localCodexSocket(accountId?: string): string {
  return codexSocketForAccount(platform().userDataDir, accountId)
}

/**
 * Reuse the account's shared app-server if it is already answering on its control socket, else boot
 * one exactly once (§2.2). The managed home is migrated to its short form first so the app-server
 * Unix socket stays under `SUN_LEN`. UNVERIFIED against a real Codex CLI headless (probe U4/U6) —
 * device-verification owed; the control flow (probe → start-once) is pure and tested via injection.
 */
export async function ensureCodexAccountDaemon(accountId?: string): Promise<void> {
  if (accountId) migrateLegacyCodexAccountHome(platform().userDataDir, accountId)
  const socket = localCodexSocket(accountId)
  await ensureSharedCodexDaemon(
    async () => (await readCodexAccountAt(socket, 1000)) !== null,
    async () => {
      const codex = await findInLoginPath('codex')
      if (!codex) throw new Error('Codex CLI unavailable')
      const invocation = directExecutableInvocation(codex, ['app-server', 'daemon', 'start'])
      if (!invocation) throw new Error('Codex CLI has no safe Windows entry point')
      await execFileP(invocation.executable, invocation.args, {
        ...invocation.options,
        cwd: os.homedir(),
        env: { ...process.env, ...codexSessionEnv(platform().userDataDir, accountId) },
        timeout: 15_000,
        maxBuffer: 1024 * 1024
      })
    }
  )
}

/**
 * Create a managed account's private home (0700) and symlink the shared, NON-secret runtime assets
 * from the system home in. Credentials (`auth.json`) and the thread DB are never shared — only
 * installation assets. A missing source asset is skipped; an existing target link is left as-is.
 */
async function initializeAccountHome(id: string): Promise<string> {
  migrateLegacyCodexAccountHome(platform().userDataDir, id)
  const home = localCodexAccountHome(id)
  await fs.mkdir(home, { recursive: true, mode: 0o700 })
  await fs.chmod(home, 0o700)
  const sourceHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex')
  for (const name of SHARED_ENTRIES) {
    const source = path.join(sourceHome, name)
    const target = path.join(home, name)
    try {
      await fs.lstat(source)
      await fs.symlink(source, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'EEXIST') throw error
    }
  }
  return home
}

async function accountIdentity(accountId?: string): Promise<{ email: string | null } | null> {
  await ensureCodexAccountDaemon(accountId)
  return readCodexAccountAt(localCodexSocket(accountId), 5000)
}

/**
 * Read an already-logged-in managed account's identity. The login GATE is a REAL non-symlink
 * `auth.json`: a symlinked or absent credential is "not logged in" and returns null (Property 10 /
 * §2.1 — a managed account acts only as its OWN login, never a symlink into the system jar).
 */
async function existingManagedIdentity(id: string): Promise<{ email: string | null } | null> {
  assertCodexAccountId(id)
  try {
    migrateLegacyCodexAccountHome(platform().userDataDir, id)
    const auth = await fs.lstat(path.join(localCodexAccountHome(id), 'auth.json'))
    if (!auth.isFile() || auth.isSymbolicLink()) return null
    return await accountIdentity(id)
  } catch {
    return null
  }
}

/**
 * THREE SURFACES (global-constraint 5), stated explicitly:
 *
 *  - **Desktop (Electron)** — the full feature. This module registers its IPC over `electron`'s
 *    `ipcMain`, and owner-authorization keys off `event.sender.id` (a WebContents). `src/main/
 *    index.ts` is the ONLY caller.
 *  - **Server Edition (headless / an SSH host)** — this IPC surface is deliberately **N/A** here,
 *    and PR 5 does NOT wire it. The verbs are `ipcMain.handle` + WebContents-owner semantics, which
 *    the headless CorePlatform bridge does not provide, so `startServer` never calls
 *    `initCodexAccounts`. This is not a silent gap: managed Codex logins **on an SSH host** are
 *    driven by the DESKTOP over SSH / `RemoteHooks` (the remote account-add / device-login / import
 *    legs), which is **PR 6's** work — the host runs the relay + import, not its own copy of this
 *    IPC. The Server Edition still arms the codex identity *record secret* (src/server/
 *    node-identity-arm.ts) so records sign; it just does not host the account-management verbs.
 *    **PR 6 obligation:** if the remote leg needs SE-side handlers, PR 6 wires them through the
 *    server bridge — PR 5 intentionally left that unbuilt. Nothing in PR 5 assumes an SE IPC
 *    surface exists.
 *  - **Mobile (phone)** — never originates an add/switch/copy; it drives via relay→IPC and reads
 *    state. No mint here.
 *
 * @param getSshManager Lazily resolves the SSH project manager (created after this init in
 * index.ts). Only the local→SSH transfer SOURCE leg uses it today; local account ops never do.
 */
export function initCodexAccounts(getSshManager?: () => SshProjectManager | undefined): void {
  // Ensure `~/.nodeterm` exists before any relay/daemon reach (carried PR-4 obligation: only the
  // relay's detached serve() created it before, so a first reach from this process could race a
  // missing root).
  ensureCodexRelayRoot()
  // Synchronous, BEFORE renderer hydration / PTY restore: a legacy long CODEX_HOME cannot host the
  // app-server Unix socket, and an already-persisted managed node must see its migrated home on its
  // very first spawn.
  migrateLegacyCodexAccountHomes(platform().userDataDir)

  ipcMain.handle(IPC.codexAccountsAdd, async () => {
    const id = randomUUID()
    return { id, home: await initializeAccountHome(id) }
  })

  ipcMain.handle(IPC.codexAccountsWaitLogin, async (_event, id: string) => {
    assertCodexAccountId(id)
    const home = localCodexAccountHome(id)
    const waiter = { cancelled: false }
    waiters.set(id, waiter)
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    try {
      while (!waiter.cancelled && Date.now() < deadline) {
        try {
          // The login gate: a REAL file, never a symlink. A device login writes auth.json into the
          // managed home; a symlink here would mean the account is riding the system credential.
          const auth = await fs.lstat(path.join(home, 'auth.json'))
          if (auth.isFile() && !auth.isSymbolicLink()) {
            const identity = await accountIdentity(id)
            if (identity) return identity
          }
        } catch {
          // No credential file yet, or its daemon is not ready — keep polling.
        }
        await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS))
      }
      return null
    } finally {
      waiters.delete(id)
    }
  })

  ipcMain.handle(IPC.codexAccountsCancelWait, (_event, id: string) => {
    const waiter = waiters.get(id)
    if (waiter) waiter.cancelled = true
  })

  ipcMain.handle(IPC.codexAccountsIdentity, (_event, id: string) => existingManagedIdentity(id))

  // No ctx ⇒ this Mac's system identity. A `{ projectId }` ctx asks for a remote HOST's system
  // identity, which this build does not yet resolve — fail closed to `null` rather than returning
  // THIS Mac's login, so a remote machine panel never fabricates/borrows a local identity
  // (§5 "system-account discovery must not fabricate an account"). Remote resolution is a follow-up.
  ipcMain.handle(
    IPC.codexAccountsSystemIdentity,
    (_event, ctx?: { projectId?: string }) =>
      ctx?.projectId ? Promise.resolve(null) : accountIdentity()
  )

  ipcMain.handle(IPC.codexAccountsRemove, async (_event, id: string) => {
    assertCodexAccountId(id)
    // Property 10 — race/use-safe removal. Refuse while a switch reservation holds this account, or
    // while a concurrent removal is already in flight.
    if (
      [...pendingSwitchExposures.values()].some(
        (pending) => pending.sourceAccountId === id || pending.targetAccountId === id
      )
    ) {
      throw new Error('Codex account is reserved by an account switch')
    }
    if (removingCodexAccounts.has(id)) throw new Error('Codex account removal is already in progress')
    removingCodexAccounts.add(id)
    try {
      const waiter = waiters.get(id)
      if (waiter) waiter.cancelled = true
      try {
        const codex = await findInLoginPath('codex')
        if (codex) {
          const invocation = directExecutableInvocation(codex, ['app-server', 'daemon', 'stop'])
          if (!invocation) throw new Error('Codex CLI has no safe Windows entry point')
          await execFileP(invocation.executable, invocation.args, {
            ...invocation.options,
            cwd: os.homedir(),
            env: { ...process.env, CODEX_HOME: localCodexAccountHome(id) },
            timeout: 10_000,
            maxBuffer: 1024 * 1024
          })
        }
      } catch {
        // A stopped/missing daemon is already the desired state.
      }
      const home = localCodexAccountHome(id)
      const legacy = legacyCodexAccountHome(platform().userDataDir, id)
      await fs.rm(home, { recursive: true, force: true })
      if (legacy !== home) await fs.rm(legacy, { recursive: true, force: true })
    } finally {
      removingCodexAccounts.delete(id)
    }
  })

  // ---- The three-phase, owner-authorized, TTL-bounded switch (§4.1 / Properties 5, 10) ----------

  ipcMain.handle(
    IPC.codexAccountsSwitchThread,
    async (
      event,
      threadId: string,
      cwd: string,
      sourceAccountId?: string,
      targetAccountId?: string
    ) => {
      if (!SAFE_THREAD_ID.test(threadId) || !path.isAbsolute(cwd)) {
        throw new Error('Invalid Codex account switch request')
      }
      if (sourceAccountId) assertCodexAccountId(sourceAccountId)
      if (targetAccountId) assertCodexAccountId(targetAccountId)
      if (sourceAccountId === targetAccountId) return { threadId }
      if (
        (sourceAccountId && removingCodexAccounts.has(sourceAccountId)) ||
        (targetAccountId && removingCodexAccounts.has(targetAccountId))
      ) {
        throw new Error('Codex account removal is in progress')
      }
      const rollbackToken = randomUUID()
      const ownerDestroyed = (): void => releasePendingSwitch(rollbackToken)
      const timer = setTimeout(() => releasePendingSwitch(rollbackToken), SWITCH_RESERVATION_TTL_MS)
      timer.unref?.()
      event.sender.once('destroyed', ownerDestroyed)
      // Reserve BEFORE planning so a concurrent removal of either account is already blocked while
      // we read the app-server and plan the exposure.
      pendingSwitchExposures.set(rollbackToken, {
        sourceAccountId,
        targetAccountId,
        committed: false,
        owner: event.sender,
        ownerDestroyed,
        timer
      })
      try {
        await ensureCodexAccountDaemon(sourceAccountId)
        await ensureCodexAccountDaemon(targetAccountId)
        const source = await readCodexThreadAt(localCodexSocket(sourceAccountId), threadId, 5000)
        if (!source?.path) throw new Error('Source Codex conversation is unavailable')
        const exposure = planCodexRolloutExposure(
          codexHomeForAccount(platform().userDataDir, sourceAccountId),
          codexHomeForAccount(platform().userDataDir, targetAccountId),
          source.path,
          threadId
        )
        const pending = pendingSwitchExposures.get(rollbackToken)
        if (!pending) throw new Error('Codex account switch preparation expired')
        pending.exposure = exposure
        return { threadId, rollbackToken }
      } catch (error) {
        releasePendingSwitch(rollbackToken)
        throw error
      }
    }
  )

  ipcMain.handle(IPC.codexAccountsCommitSwitch, (event, token: string) => {
    const pending = pendingSwitchExposures.get(token)
    // Owner-authorized: only the WebContents that reserved the switch may commit it.
    if (!pending?.exposure || pending.owner.id !== event.sender.id) {
      throw new Error('Codex account switch preparation expired')
    }
    commitCodexRolloutExposure(pending.exposure)
    pending.committed = true
  })

  ipcMain.handle(IPC.codexAccountsFinishSwitch, (event, token: string) => {
    const pending = pendingSwitchExposures.get(token)
    if (!pending?.committed || pending.owner.id !== event.sender.id) {
      throw new Error('Codex account switch was not committed')
    }
    releasePendingSwitch(token)
  })

  ipcMain.handle(IPC.codexAccountsRollbackSwitch, (event, token: string) => {
    const pending = pendingSwitchExposures.get(token)
    if (pending?.owner.id === event.sender.id) releasePendingSwitch(token)
  })

  // ---- Local → SSH transfer SOURCE leg (§4.2b, Task 5.3). The remote landing is PR 6 ------------

  ipcMain.handle(
    IPC.codexAccountsTransferThreadToSsh,
    async (
      _event,
      threadId: string,
      cwd: string,
      projectId: string,
      targetAccountId?: string,
      sourceAccountId?: string
    ) => {
      if (!SAFE_THREAD_ID.test(threadId) || !path.isAbsolute(cwd) || !projectId) {
        throw new Error('Invalid Codex transfer request')
      }
      if (sourceAccountId) assertCodexAccountId(sourceAccountId)
      if (targetAccountId) assertCodexAccountId(targetAccountId)
      await ensureCodexAccountDaemon(sourceAccountId)
      const source = await readCodexThreadAt(localCodexSocket(sourceAccountId), threadId, 5000)
      if (!source?.path) throw new Error('Source Codex conversation is unavailable')
      // STRICT SOURCE CONTAINMENT before any upload: reuse PR 3's `planCodexRolloutExposure`
      // (source-side half) rather than re-implementing the guards. It refuses a source that is not a
      // regular file, whose basename does not end `<threadId>.jsonl`, or that escapes
      // `<sourceHome>/sessions/` (realpath + containment + no symlinked segment). Passing the source
      // home as the target home is safe: only the SOURCE fields are read here, the local rollout is
      // never linked/moved (it stays fully usable — §4.2 step 6).
      const sourceHome = codexHomeForAccount(platform().userDataDir, sourceAccountId)
      const plan = planCodexRolloutExposure(sourceHome, sourceHome, source.path, threadId)
      const sessionsRelativePath = path.posix.join('sessions', plan.targetRelativePath.split(path.sep).join('/'))
      // Hand the actual upload + atomic remote install to PR 6's importer. Absent (not yet wired /
      // no live SSH manager) fails closed with a named error rather than silently succeeding.
      const importer = getSshManager?.() as (SshProjectManager & CodexSshImporter) | undefined
      if (!importer?.remoteCodexImportThread) {
        throw new Error('Remote Codex import is unavailable')
      }
      const result = await importer.remoteCodexImportThread(
        projectId,
        targetAccountId,
        threadId,
        sessionsRelativePath,
        plan.sourcePath
      )
      return { threadId, imported: result.imported }
    }
  )
}
