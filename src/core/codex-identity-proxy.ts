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
 * ACCOUNT SCOPING is deliberately absent here: managed Codex accounts are a later slice. The
 * storage shape is one file per thread id; scoping adds a directory level above it without
 * changing anything this file promises.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import path from 'path'
import { createHmac, timingSafeEqual } from 'crypto'
import { platform } from './platform'

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

function identitySignature(threadId: string, nodeId: string, hookEndpoint: string): string {
  if (!identityAuthSecret) throw new Error('NodeTerm Codex identity authentication is unavailable')
  return createHmac('sha256', identityAuthSecret)
    .update(`${threadId}\0${nodeId}\0${hookEndpoint}`)
    .digest('base64url')
}

function signatureMatches(threadId: string, identity: CodexThreadIdentity): boolean {
  if (!identity.signature || !identityAuthSecret) return false
  let expected = ''
  try {
    expected = identitySignature(threadId, identity.nodeId, identity.hookEndpoint)
  } catch {
    return false
  }
  const actual = Buffer.from(identity.signature)
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

export interface CodexThreadIdentity {
  nodeId: string
  hookEndpoint: string
  signature: string
}

export function validCodexIdentity(nodeId: string, hookEndpoint: string): boolean {
  return SAFE_NODE_ID.test(nodeId) && SAFE_ENDPOINT.test(hookEndpoint)
}

function identityFile(threadId: string, root = codexThreadIdentityRoot()): string {
  if (!isSafeThreadId(threadId)) throw new Error('Invalid NodeTerm Codex thread identity')
  return path.join(root, threadId)
}

function parseCodexThreadIdentity(raw: string): CodexThreadIdentity {
  const values: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const separator = line.indexOf('=')
    if (separator < 1) continue
    values[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return {
    nodeId: values.nodeId ?? '',
    hookEndpoint: values.endpoint ?? '',
    signature: values.signature ?? ''
  }
}

/** The record for a thread, or undefined when it is absent, malformed or badly signed. */
export function readCodexThreadIdentity(
  threadId: string,
  root = codexThreadIdentityRoot()
): CodexThreadIdentity | undefined {
  if (!isSafeThreadId(threadId)) return undefined
  let raw: string
  try {
    raw = readFileSync(path.join(root, threadId), 'utf8')
  } catch {
    return undefined
  }
  const identity = parseCodexThreadIdentity(raw)
  if (!validCodexIdentity(identity.nodeId, identity.hookEndpoint)) return undefined
  if (!signatureMatches(threadId, identity)) return undefined
  return identity
}

/**
 * Recover a thread's owning node after the app restarts. tmux sessions outlive the app, so a
 * running Codex client can outlive every in-memory map we hold; the file is the only thing that
 * still knows which node it belongs to.
 */
export function resolveCodexThreadNodeIdentity(
  threadId: string,
  root = codexThreadIdentityRoot()
): string | undefined {
  return readCodexThreadIdentity(threadId, root)?.nodeId
}

/** Write (or replace) the record for `threadId`, atomically. */
export function writeCodexThreadIdentity(
  threadId: string,
  nodeId: string,
  hookEndpoint: string,
  root = codexThreadIdentityRoot()
): void {
  if (!isSafeThreadId(threadId) || !validCodexIdentity(nodeId, hookEndpoint)) {
    throw new Error('Invalid NodeTerm Codex thread identity')
  }
  const signature = identitySignature(threadId, nodeId, hookEndpoint)
  const file = identityFile(threadId, root)
  const tmp = path.join(root, `.${threadId}.${process.pid}.${Date.now()}`)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  let renamed = false
  try {
    writeFileSync(tmp, `nodeId=${nodeId}\nendpoint=${hookEndpoint}\nsignature=${signature}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(tmp, file)
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
  root = codexThreadIdentityRoot()
): void {
  if (!isSafeThreadId(threadId) || !validCodexIdentity(nodeId, hookEndpoint)) {
    throw new Error('Invalid NodeTerm Codex thread identity')
  }
  const existing = readCodexThreadIdentity(threadId, root)
  if (existing && existing.nodeId !== nodeId && isNodeLive(existing.nodeId)) {
    throw new Error('Codex thread is already bound to another live node')
  }
  if (existing && existing.nodeId === nodeId && existing.hookEndpoint === hookEndpoint) return
  writeCodexThreadIdentity(threadId, nodeId, hookEndpoint, root)
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
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const threadId of entries) {
    if (!isSafeThreadId(threadId)) continue
    // Reads through the signature check, so a record we do not trust is also one we do not delete.
    if (readCodexThreadIdentity(threadId, root)?.nodeId !== nodeId) continue
    try {
      unlinkSync(path.join(root, threadId))
    } catch {
      /* nothing to forget */
    }
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
 * EVERY failure path here ends in `exec codex "$@"` — the caller's arguments untouched. That is
 * the owner's decision and it follows the repo's own precedent (`gatePermissionMode`: an unknown
 * or failed probe degrades to the bare command, never to a blocked launch). The upstream version
 * of this script exited 69 "identity unavailable", which turns a missing app-server, an older
 * `codex`, a stale tmux session or a locked-down `$HOME` into a DEAD node.
 *
 * The fallback is not silent: before exec'ing plain codex the script POSTs `/codex-thread/fallback`
 * with a machine-readable reason, and the desktop marks the node. Nothing is ever written into the
 * pane — text injected into an agent's terminal is prompt injection, which this repo forbids.
 *
 * `appServerStartCommand` is injected so the test suite can run this script for real under
 * `/bin/sh` (the discipline `canvas-control-shim.test.ts` and `remote-claude-usage.test.ts` set).
 */
export function buildCodexLauncherScript(
  appServerStartCommand = 'codex app-server daemon start >/dev/null 2>&1'
): string {
  return `#!/bin/sh
# Generated by NodeTerm. Do not edit — it is rewritten on every launch.
# Runs a Codex session against the ONE shared app-server, bound to this canvas node's thread.
# Anything missing => plain 'codex' with the same arguments. A node that cannot get a managed
# identity must still be a working node.

nt_reason=''
nt_node_token=''
nt_fail() { nt_reason=$1; return 1; }

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
  if ${appServerStartCommand}; then
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
      "http://localhost:\${NODETERM_HOOK_PORT-0}/codex-thread/bind" >/dev/null; then
    exec codex --remote unix:// "$@"
  fi
  nt_report_fallback thread-bind-refused
  exec codex "$@"
fi

nt_thread=$(nt_post ${CODEX_THREAD_START_CLIENT_MAX_S} --data-urlencode "nodeId=$NODETERM_NODE_ID" --data-urlencode "cwd=$PWD" \\
  "http://localhost:\${NODETERM_HOOK_PORT-0}/codex-thread/start") || nt_thread=''
nt_thread=$(printf %s "$nt_thread" | tr -d '\\r\\n')
case "$nt_thread" in
  ''|*[!A-Za-z0-9._-]*)
    nt_report_fallback thread-start-failed
    exec codex "$@"
    ;;
esac
exec codex --remote unix:// resume "$nt_thread" "$@"
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
