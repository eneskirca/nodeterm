// Pure model + on-disk layout for machine-scoped managed Codex accounts. Mirrors
// `claude-accounts-core.ts` (multiple managed logins), with `CODEX_HOME` in place of
// `CLAUDE_CONFIG_DIR` and OpenAI/Codex key vars in the auth-env strip. Only `crypto`/`fs`/`os`/
// `path` — no electron, no `../main/*` — so it arms on headless Server Edition too. The impure
// account LIST + login lifecycle land in a later PR's `src/main/codex-accounts.ts`; the
// `platform()` seam for `userDataDir` lives in `codex-config-dir.ts`.
//
// Ships INERT (nothing spawns against it yet) but fully tested. Based on @Corvin's
// `codex-accounts-core.ts` in PR #112, re-sliced to the S6 PR-1 model layer.
import { capabilityAgentId } from '../shared/agents/config'
import { createHash, randomUUID } from 'crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync
} from 'fs'
import { renameAtomicSync } from './fs-atomic'
import os from 'os'
import path from 'path'
import { ACCOUNT_ID_RE, isSafeAccountId } from '../shared/codex-account'

export { ACCOUNT_ID_RE, isSafeAccountId } from '../shared/codex-account'

/**
 * Throw on any id that could escape the accounts root — locally OR on a remote host over ssh.
 * Account ids reach the filesystem as directory / socket / scope / mapping-file components and
 * come from attacker-controlled `settings.json` / `project.json`, so this is the supply-chain
 * guard: `''`, `.`, `..`, `a/b`, `/absolute`, and whitespace ids are all refused at the door.
 */
export function assertCodexAccountId(id: string): void {
  if (!isSafeAccountId(id)) throw new Error('Invalid Codex account id')
}

/** The pre-migration long home, `<userData>/codex-accounts/<id>`, moved to the short home at boot. */
export function legacyCodexAccountHome(userDataDir: string, accountId: string): string {
  assertCodexAccountId(accountId)
  return path.join(userDataDir, 'codex-accounts', accountId)
}

/**
 * A managed account's local home, `~/.nodeterm/cx/<sha256(userDataDir\0accountId)[0..16]>`, mode
 * `0o700`. The digest is deliberately SHORT: the app-server control socket lives two levels below
 * it (`<home>/app-server-control/app-server-control.sock`) and must stay under macOS `SUN_LEN` —
 * the normal Electron userData path plus a UUID already overshoots. `userDataDir` is folded into
 * the digest so separate NodeTerm profiles never collide, without a global static account root.
 */
export function codexAccountHome(
  userDataDir: string,
  accountId: string,
  shortRoot = path.join(os.homedir(), '.nodeterm', 'cx')
): string {
  assertCodexAccountId(accountId)
  const digest = createHash('sha256')
    .update(userDataDir)
    .update('\0')
    .update(accountId)
    .digest('hex')
    .slice(0, 16)
  return path.join(shortRoot, digest)
}

/**
 * Move one legacy long home to its deterministic short home, fail-closed: no-op if the legacy dir
 * is absent, the target already exists, or the paths coincide. An id that fails the regex throws
 * (via `legacyCodexAccountHome`) and is therefore left untouched by the boot sweep below.
 */
export function migrateLegacyCodexAccountHome(
  userDataDir: string,
  accountId: string,
  shortRoot?: string
): string {
  const legacy = legacyCodexAccountHome(userDataDir, accountId)
  const target = codexAccountHome(userDataDir, accountId, shortRoot)
  if (legacy === target || !existsSync(legacy) || existsSync(target)) return target
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  renameAtomicSync(legacy, target)
  return target
}

/** Boot sweep: migrate every legacy managed home. Invalid / unmovable entries are left in place. */
export function migrateLegacyCodexAccountHomes(userDataDir: string, shortRoot?: string): void {
  const legacyRoot = path.join(userDataDir, 'codex-accounts')
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = readdirSync(legacyRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      migrateLegacyCodexAccountHome(userDataDir, entry.name, shortRoot)
    } catch {
      // Invalid/unmovable entries remain untouched and therefore fail closed.
    }
  }
}

/** The SYSTEM Codex home: `$CODEX_HOME` when set to an absolute path, else `~/.codex`. */
export function systemCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim()
  return configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.codex')
}

/** System vs managed is presence/absence of an id: no id ⇒ `~/.codex`; a valid id ⇒ its short home. */
export function codexHomeForAccount(userDataDir: string, accountId?: string): string {
  return accountId ? codexAccountHome(userDataDir, accountId) : systemCodexHome()
}

/** The one persistent app-server's control socket for an account (system or managed). */
export function codexSocketForAccount(userDataDir: string, accountId?: string): string {
  return path.join(
    codexHomeForAccount(userDataDir, accountId),
    'app-server-control',
    'app-server-control.sock'
  )
}

/** Short, deterministic remote homes keep the app-server Unix socket below SUN_LEN. A remote host
 *  has ONE home root, so the digest is over `accountId` only. */
export function remoteCodexHome(remoteHome: string, accountId?: string): string {
  if (!path.posix.isAbsolute(remoteHome)) throw new Error('Remote home must be absolute')
  if (!accountId) return path.posix.join(remoteHome, '.codex')
  assertCodexAccountId(accountId)
  const digest = createHash('sha256').update(accountId).digest('hex').slice(0, 16)
  return path.posix.join(remoteHome, '.nodeterm', 'cx', digest)
}

export function remoteCodexSocket(remoteHome: string, accountId?: string): string {
  return path.posix.join(
    remoteCodexHome(remoteHome, accountId),
    'app-server-control',
    'app-server-control.sock'
  )
}

export function remoteCodexSessionEnv(
  remoteHome: string,
  accountId?: string
): { CODEX_HOME: string; NODETERM_CODEX_ACCOUNT_ID: string } {
  return {
    CODEX_HOME: remoteCodexHome(remoteHome, accountId),
    NODETERM_CODEX_ACCOUNT_ID: accountId ?? ''
  }
}

export function remoteCodexTmuxEnvArgs(remoteHome: string, accountId?: string): string[] {
  return Object.entries(remoteCodexSessionEnv(remoteHome, accountId)).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`
  ])
}

/**
 * One shared Codex `app-server` per (machine, account): reuse it if it is already reachable, else
 * start it exactly once (§2.2, the RAM-saver — not one app-server per node). `probe` answers "is a
 * live app-server already listening on this account's control socket?"; `start` boots one. Kept in
 * core (pure control flow over two injected effects) so the same primitive arms on desktop and on
 * headless Server Edition, and so a test drives it with fakes rather than a real Codex CLI.
 * Based on @Corvin's `ensureSharedCodexDaemon` in PR #112.
 */
export async function ensureSharedCodexDaemon(
  probe: () => Promise<boolean>,
  start: () => Promise<void>
): Promise<void> {
  if (await probe()) return
  await start()
}

/**
 * Explicit per-session env. An EMPTY account id means the system account and is written
 * explicitly, so it OVERWRITES any managed `NODETERM_CODEX_ACCOUNT_ID` inherited from a parent
 * (tmux shares one server env) rather than silently acting as the wrong login.
 */
export function codexSessionEnv(
  userDataDir: string,
  accountId?: string
): { CODEX_HOME: string; NODETERM_CODEX_ACCOUNT_ID: string } {
  return {
    CODEX_HOME: codexHomeForAccount(userDataDir, accountId),
    NODETERM_CODEX_ACCOUNT_ID: accountId ?? ''
  }
}

/** A refusal carrying the same `unavailable` code the spawn layer surfaces to the renderer. */
export interface CodexScopeRefusal {
  unavailable: 'codex-account'
}
export type CodexSessionScope =
  | { CODEX_HOME: string; NODETERM_CODEX_ACCOUNT_ID: string }
  | CodexScopeRefusal

export function isCodexScopeRefusal(scope: CodexSessionScope): scope is CodexScopeRefusal {
  return (scope as CodexScopeRefusal).unavailable === 'codex-account'
}

/**
 * Resolve the session scope for a Codex spawn, fail-closed (S6 Decision 2 / §5 property 4).
 *
 * An EXPLICITLY selected managed account whose home is missing REFUSES (`{ unavailable:
 * 'codex-account' }`) — it never falls back to the system home. This is deliberately STRICTER than
 * the Claude sibling's `pty-manager` fallback: silently acting as the wrong login is a worse
 * failure for an explicit switch than for a first spawn. The system account (no id) always
 * resolves and, per `codexSessionEnv`, explicitly clears any inherited managed scope.
 *
 * `homeExists` is injected so the spawn layer passes real `existsSync` and this stays testable
 * against a real temp filesystem. The later `pty-manager` PR maps `unavailable` straight through.
 */
export function resolveCodexSessionScope(
  userDataDir: string,
  accountId: string | undefined,
  homeExists: (home: string) => boolean = existsSync
): CodexSessionScope {
  if (!accountId) return codexSessionEnv(userDataDir)
  assertCodexAccountId(accountId)
  const home = codexAccountHome(userDataDir, accountId)
  if (!homeExists(home)) return { unavailable: 'codex-account' }
  return { CODEX_HOME: home, NODETERM_CODEX_ACCOUNT_ID: accountId }
}

/**
 * Codex agents need an explicit system-or-managed scope; a plain login terminal needs it when it
 * carries a managed CODEX account id. Sharing this predicate keeps tmux and plain PTYs aligned.
 *
 * `isCodexAccount` is REQUIRED, and deliberately has no default, because neither guess is safe.
 * Managed Claude and Codex accounts are separate lists that share one id alphabet, so the id alone
 * cannot say which provider it belongs to. Answering "yes" for any id — which this predicate used
 * to do via `!!accountId` — sends every managed CLAUDE node into the fail-closed Codex gate, where
 * it looks for a `~/.nodeterm/cx/<digest>` home that a Claude account never populates and REFUSES
 * (issue #345: agent nodes and the `claude /login` terminal alike spawned nothing). Answering "no"
 * by default would be worse in the other direction: the `codex login` terminal would spawn without
 * a scope and write its credential into the user's SYSTEM `~/.codex`. So the caller must say.
 */
export function needsCodexAccountScope(
  agentId: string | undefined,
  accountId: string | undefined,
  isCodexAccount: (id: string) => boolean
): boolean {
  if (agentId && capabilityAgentId(agentId) === 'codex') return true
  if (!accountId) return false
  return isCodexAccount(accountId)
}

/**
 * Usage discovery follows actual account HOMES, not the renderer's eventually-consistent `pending`
 * marker: a completed auth file can exist after a restart before settings reconciles, and the
 * provider itself safely reports `unavailable` when a home is not logged in yet. Consumed by the
 * usage PR.
 */
export function codexUsageAccounts(
  accounts: ReadonlyArray<{
    id: string
    label: string
    email?: string | null
    pending?: boolean
  }>,
  homeFor: (accountId: string) => string
): Array<{ id: string; home: string; label: string; email?: string | null }> {
  return accounts.map((account) => ({
    id: account.id,
    home: homeFor(account.id),
    label: account.label,
    email: account.email
  }))
}

/** tmux has a shared server env, so both values must be set explicitly per new Codex session. */
export function codexTmuxEnvArgs(userDataDir: string, accountId?: string): string[] {
  return Object.entries(codexSessionEnv(userDataDir, accountId)).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`
  ])
}

/**
 * Env vars that would silently SHADOW the selected account's OAuth login (`auth.json`) by forcing
 * API-key auth instead — the Codex analogue of Claude's `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`
 * strip. Removed from the session env at spawn so a managed account always acts as its own login.
 * A credential is never placed on argv (the hook-token-argv lesson); this only touches the env.
 */
export const AUTH_ENV_STRIP = ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const

/** Return a copy of `env` with every `AUTH_ENV_STRIP` var removed. Applied at spawn by the pty PR. */
export function stripCodexAuthEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const out = { ...env }
  for (const key of AUTH_ENV_STRIP) delete out[key]
  return out
}

// ---------------------------------------------------------------------------
// Cross-account rollout exposure (S6 §4.1 same-machine switch; §5 property 2).
//
// Exposing a conversation's rollout to another account is an ATOMIC HARDLINK of the source rollout
// inode into the target account's `sessions/<same relative path>`: the same inode ⇒ a byte-identical
// conversation id, and the link survives deletion of either account home because each link names the
// inode independently. `plan` validates and mutates nothing; `commit` performs the link, fails closed
// on any collision that is not already the same inode, and refuses to write THROUGH a symlinked
// directory segment. Ships INERT here — the switch protocol (PR 5/6) wires plan → reserve → commit.
// Based on @Corvin's `planCodexRolloutExposure`/`commitCodexRolloutExposure` in PR #112.
//
// PROBE U3 (same-filesystem requirement) — measured 2026-08-19 on Linux ext4 (this build host):
// `~/.codex` and `~/.nodeterm/cx` are direct children of `$HOME` and shared device 64512; a real
// `link(2)` between them SUCCEEDED. Both legs of a same-machine switch are LOCAL homes under that
// tree, so the standard layout is same-device. `link(2)` throws `EXDEV` across mounts, and a `$HOME`
// subtree CAN be bind-mounted onto another volume (measured: `~/.npm`, `~/.cache` were on a separate
// device on this host), so v1 does NOT silently fall back to a byte copy (per the approved non-goal,
// S6-spec §8): `commit` surfaces a NAMED `EXDEV` error instead. A cross-mount copy fallback is
// explicitly out of scope for S6 v1.

/**
 * Return `candidate` relative to `root` only when it stays strictly INSIDE `root`; otherwise `null`.
 * Rejects `..`, a `..`-leading path, and any absolute path — the traversal containment check reused
 * by both the source-account guard (plan) and the target-segment walk (commit).
 */
function containedRelativePath(root: string, candidate: string): string | null {
  const relative = path.relative(root, candidate)
  return relative &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
    ? relative
    : null
}

export interface CodexRolloutExposurePlan {
  /** Canonicalized (`realpathSync`) absolute path of the source rollout. */
  sourcePath: string
  /** `<realpath(targetHome)>/sessions` — the target account's sessions root. */
  targetSessionsRoot: string
  /** The rollout's path relative to its account's `sessions/`, preserved verbatim in the target. */
  targetRelativePath: string
  /** `targetSessionsRoot`/`targetRelativePath` — where the hardlink is published. */
  targetPath: string
  /** Source inode identity, re-verified before and after the link so a mid-flight swap fails closed. */
  sourceDev: number
  sourceIno: number
}

/**
 * Validate a cross-account rollout exposure and return a plan. MUTATES NOTHING — no directory is
 * created, no link is made; a rejected request leaves the filesystem untouched (§5 property 2).
 *
 * Checks: `sourceHome`/`targetHome`/`sourcePath` absolute; `threadId` matches the id regex; the
 * filename ends `<threadId>.jsonl`; `sourcePath` is a regular file (via `lstatSync`, so a symlink is
 * NOT followed here); and the canonicalized source stays strictly inside `<sourceHome>/sessions`
 * (`realpathSync` + containment) so nothing outside the source account can be exposed.
 */
export function planCodexRolloutExposure(
  sourceHome: string,
  targetHome: string,
  sourcePath: string,
  threadId: string
): CodexRolloutExposurePlan {
  if (
    !path.isAbsolute(sourceHome) ||
    !path.isAbsolute(targetHome) ||
    !path.isAbsolute(sourcePath) ||
    !ACCOUNT_ID_RE.test(threadId) ||
    !path.basename(sourcePath).endsWith(`${threadId}.jsonl`)
  ) {
    throw new Error('Invalid Codex rollout exposure request')
  }
  if (!lstatSync(sourcePath).isFile()) throw new Error('Source Codex rollout is not a regular file')
  const sourceSessions = realpathSync(path.join(sourceHome, 'sessions'))
  const canonicalSource = realpathSync(sourcePath)
  const relative = containedRelativePath(sourceSessions, canonicalSource)
  if (!relative) throw new Error('Source Codex rollout is outside its account home')
  const sourceStat = statSync(canonicalSource)
  const targetSessionsRoot = path.join(realpathSync(targetHome), 'sessions')
  return {
    sourcePath: canonicalSource,
    targetSessionsRoot,
    targetRelativePath: relative,
    targetPath: path.join(targetSessionsRoot, relative),
    sourceDev: sourceStat.dev,
    sourceIno: sourceStat.ino
  }
}

/**
 * Commit a plan by ATOMICALLY hardlinking the source inode into the target account. Fail-closed
 * throughout (§5 property 2):
 *  - re-verifies the source `dev`/`ino` BEFORE and AFTER the link — a mid-flight source swap throws;
 *  - walks every target directory segment and refuses any that is a symlink (never writes THROUGH a
 *    symlinked `sessions/` or sub-directory — the escape a target `sessions` symlink would open);
 *  - `link(2)` is no-overwrite. On `EEXIST` the collision is tolerated ONLY when the existing target
 *    is the SAME inode (`dev`/`ino` match — an idempotent re-expose); otherwise it throws "Target
 *    Codex account already has a different rollout for this thread" and never overwrites;
 *  - publishes from a private verified temporary link so cleanup can never delete an unrelated entry
 *    raced into the final pathname, and removes that temporary only while it still names our inode.
 *
 * A cross-mount source/target throws a NAMED `EXDEV` error (probe U3) — NO silent copy fallback.
 * `linkFile` is injectable so a test can force a specific `link(2)` failure against a real fs.
 */
export function commitCodexRolloutExposure(
  plan: CodexRolloutExposurePlan,
  linkFile: typeof linkSync = linkSync
): void {
  const isVerifiedRollout = (candidate: string): boolean => {
    try {
      const entry = lstatSync(candidate)
      const linked = statSync(candidate)
      return (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        linked.dev === plan.sourceDev &&
        linked.ino === plan.sourceIno
      )
    } catch {
      return false
    }
  }
  const link = (from: string, to: string): void => {
    try {
      linkFile(from, to)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        throw new Error(
          'Codex rollout accounts must share a filesystem; cross-mount rollout copy is not supported'
        )
      }
      throw error
    }
  }
  const sourceEntry = lstatSync(plan.sourcePath)
  if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink()) {
    throw new Error('Source Codex rollout changed before account switch commit')
  }
  const current = statSync(plan.sourcePath)
  if (current.dev !== plan.sourceDev || current.ino !== plan.sourceIno) {
    throw new Error('Source Codex rollout changed before account switch commit')
  }
  const segments = path.dirname(plan.targetRelativePath).split(path.sep).filter(Boolean)
  let currentDir = plan.targetSessionsRoot
  for (const segment of ['', ...segments]) {
    if (segment) currentDir = path.join(currentDir, segment)
    if (!existsSync(currentDir)) mkdirSync(currentDir, { mode: 0o700 })
    const entry = lstatSync(currentDir)
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Target Codex rollout path contains an unsafe directory')
    }
  }
  if (existsSync(plan.targetPath)) {
    if (!isVerifiedRollout(plan.targetPath)) {
      throw new Error('Target Codex account already has a different rollout for this thread')
    }
    return
  }
  const temporaryPath = path.join(
    path.dirname(plan.targetPath),
    `.${path.basename(plan.targetPath)}.${randomUUID()}.nodeterm-link`
  )
  link(plan.sourcePath, temporaryPath)
  const createdTemporary = lstatSync(temporaryPath)
  const temporaryStillOurs = (): boolean => {
    try {
      const currentTemporary = lstatSync(temporaryPath)
      return (
        currentTemporary.dev === createdTemporary.dev &&
        currentTemporary.ino === createdTemporary.ino
      )
    } catch {
      return false
    }
  }
  // The inode our own publish link(2) created at `plan.targetPath`, if it succeeded. Used to roll
  // that link back on a later failure — but ONLY while the target still names that exact inode, so
  // a legitimate entry a concurrent process raced into the pathname AFTER us is never deleted.
  let publishedTarget: { dev: number; ino: number } | null = null
  const publishedTargetStillOurs = (): boolean => {
    if (!publishedTarget) return false
    try {
      const currentTarget = lstatSync(plan.targetPath)
      return currentTarget.dev === publishedTarget.dev && currentTarget.ino === publishedTarget.ino
    } catch {
      return false
    }
  }
  try {
    if (!isVerifiedRollout(temporaryPath)) {
      throw new Error('Temporary Codex rollout did not preserve the verified source inode')
    }
    try {
      // link(2) is no-overwrite. Publishing from the verified private name prevents cleanup from
      // ever deleting an unrelated entry raced into the final pathname.
      link(temporaryPath, plan.targetPath)
      // We created this exact entry: remember its inode so a post-link failure can undo it.
      const created = lstatSync(plan.targetPath)
      publishedTarget = { dev: created.dev, ino: created.ino }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !isVerifiedRollout(plan.targetPath))
        throw error
      // EEXIST + verified ⇒ idempotent re-expose; the target was NOT created by us, never rolled back.
    }
    if (!isVerifiedRollout(plan.targetPath)) {
      throw new Error('Target Codex rollout did not preserve the verified source inode')
    }
  } catch (error) {
    // Roll back a target THIS call published so a failed commit leaves the target as it was found
    // (nothing published). Guarded to our own inode: an idempotent EEXIST match or a foreign entry
    // raced in after us is left untouched.
    if (publishedTargetStillOurs()) {
      try {
        unlinkSync(plan.targetPath)
      } catch {}
    }
    throw error
  } finally {
    // The private pathname may itself have been replaced. Delete it only while it still names the
    // exact inode created by our link(2), even when a source race made that inode invalid.
    if (temporaryStillOurs()) {
      try {
        unlinkSync(temporaryPath)
      } catch {}
    }
  }
}
