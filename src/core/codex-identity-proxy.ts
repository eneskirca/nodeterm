/**
 * Shared-identity spine for Codex canvas nodes.
 *
 * WHY: a Codex terminal node used to spawn a full `codex` process tree per node — one app-server
 * each. A canvas with a dozen Codex nodes paid a dozen servers' worth of RAM for one account. With
 * this, every node on a machine talks to ONE `codex app-server` and owns one THREAD inside it, and
 * the node ↔ thread mapping is what survives resumes, in-pane restarts and app restarts.
 *
 * The mapping is a tiny file per thread under `<userDataDir>/codex-thread-nodes/`. It is read by
 * generated POSIX sh (the hook prelude in `codex-thread-identity-sh.ts`), so it is a flat
 * `key=value` text file — parsed as DATA, never sourced.
 *
 * WHY IT IS SIGNED: the records name a node id and a hook endpoint, and the hook prelude
 * re-exports both into the agent's environment. An attacker who could write one of these files
 * could aim a session's hook traffic at a node (or an endpoint) of their choosing. Every record
 * therefore carries an HMAC over (threadId, nodeId, endpoint) keyed by the same restart-stable
 * secret the hook server uses to mint per-node capabilities
 * (`src/core/agents/node-auth-secret.ts` — sealed via safeStorage on the desktop, raw 0600 bytes on
 * the Server Edition). Unsigned/mis-signed records are ignored, not repaired.
 *
 * ACCOUNT SCOPING (S6): managed Codex accounts add a directory level above the thread id. A
 * SYSTEM record still lives at the bare root (`<root>/<threadId>`), so a machine with no managed
 * accounts keeps the exact S4 layout and its legacy records keep resolving (Constraint 12). A
 * MANAGED record lives under `<root>/<accountId>/<threadId>`. The HMAC now binds the full 4-tuple
 * (threadId, accountScope, nodeId, hookEndpoint) — an empty account id is normalised to the scope
 * string `system`, and a record whose `accountId=` line disagrees with the directory it sits in is
 * rejected, so an account can never be edited to speak for another's threads. Records written
 * before this slice carry no `accountId=` line and are verified with the original 3-tuple preimage
 * at the system scope only — the one back-compat door, and it is a system-scope door.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import path from 'path'
import { createHmac, timingSafeEqual } from 'crypto'
import { renameAtomicSync } from './fs-atomic'
import { platform } from './platform'
import { ACCOUNT_ID_RE, isSafeAccountId } from '../shared/codex-account'

/**
 * The scope string for the SYSTEM account (`~/.codex`, no managed id). Empty/undefined account ids
 * normalise to this both in the HMAC preimage and — for the directory — to the bare record root.
 */
export const SYSTEM_ACCOUNT_SCOPE = 'system'

/**
 * The one shape of a safe managed account id, re-exported from the shared seam so there is a single
 * definition of the alphabet the path builders and this proxy both trust. Must start alphanumeric,
 * which blocks `.`/`..`/leading-separator ids at the door before an id becomes a directory scope.
 */
export const SAFE_ACCOUNT_ID = ACCOUNT_ID_RE

/**
 * The scope string for an account id: `system` for empty/undefined, else the validated id itself.
 * THROWS on an id that could escape the mapping directory (`..`, `a/b`, `/abs`, whitespace) — the
 * supply-chain guard, since account ids arrive from hand-editable `settings.json` / `project.json`.
 * A literal id of `system` is refused so the reserved bare-root scope can never be impersonated by
 * a managed subdirectory.
 */
export function accountScope(accountId?: string): string {
  if (!accountId) return SYSTEM_ACCOUNT_SCOPE
  if (accountId === SYSTEM_ACCOUNT_SCOPE || !isSafeAccountId(accountId)) {
    throw new Error('Invalid NodeTerm Codex account scope')
  }
  return accountId
}

/**
 * How long the SERVER gives itself to mint a thread (`startCodexThreadAt`'s default).
 *
 * The launcher's own curl budget is derived from this and is deliberately LARGER
 * (`CODEX_THREAD_START_CLIENT_MAX_S`), so the server is always the side that gives up first.
 * Get that ordering backwards and a slow app-server produces the worst outcome available: curl
 * quits, the launcher falls back to plain codex, and the server carries on to create a thread and
 * write a record for it that nothing will ever resume.
 */
export const CODEX_THREAD_START_TIMEOUT_MS = 20_000
const CODEX_THREAD_START_CLIENT_MAX_S = CODEX_THREAD_START_TIMEOUT_MS / 1000 + 10

const SAFE_NODE_ID = /^[A-Za-z0-9._-]+$/
const SAFE_ENDPOINT = /^\/[A-Za-z0-9._/ -]+$/
const THREAD_ID_CHARSET = /^[A-Za-z0-9._-]+$/
const MAX_THREAD_ID = 128

/**
 * The one predicate for a thread id — the twin of `isSafeNodeId` (core/agents/node-auth-token.ts),
 * for the same reason and against the same trap.
 *
 * The charset alone is NOT enough: `.` and `..` both MATCH `THREAD_ID_CHARSET`, and a thread id is
 * a PATH SEGMENT under `codexThreadIdentityRoot()` (`<root>/<threadId>`, plus the `.<threadId>.…`
 * tmp file beside it) as well as a signed field in the record. A `..` there resolves to the record
 * dir's PARENT. The id is caller-supplied — it arrives on `/codex-thread/bind` as a form field and
 * from a node's persisted state — so refuse `.` and `..` by name, refuse empty, refuse
 * over-length, BEFORE the id ever reaches a path join or a hash.
 *
 * Exported and shared deliberately: the hook routes and `codex-session-name.ts` used to carry
 * their own copies of the bare charset, and two copies of a rule is how one of them stays wrong.
 */
export function isSafeThreadId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_THREAD_ID &&
    id !== '.' &&
    id !== '..' &&
    THREAD_ID_CHARSET.test(id)
  )
}

let identityAuthSecret: Buffer | null = null

/** Injected by the shell once, from the same keychain-backed secret the hook server signs with. */
export function setCodexThreadIdentityAuthSecret(secret: Uint8Array): void {
  if (secret.byteLength < 32) throw new Error('Invalid NodeTerm Codex identity-auth secret')
  identityAuthSecret = Buffer.from(secret)
}

/** Test-only: forget the injected secret so a suite can assert the unavailable path. */
export function resetCodexThreadIdentityAuthSecret(): void {
  identityAuthSecret = null
}

export function codexThreadIdentityAvailable(): boolean {
  return !!identityAuthSecret
}

/**
 * Where the thread → node records live. Through `CorePlatform`, NOT `homedir()`: this is state the
 * app owns, and the Server Edition's data dir is not `~`. The generated sh gets this exact path
 * baked in (quoted), so the two never disagree.
 */
export function codexThreadIdentityRoot(): string {
  return path.join(platform().userDataDir, 'codex-thread-nodes')
}

/**
 * The current 4-tuple preimage: HMAC-SHA256(threadId ␀ accountScope ␀ nodeId ␀ hookEndpoint). The
 * account scope binds the record to ONE account; without it a record for account A could be moved,
 * byte-for-byte, into account B's directory and still verify.
 */
function identitySignature(
  threadId: string,
  scope: string,
  nodeId: string,
  hookEndpoint: string
): string {
  if (!identityAuthSecret) throw new Error('NodeTerm Codex identity authentication is unavailable')
  return createHmac('sha256', identityAuthSecret)
    .update(`${threadId}\0${scope}\0${nodeId}\0${hookEndpoint}`)
    .digest('base64url')
}

/**
 * The pre-S6 3-tuple preimage (no account dimension). Accepted ONLY for a system-scope record that
 * carries no `accountId=` line — i.e. one written before this slice. Every record this slice writes
 * (system included) carries the account line and the 4-tuple, so the legacy door is system-only and
 * closes itself the first time a machine rewrites the record.
 */
function legacyIdentitySignature(threadId: string, nodeId: string, hookEndpoint: string): string {
  if (!identityAuthSecret) throw new Error('NodeTerm Codex identity authentication is unavailable')
  return createHmac('sha256', identityAuthSecret)
    .update(`${threadId}\0${nodeId}\0${hookEndpoint}`)
    .digest('base64url')
}

function signatureEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Verify a parsed record sitting in the `dirScope` directory (Property 7). Two checks, in order:
 *  1. the record's own `accountId=` line must AGREE with the directory it was found in, and
 *  2. the HMAC must match — the 4-tuple for any record with an account line, with a system-only
 *     3-tuple fallback for a legacy record that has no line at all.
 *
 * Check (1) (line-vs-directory) is defence in depth, kept legible rather than removed. What carries
 * Property 7 is the SCOPE-bound HMAC in check (2): a record signed for `acct-A` verifies only with
 * the preimage scope `acct-A`, so re-filing it under `acct-B` fails the MAC regardless of the line
 * check. The legacy 3-tuple fallback is the ONE back-compat door and is restricted to the SYSTEM
 * scope, so a scope-less signature can never be honoured under a managed account. (The mutations
 * that redden these tests are the HMAC one and the `scope === SYSTEM_ACCOUNT_SCOPE` fallback guard;
 * check (1) is redundant with the scope-bound HMAC and is documented as such.)
 */
function recordSignatureValid(threadId: string, dirScope: string, record: ParsedRecord): boolean {
  if (!record.signature || !identityAuthSecret) return false
  const scope = dirScope || SYSTEM_ACCOUNT_SCOPE
  if (record.accountLinePresent) {
    const lineScope = record.accountId || SYSTEM_ACCOUNT_SCOPE
    if (lineScope !== scope) return false
  }
  let expected = ''
  try {
    expected = identitySignature(threadId, scope, record.nodeId, record.hookEndpoint)
  } catch {
    return false
  }
  if (signatureEquals(record.signature, expected)) return true
  if (!record.accountLinePresent && scope === SYSTEM_ACCOUNT_SCOPE) {
    try {
      return signatureEquals(
        record.signature,
        legacyIdentitySignature(threadId, record.nodeId, record.hookEndpoint)
      )
    } catch {
      return false
    }
  }
  return false
}

export interface CodexThreadIdentity {
  /** '' for the system account; a managed account id otherwise. */
  accountId: string
  nodeId: string
  hookEndpoint: string
  signature: string
}

interface ParsedRecord extends CodexThreadIdentity {
  accountLinePresent: boolean
}

export function validCodexIdentity(nodeId: string, hookEndpoint: string): boolean {
  return SAFE_NODE_ID.test(nodeId) && SAFE_ENDPOINT.test(hookEndpoint)
}

/** The absolute path of a record for a thread under a scope (`system` ⇒ bare root). */
function recordFilePath(root: string, scope: string, threadId: string): string {
  return scope && scope !== SYSTEM_ACCOUNT_SCOPE
    ? path.join(root, scope, threadId)
    : path.join(root, threadId)
}

function identityFile(threadId: string, scope: string, root = codexThreadIdentityRoot()): string {
  if (!isSafeThreadId(threadId)) throw new Error('Invalid NodeTerm Codex thread identity')
  return recordFilePath(root, scope, threadId)
}

function parseCodexThreadIdentity(raw: string): ParsedRecord {
  const values: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator)
    // First occurrence wins, matching the `head -n 1` the sh prelude uses: a second `accountId=`
    // line cannot be smuggled in to disagree with the first.
    if (!(key in values)) values[key] = line.slice(separator + 1)
  }
  return {
    accountId: values.accountId ?? '',
    nodeId: values.nodeId ?? '',
    hookEndpoint: values.endpoint ?? '',
    signature: values.signature ?? '',
    accountLinePresent: 'accountId' in values
  }
}

/**
 * Read and verify the record for a thread AT A SPECIFIC SCOPE (`system` = bare root). Returns
 * undefined when it is absent, malformed, badly signed, or its account line disagrees with the
 * directory. The scope itself is validated so a hostile scan entry can never escape the root.
 */
export function readIdentityCandidate(
  threadId: string,
  scope: string,
  root = codexThreadIdentityRoot()
): CodexThreadIdentity | undefined {
  if (!isSafeThreadId(threadId)) return undefined
  const norm = scope || SYSTEM_ACCOUNT_SCOPE
  if (norm !== SYSTEM_ACCOUNT_SCOPE && !isSafeAccountId(norm)) return undefined
  let raw: string
  try {
    raw = readFileSync(recordFilePath(root, norm, threadId), 'utf8')
  } catch {
    return undefined
  }
  const record = parseCodexThreadIdentity(raw)
  if (!validCodexIdentity(record.nodeId, record.hookEndpoint)) return undefined
  if (!recordSignatureValid(threadId, norm, record)) return undefined
  return {
    accountId: record.accountId,
    nodeId: record.nodeId,
    hookEndpoint: record.hookEndpoint,
    signature: record.signature
  }
}

/**
 * Every verified record for a thread, across every scope present on disk: the bare-root system
 * record plus one per managed-account subdirectory. Unsafe scope names are skipped, never read.
 */
export function identityCandidates(
  threadId: string,
  root = codexThreadIdentityRoot()
): Array<{ scope: string; identity: CodexThreadIdentity }> {
  const out: Array<{ scope: string; identity: CodexThreadIdentity }> = []
  const system = readIdentityCandidate(threadId, SYSTEM_ACCOUNT_SCOPE, root)
  if (system) out.push({ scope: SYSTEM_ACCOUNT_SCOPE, identity: system })
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === SYSTEM_ACCOUNT_SCOPE || !isSafeAccountId(entry.name)) continue
    const identity = readIdentityCandidate(threadId, entry.name, root)
    if (identity) out.push({ scope: entry.name, identity })
  }
  return out
}

/** The record for a thread at a scope (`accountId` empty/undefined ⇒ system), or undefined. */
export function readCodexThreadIdentity(
  threadId: string,
  root = codexThreadIdentityRoot(),
  accountId?: string
): CodexThreadIdentity | undefined {
  let scope: string
  try {
    scope = accountScope(accountId)
  } catch {
    return undefined
  }
  return readIdentityCandidate(threadId, scope, root)
}

/**
 * Recover a thread's owning node after the app restarts. tmux sessions outlive the app, so a
 * running Codex client can outlive every in-memory map we hold; the file is the only thing that
 * still knows which node it belongs to.
 *
 * With `accountId` given the answer is that one scope's record. WITHOUT it — the shared-app-server
 * tool shell that only knows a bare thread id — every scope is scanned and an owner is returned
 * ONLY when it is unambiguous (`owners.size === 1`). The same thread id owned by two accounts is
 * NOT resolved: ambiguous ownership fails closed (Property 3), the same posture as an unproven pane
 * claim in `pane-ownership.ts`.
 */
export function resolveCodexThreadNodeIdentity(
  threadId: string,
  root = codexThreadIdentityRoot(),
  accountId?: string
): string | undefined {
  if (accountId !== undefined) {
    return readCodexThreadIdentity(threadId, root, accountId)?.nodeId
  }
  const candidates = identityCandidates(threadId, root)
  const owners = new Set(candidates.map((c) => c.identity.nodeId))
  return owners.size === 1 ? candidates[0].identity.nodeId : undefined
}

/**
 * Whether a thread id is owned by MORE THAN ONE currently-live node across scopes — a genuine
 * ownership conflict the caller must refuse rather than pick a winner for. A single live owner (or
 * none) is not a conflict. Fail-closed twin of the single-live-owner rule in `bindCodexThreadIdentity`.
 */
export function codexThreadIdentityHasLiveConflict(
  threadId: string,
  isNodeLive: (nodeId: string) => boolean,
  root = codexThreadIdentityRoot()
): boolean {
  const liveOwners = new Set(
    identityCandidates(threadId, root)
      .map((c) => c.identity.nodeId)
      .filter(isNodeLive)
  )
  return liveOwners.size > 1
}

/** Write (or replace) the record for `threadId` under its account scope, atomically. */
export function writeCodexThreadIdentity(
  threadId: string,
  nodeId: string,
  hookEndpoint: string,
  root = codexThreadIdentityRoot(),
  accountId?: string
): void {
  if (!isSafeThreadId(threadId) || !validCodexIdentity(nodeId, hookEndpoint)) {
    throw new Error('Invalid NodeTerm Codex thread identity')
  }
  const scope = accountScope(accountId) // throws on an id that could escape the mapping directory
  const signature = identitySignature(threadId, scope, nodeId, hookEndpoint)
  const file = identityFile(threadId, scope, root)
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${threadId}.${process.pid}.${Date.now()}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let renamed = false
  try {
    writeFileSync(
      tmp,
      `accountId=${accountId ?? ''}\nnodeId=${nodeId}\nendpoint=${hookEndpoint}\nsignature=${signature}\n`,
      {
        encoding: 'utf8',
        mode: 0o600
      }
    )
    renameAtomicSync(tmp, file)
    renamed = true
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmp)
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * One canvas node owns one Codex conversation, and one conversation belongs to one node. A resume
 * that would steal a thread from a node that is still LIVE is refused — the caller (the launcher)
 * then falls back to a plain `codex`, which is a working session rather than two clients fighting
 * over one thread. A STALE owner (node deleted, app restarted without it) is simply replaced.
 */
export function bindCodexThreadIdentity(
  threadId: string,
  nodeId: string,
  hookEndpoint: string,
  isNodeLive: (nodeId: string) => boolean,
  root = codexThreadIdentityRoot(),
  accountId?: string
): void {
  if (!isSafeThreadId(threadId) || !validCodexIdentity(nodeId, hookEndpoint)) {
    throw new Error('Invalid NodeTerm Codex thread identity')
  }
  accountScope(accountId) // reject an escaping account id before any read or write
  const existing = readCodexThreadIdentity(threadId, root, accountId)
  if (existing && existing.nodeId !== nodeId && isNodeLive(existing.nodeId)) {
    throw new Error('Codex thread is already bound to another live node')
  }
  if (existing && existing.nodeId === nodeId && existing.hookEndpoint === hookEndpoint) return
  writeCodexThreadIdentity(threadId, nodeId, hookEndpoint, root, accountId)
}

/**
 * Drop every record naming `nodeId`, when that node is permanently deleted.
 *
 * Two reasons this is not just housekeeping. The directory would otherwise grow one file per
 * thread forever, and — worse — a dead node's record keeps re-exporting its node id and hook
 * endpoint into any tool shell that still carries the thread id, so a deleted node's identity
 * outlives it. Keyed by node, not by thread, because the caller (`destroySession`) knows the node
 * id and nothing else; the directory is one flat level, so the scan is a single readdir.
 *
 * Best effort throughout: a record we cannot read or remove must never fail a node deletion.
 */
export function forgetCodexThreadIdentitiesForNode(
  nodeId: string,
  root = codexThreadIdentityRoot()
): void {
  if (!SAFE_NODE_ID.test(nodeId)) return
  const forgetInScope = (scope: string, dir: string): void => {
    let entries: Array<{ name: string; isFile(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue // a managed-scope SUBDIRECTORY at the root is not a thread id
      const threadId = entry.name
      if (!isSafeThreadId(threadId)) continue
      // Reads through the signature check, so a record we do not trust is also one we do not delete.
      if (readIdentityCandidate(threadId, scope, root)?.nodeId !== nodeId) continue
      try {
        unlinkSync(path.join(dir, threadId))
      } catch {
        /* nothing to forget */
      }
    }
  }
  // System records live at the bare root; managed records one directory down, per account scope.
  forgetInScope(SYSTEM_ACCOUNT_SCOPE, root)
  let scopes: Array<{ name: string; isDirectory(): boolean }>
  try {
    scopes = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of scopes) {
    if (!entry.isDirectory()) continue
    if (entry.name === SYSTEM_ACCOUNT_SCOPE || !isSafeAccountId(entry.name)) continue
    forgetInScope(entry.name, path.join(root, entry.name))
  }
}

export function codexLauncherDir(): string {
  return path.join(platform().userDataDir, 'codex-bin')
}

export const CODEX_LAUNCHER_NAME = 'nodeterm-codex'

export function codexLauncherPath(): string {
  return path.join(codexLauncherDir(), CODEX_LAUNCHER_NAME)
}

/**
 * The generated launcher.
 *
 * Every identity-setup failure path here ends in `exec codex "$@"` — the caller's arguments
 * untouched. That is the owner's decision and it follows the repo's own precedent
 * (`gatePermissionMode`: an unknown or failed probe degrades to the bare command, never to a
 * blocked launch). The upstream version of this script exited 69 "identity unavailable", which
 * turns a missing app-server, an older `codex`, a stale tmux session or a locked-down `$HOME` into
 * a DEAD node. Once a shared thread is bound, the launcher remains as its transport supervisor.
 *
 * The fallback is not silent: before exec'ing plain codex the script POSTs `/codex-thread/fallback`
 * with a machine-readable reason, and the desktop marks the node. Nothing is injected into a live
 * agent TUI — text injected into an agent's terminal is prompt injection, which this repo forbids.
 * The supervisor may print a transport status only after the TUI has exited.
 *
 * `appServerStartCommand` and `appServerProbeCommand` are injected so the test suite can run this
 * script for real under `/bin/sh` (the discipline `canvas-control-shim.test.ts` and
 * `remote-claude-usage.test.ts` set).
 */
export function buildCodexLauncherScript(
  appServerStartCommand = 'codex app-server daemon start >/dev/null 2>&1',
  appServerProbeCommand =
    `codex app-server daemon version 2>/dev/null | ` +
    `grep -q '"status"[[:space:]]*:[[:space:]]*"running"'`
): string {
  return `#!/bin/sh
# Generated by NodeTerm. Do not edit — it is rewritten on every launch.
# Runs a Codex session against the ONE shared app-server, bound to this canvas node's thread.
# Anything missing => plain 'codex' with the same arguments. A node that cannot get a managed
# identity must still be a working node.

# Job control, from the top, for the whole script's life — not only inside nt_run_shared.
# Without it every 'codex ... resume' this script runs (the very first launch included, not just a
# post-reset resume) stays in THIS shell's own process group, so the pane's foreground group is the
# supervisor, never the client. Six call sites key off the pane's foreground command
# (agent-restart.ts's exit/resume phases, TerminalNode.tsx's hibernation wake, trigger-delivery.ts's
# shell-owned-pane gate, remote-ssh/agent-resync-decide.ts, pane-process.ts, pty-manager.ts) and every
# one misreads a supervised pane as shell-owned without this. 'set -m' gives the client its own
# process group and hands it the tty's foreground group (tcsetpgrp), restoring the pre-supervisor
# answer — and, as a side effect, keeps a tty SIGINT reaching only the client, which the existing
# 130 case below already assumes. Supported in dash (this script's usual /bin/sh) as well as bash.
set -m

nt_reason=''
nt_node_token=''
nt_fail() { nt_reason=$1; return 1; }

# The app-server is shared by every Codex node in this account scope. Keep ALL lifecycle starts in
# one scrubbed subshell: starting it with a pane's NODETERM_NODE_ID leaks that one node into every
# tool shell the persistent daemon later creates (#350). The account id is deliberately retained —
# one daemon serves one account scope.
nt_start_app_server() (
  unset NODETERM_NODE_ID NODETERM_HOOK_ENDPOINT NODETERM_HOOK_PORT NODETERM_HOOK_TOKEN \
    NODETERM_HOOK_SOCK NODETERM_AGENT_ID NODETERM_CANVAS_CONTROL NODETERM_NODE_TOKEN_DIR \
    NODETERM_PERM_WAIT_SECS
  ${appServerStartCommand}
)

nt_app_server_ready() (
  ${appServerProbeCommand}
)

# A successful remote TUI can still be severed later when the shared daemon is upgraded, repaired,
# or restarted. The Unix socket inode is the daemon generation we can observe without intercepting
# the TUI's terminal streams. A failed read is UNKNOWN, not evidence of a restart; it is useful only
# when a known pre-launch inode changes or the authoritative daemon probe fails.
nt_app_server_generation() (
  nt_socket="\${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock"
  [ -e "$nt_socket" ] || return 1
  ls -di "$nt_socket" 2>/dev/null | awk 'NR == 1 { print $1 }'
)

nt_epoch() {
  date +%s 2>/dev/null || printf '0\\n'
}

# Run a known thread under supervision. Normal exits and terminal signals return unchanged. An
# abnormal exit is resumed ONLY when the daemon probe failed or the known socket generation
# changed; a Codex crash against the same healthy daemon must not become a relaunch loop. The
# caller's prompt/options are one-shot and run only on the first launch — replaying an initial
# prompt after transport recovery would duplicate the user's turn.
nt_run_shared() {
  nt_shared_thread=$1
  shift
  nt_first_launch=1
  nt_rapid_resets=0

  while :; do
    nt_generation_before=$(nt_app_server_generation) || nt_generation_before=''
    nt_run_started=$(nt_epoch)

    if [ "$nt_first_launch" -eq 1 ]; then
      codex --remote unix:// resume "$nt_shared_thread" "$@"
    else
      codex --remote unix:// resume "$nt_shared_thread"
    fi
    nt_status=$?

    case "$nt_status" in
      0|129|130|131|143) return "$nt_status" ;;
    esac

    nt_generation_after=$(nt_app_server_generation) || nt_generation_after=''
    # A restarted daemon that happens to land on the same socket inode while healthy answers "no
    # change" here, so a real reset can go undetected. That is a false NEGATIVE, and it fails safe:
    # the loop simply returns this exit status instead of resuming, the same outcome as if the
    # daemon genuinely had not reset. Left alone deliberately — do not "fix" this into a positive.
    nt_daemon_reset=0
    if ! nt_app_server_ready; then
      nt_daemon_reset=1
    elif [ -n "$nt_generation_before" ] && \
         [ "$nt_generation_before" != "$nt_generation_after" ]; then
      nt_daemon_reset=1
    fi
    [ "$nt_daemon_reset" -eq 1 ] || return "$nt_status"

    nt_run_ended=$(nt_epoch)
    # Not a ceiling on resets overall — any run that lasted >= 10s clears the counter, so a daemon
    # that flaps every 11s resumes forever. This only stops a *rapid* burst (four resets with no
    # run reaching 10s in between).
    if [ "$nt_run_started" -gt 0 ] && [ "$nt_run_ended" -ge "$nt_run_started" ] && \
       [ $((nt_run_ended - nt_run_started)) -ge 10 ]; then
      nt_rapid_resets=0
    fi
    nt_rapid_resets=$((nt_rapid_resets + 1))
    if [ "$nt_rapid_resets" -gt 3 ]; then
      printf '\\nNodeTerm: Codex daemon kept resetting; automatic resume stopped. Run: codex resume %s\\n' \
        "$nt_shared_thread" >&2
      return "$nt_status"
    fi

    printf '\\nNodeTerm: shared Codex connection reset; restoring this session...\\n' >&2
    nt_start_try=0
    while ! nt_app_server_ready; do
      nt_start_app_server || :
      nt_app_server_ready && break
      nt_start_try=$((nt_start_try + 1))
      if [ "$nt_start_try" -ge 3 ]; then
        printf 'NodeTerm: shared Codex daemon did not recover. Run: codex resume %s\\n' \
          "$nt_shared_thread" >&2
        return "$nt_status"
      fi
      sleep "$nt_start_try"
    done
    nt_first_launch=0
  done
}

nt_hook_curl() { curl "$@"; }
if [ -n "\${NODETERM_HOOK_SOCK-}" ]; then
  case "$NODETERM_HOOK_SOCK" in
    /*) nt_hook_curl() { curl --unix-socket "$NODETERM_HOOK_SOCK" "$@"; } ;;
    *) nt_reason=broker-unreachable ;;
  esac
fi

# A path we are willing to source. Written with tr rather than a case bracket class because the
# endpoint lives under the app's data dir, which on macOS contains a space ("Application Support")
# — escaping a space inside a case pattern's bracket expression is exactly the kind of quoting
# that reads fine and matches nothing.
nt_safe_path() {
  case "\${1-}" in /*) ;; *) return 1 ;; esac
  [ "$(printf %s "$1" | tr -cd 'A-Za-z0-9._/ -')" = "$1" ]
}

# Runs in THIS shell, never a command substitution: it sources the endpoint file, and that file is
# what carries the live hook port/token. Sourcing it in a subshell would leave both unset here and
# every launch would "fall back" for the wrong reason.
nt_preflight() {
  case "\${NODETERM_NODE_ID-}" in ''|*[!A-Za-z0-9._-]*) nt_fail node-id-unavailable; return ;; esac
  nt_safe_path "\${NODETERM_HOOK_ENDPOINT-}" || { nt_fail hook-endpoint-unavailable; return; }
  [ -r "$NODETERM_HOOK_ENDPOINT" ] || { nt_fail hook-endpoint-unavailable; return; }
  . "$NODETERM_HOOK_ENDPOINT" 2>/dev/null || { nt_fail broker-unreachable; return; }
  case "\${NODETERM_HOOK_PORT-}" in ''|*[!0-9]*) nt_fail broker-unreachable; return ;; esac
  case "\${NODETERM_HOOK_TOKEN-}" in ''|*[!A-Za-z0-9-]*) nt_fail broker-unreachable; return ;; esac
  # The PER-NODE capability, read the way every other client reads it: the endpoint file (v2,
  # sourced just above) advertises the directory, and the token is one 0600 file in it named for
  # THIS node id — a lookup by name, never a scan, so a session can only ever present its own. It
  # is deliberately NOT an env var any more: that channel put the credential on the tmux \`-e\`
  # argv, world-readable on a stock Linux, and the credential's whole job is to prove WHICH node
  # is calling.
  #
  # There is deliberately NO \$NODETERM_CODEX_NODE_TOKEN fallback. One shipped, for a session the
  # previous build spawned, and it could never have worked: that build's value is the OLD
  # derivation — base64url(HMAC(secret, nodeId)), no dot — which the current verifier reads as a
  # foreign kid, i.e. \`legacy\`, and /codex-thread/{start,bind} demand \`verified\`. So it 403s and
  # the launcher degrades anyway, one round-trip later. A pre-upgrade codex session runs plain
  # codex until it is relaunched; that is the honest behaviour, not a regression from the fallback.
  if [ -n "\${NODETERM_NODE_TOKEN_DIR-}" ]; then
    nt_node_token=$(head -n 1 "$NODETERM_NODE_TOKEN_DIR/$NODETERM_NODE_ID" 2>/dev/null) || nt_node_token=''
  fi
  # The '.' IS the token: the wire shape is kid.mac (one derivation shared with /hook/*). A gate
  # without the dot rejects every token this app mints and degrades every codex node to plain
  # codex — silently, because falling back is what this script is built to do.
  case "$nt_node_token" in
    ''|*[!A-Za-z0-9._-]*) nt_fail node-token-unavailable; return ;;
  esac
  if [ "\${1-}" = resume ]; then
    case "\${2-}" in ''|*[!A-Za-z0-9._-]*) nt_fail thread-id-unavailable; return ;; esac
  fi
  # The account scope (S6). Empty ⇒ the system account. A non-empty id is validated to the SAME
  # shape the record store's accountScope() enforces — must START alphanumeric (so '.'/'..'/leading
  # separators can never become a directory scope) — BEFORE it rides a POST body onward. A bad id
  # falls back to plain codex rather than binding a thread under an attacker-shaped scope; the id
  # travels in the request body, never on argv (Constraint 6).
  case "\${NODETERM_CODEX_ACCOUNT_ID-}" in
    '') ;;
    [!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) nt_fail codex-account-invalid; return ;;
  esac
  # The authoritative check runs FIRST and unchanged; the stat below only decides WHICH reason to
  # report. Ordering it the other way would let a codex that no longer needs the standalone runtime
  # fall back on a stat we had no business trusting more than the command itself.
  #
  # Two different facts wore one name before: an older CLI with no app-server at all, and a current
  # CLI installed off a channel that ships no standalone runtime (npm, snap) — where the daemon
  # refuses with "managed standalone Codex install not found at
  # <CODEX_HOME>/packages/standalone/current/codex". Caps normally keeps that second case away from
  # here entirely, but the pane resolves CODEX_HOME from its OWN environment (§8.5) and an install
  # can be removed after boot, so the launcher still has to be able to say which it hit.
  #
  # A responsive app-server is authoritative even when Codex's PID ownership record has gone stale.
  # Calling the lifecycle start first can reject that harmless orphan and degrade this node to plain
  # codex — or tempt a repair to kill infrastructure shared by every pane. Probe first; start only
  # when the protocol itself is not running. nt_start_app_server owns the environment scrub as well
  # as the later recovery path, so duplicating its unset list here would let one path drift into #350.
  if nt_app_server_ready || nt_start_app_server; then
    return 0
  fi
  if [ -x "\${CODEX_HOME:-$HOME/.codex}/packages/standalone/current/codex" ]; then
    nt_fail app-server-unavailable
  else
    nt_fail codex-standalone-missing
  fi
  return
}

# Best effort, and never fatal: tell the desktop this node is running plain codex, so the UI can
# say so without the user reading a log. Sent WITHOUT the per-node capability on purpose — the
# commonest thing it reports is that there was no capability to present. The server only trusts a
# TOKENLESS report on the node it names (see handleCodexThread), so a session that does hold a
# token cannot use this route to flag a sibling.
nt_report_fallback() {
  [ -n "\${NODETERM_HOOK_PORT-}" ] || return 0
  [ -n "\${NODETERM_HOOK_TOKEN-}" ] || return 0
  [ -n "\${NODETERM_NODE_ID-}" ] || return 0
  printf 'header = "X-NodeTerm-Hook-Token: %s"\\n' "$NODETERM_HOOK_TOKEN" |
    nt_hook_curl --silent --show-error --fail --max-time 3 --config - --request POST \\
      --data-urlencode "nodeId=$NODETERM_NODE_ID" \\
      --data-urlencode "reason=$1" \\
      "http://localhost:\${NODETERM_HOOK_PORT-0}/codex-thread/fallback" >/dev/null 2>&1 || :
}

[ -n "$nt_reason" ] || nt_preflight "$@" || :
if [ -n "$nt_reason" ]; then
  nt_report_fallback "$nt_reason"
  exec codex "$@"
fi

# $1 is the client budget in seconds; the rest is curl's. Start gets a budget LARGER than the
# server's own (CODEX_THREAD_START_TIMEOUT_MS) so the server, not curl, is what times out — a curl
# that quits first leaves behind a thread and a record nothing will ever resume.
nt_post() {
  nt_budget=$1
  shift
  printf 'header = "X-NodeTerm-Hook-Token: %s"\\nheader = "X-NodeTerm-Node-Token: %s"\\n' \\
    "$NODETERM_HOOK_TOKEN" "$nt_node_token" |
    nt_hook_curl --silent --show-error --fail --max-time "$nt_budget" --config - --request POST "$@"
}

if [ "\${1-}" = resume ]; then
  # Claim the caller-supplied thread for THIS node before Codex opens it. A refusal means another
  # live node owns it; two clients on one thread is worse than one plain session, so we fall back.
  if nt_post 20 --data-urlencode "nodeId=$NODETERM_NODE_ID" --data-urlencode "threadId=\${2-}" \\
      --data-urlencode "accountId=\${NODETERM_CODEX_ACCOUNT_ID-}" \\
      "http://localhost:\${NODETERM_HOOK_PORT-0}/codex-thread/bind" >/dev/null; then
    nt_bound_thread=$2
    shift 2
    nt_run_shared "$nt_bound_thread" "$@"
    exit $?
  fi
  nt_report_fallback thread-bind-refused
  exec codex "$@"
fi

nt_thread=$(nt_post ${CODEX_THREAD_START_CLIENT_MAX_S} --data-urlencode "nodeId=$NODETERM_NODE_ID" --data-urlencode "cwd=$PWD" \\
  --data-urlencode "accountId=\${NODETERM_CODEX_ACCOUNT_ID-}" \\
  "http://localhost:\${NODETERM_HOOK_PORT-0}/codex-thread/start") || nt_thread=''
nt_thread=$(printf %s "$nt_thread" | tr -d '\\r\\n')
case "$nt_thread" in
  ''|*[!A-Za-z0-9._-]*)
    nt_report_fallback thread-start-failed
    exec codex "$@"
    ;;
esac
nt_run_shared "$nt_thread" "$@"
exit $?
`
}

/**
 * Write the launcher and return its path, or null when it could not be installed (read-only home,
 * no permission). Null is a first-class answer: it is what makes `codexIdentityCaps()` say "no"
 * and every launch line stay the bare `codex` it has always been.
 */
export function installCodexLauncher(): string | null {
  try {
    const dir = codexLauncherDir()
    const file = path.join(dir, CODEX_LAUNCHER_NAME)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(file, buildCodexLauncherScript(), { encoding: 'utf8', mode: 0o700 })
    chmodSync(file, 0o700)
    return file
  } catch {
    return null
  }
}
