// Generates the managed hook script installed into an agent's own config.
// It sources the endpoint file for the LIVE port/token (restart handoff), no-ops
// outside nodeterm-spawned sessions (gating via NODETERM_NODE_ID), and posts the
// raw hook payload to the loopback server. Fails open at every step.
//
// Endpoint failover: a session's env points at ONE
// endpoint file ($NODETERM_HOOK_ENDPOINT). A Mac-spawned remote session points at the
// reverse-tunnel endpoint the Mac's RemoteHooks wrote; when the Mac is offline that pipe
// is dead and the POST fails silently, so the session goes dark — even when the SAME host
// runs an always-on headless Server Edition whose endpoint file is alive right next to it.
// So the request POST captures curl's exit status and, on failure, walks the OTHER known endpoint
// files (the SSH reverse-tunnel endpoints `~/.nodeterm/hook-endpoint-*.env` + the server-edition
// dataDir + the desktop userData dirs), sourcing each one's sock/port/token, until one POST
// succeeds. The happy path (primary alive) is unchanged — curl succeeds, no candidate scan, no
// re-POST. A host with no candidate files behaves exactly as before (nothing posts).
//
// FALLBACK ORDERING AND BOUND — both were wrong, and the failure was total.
// v1 picked ONE candidate, the freshest by mtime, and retried exactly once. Measured on a live
// host with the Mac closed and 8 agents running:
//     hook-endpoint-project-mrkigsjp-4.env  13:25  the primary — excluded as already tried
//     hook-endpoint-project-msq9marh-4.env  12:52  another project's tunnel to the SAME Mac, dead
//     .nodeterm-server/hook-endpoint.env    00:26  the host's own Server Edition — ALIVE
// The single retry landed on the dead sibling and gave up; the live local endpoint was never
// tried, and that host's mirror held 0 nodes and 0 events while 8 sessions worked. Two fixes:
//   1. ORDER BY FAILURE DOMAIN, NOT BY MTIME. Every `hook-endpoint-*.env` tunnel on a host
//      terminates at the SAME desktop, so they share one fate — mtime ranks a dead sibling above a
//      listening local server, and the more projects a host has, the deeper the live endpoint is
//      buried. A LOCAL endpoint (the host's own Server Edition, then a desktop installed on this
//      host) is written by a process running HERE and fails independently, so locals go first;
//      tunnels follow, freshest-first among themselves (the live project's endpoint is rewritten
//      and VERIFIED on every connect, so mtime is a good tie-break WITHIN that group). The cost of
//      being wrong is asymmetric: preferring a local when a sibling tunnel was in fact alive still
//      delivers the event (the local instance pushes it) and only loses the desktop's own badge;
//      preferring tunnels when they are all dead loses the event entirely.
//   2. TRY SEVERAL, BUT BOUND IT (`nt_fallback_max`, 3). One retry cannot get past even a single
//      stale sibling. The bound is what keeps the cure from being its own outage: a dead
//      reverse-tunnel socket is not cheap to fail — sshd ACCEPTS the connection and then never
//      answers, so each attempt can burn the full `--max-time 1.5`. 3 is chosen against the
//      candidate list, not picked round: at most 3 local slots exist and the two desktop userData
//      paths are per-OS (mutually exclusive), so a real host has at most 2 locals — 3 attempts
//      therefore always reaches a live local endpoint AND still leaves at least one tunnel slot,
//      while capping the added latency at ~4.5s on a path that has already failed.
// A single-desktop host — one project, one tunnel, no Server Edition — is untouched: the only
// candidate is the tried one, the list comes back empty, and nothing else runs.
//
// Stale-project self-heal (the glob candidate): a remote session's `NODETERM_HOOK_ENDPOINT` is
// baked into its tmux session at CREATION (`new-session -A -e …`, which tmux ignores when the
// session already exists), and the path carries the PROJECT id:
// `~/.nodeterm/hook-endpoint-<projectId>.env`. Node ids (= tmux session names) deliberately
// survive a project-id change — a re-added folder, a cross-lineage `.nodeterm/project.json`
// adoption — but the endpoint file of the OLD project id is then never rewritten again, so those
// long-lived sessions post into a file pointing at a dead tunnel forever while freshly created
// nodes work. Without the glob the candidate list held only host-LOCAL nodeterm installs, so a
// pure SSH host (no nodeterm of its own) had no self-heal at all: permanent "active but idle".
// The glob makes the live project's endpoint — rewritten and VERIFIED on every connect, hence the
// freshest — a valid fallback. Sending one project's node over another project's socket is
// correct: both tunnels terminate at the SAME hook server, and the node id in the body is what
// identifies the session.
//
// Empty-endpoint self-heal: a session spawned when NO endpoint file existed yet (a phone injects
// NODETERM_NODE_ID + NODETERM_HOOK_ENDPOINT="$NT_EP" where $NT_EP resolved empty on a bare host)
// carries a node id but no token. The gate below keys on the NODE ID, not the token, so such a
// session still reaches nt_send_request — whose failover sources a live sibling endpoint (a Server
// Edition installed later, right next to it) and posts under it. Gating on the token instead would
// exit before that failover ran, leaving the session dark until it was recreated.
//
// Deterministic hook-reply approvals (docs/hook-reply-approvals.md): when
// NODETERM_PERM_WAIT_SECS is set (> 0) in the session env AND the incoming hook is a
// PermissionRequest, the script generates a pendingId, drops the request JSON under
// ~/.nodeterm/pending/, tags the POST body with nodeterm_pending_id (so the mirror/inbox
// learns it), then polls for ~/.nodeterm/pending/<pendingId>.answer for up to that many
// seconds. An answer ('allow' | 'deny') is echoed back as the hook's decision JSON; a
// timeout prints nothing and Claude falls through to its normal interactive prompt. On a valid
// answer it ALSO fires a second, backgrounded "answered" POST (nodeterm_answered=<decision>) so the
// NEEDS YOU badge flips to working immediately rather than lingering until the agent's next hook. The
// whole branch is a NO-OP when the env var is absent (a user's own terminals, older
// nodeterm, non-claude agents), so behavior is bit-for-bit legacy there.
/**
 * `identityRoot` is where the Codex thread → node records live (`codexThreadIdentityRoot()`).
 * It is a PARAMETER because this builder is also called from tests that never boot a platform,
 * and because the prelude has to bake the path in — the shell it runs in has no idea where the
 * app's data dir is. Undefined (no platform yet) ⇒ no prelude, i.e. today's script exactly.
 *
 * The prelude is prepended for EVERY agent, not just codex. It is inert without `CODEX_THREAD_ID`,
 * which no other agent's tool shell sets, and one builder beats a codex-only fork of it.
 */
import { codexThreadIdentityResolverSh } from '../../codex-thread-identity-sh'
import { codexThreadIdentityRoot } from '../../codex-identity-proxy'
import { HOOK_CURL_HEADERS_SH } from '../hook-curl-config-sh'
import { NODE_TOKEN_READ_SH } from '../node-token-sh'
import { HOOK_ENDPOINT_FALLBACK_SH } from '../hook-endpoint-failover-sh'

/**
 * Bumped by hand whenever this script's CONTRACT with the server changes. Not a git sha and not a
 * date: the server COMPARES it (`>= MIN_TOKEN_AWARE_REVISION`), and a sha does not order.
 *
 * WHY THIS EXISTS AT ALL. Before it, an old script and a current script whose token file happened to
 * be missing were byte-identical on the wire: both POST `version=2` (that field is sourced from the
 * ENDPOINT FILE, so it reports the server's protocol version, never the client's) and neither sends
 * an X-Nodeterm-Node-Token header. The server therefore could not distinguish "this session cannot
 * read a token" from "there is no token to read" — and those need OPPOSITE advice. Messaging's gate
 * 2 would have told an SSH-only host's session to retry after its next turn, forever.
 *
 * Two stale windows this makes visible, and they are ONE mechanism:
 *   - LOCAL: none in practice. install-helper.ts rewrites the script unconditionally at every boot
 *     of both shells, so a host running nodeterm is current as of its last start.
 *   - REMOTE: real. remote-hooks.ts writes it only inside RemoteHooks.setup(), which runs on
 *     CONNECT. An already-connected project keeps the script it was given, so its remote nodes —
 *     and any session the PHONE spawns on that host, which runs the host's installed script — stay
 *     `legacy` until the project reconnects.
 */
export const MANAGED_SCRIPT_REVISION = 4
/** The first revision that reads NODETERM_NODE_TOKEN_DIR and sends the node token (PR #195). */
export const MIN_TOKEN_AWARE_REVISION = 3
/* rev 4 (issue #384): the token read moved to the shared resolver in `node-token-sh.ts`, which
 * falls back to the standard token dirs when the endpoint file advertises none. The floor stays 3
 * on purpose — rev 3 CAN read a token, which is the only question `MIN_TOKEN_AWARE_REVISION`
 * answers; calling it stale would tell a working session to reconnect for nothing. */

function safeIdentityRoot(): string | null {
  try {
    return codexThreadIdentityRoot()
  } catch {
    return null
  }
}

export function buildManagedScript(
  agentId: string,
  identityRoot: string | null = safeIdentityRoot()
): string {
  return [
    '#!/bin/sh',
    ...(identityRoot ? [codexThreadIdentityResolverSh(identityRoot)] : []),
    '# GATE FIRST, and drain stdin before bailing (issues #186/#187). Order is load-bearing twice:',
    '#  - The codex thread-identity prelude above may DERIVE the node id (and endpoint) from its',
    '#    thread id, so the gate cannot move above it — but nothing below needs to run for a',
    '#    non-nodeterm session, and',
    '#    sourcing the endpoint file before the gate executed foreign-env file contents in sessions',
    '#    this script promises a "bit-for-bit legacy no-op" for (#186).',
    '#  - The drain: claude writes the hook payload into our stdin, and PreToolUse/PostToolUse bodies',
    '#    exceed one 64KB pipe buffer on any large Read or diff. A bail that exits without reading',
    '#    EPIPEs the writer mid-payload (#187) — silent, because we still exit 0. The installed',
    '#    missing-script fallback in settings.json already drains (`else cat >/dev/null`); this makes',
    '#    the script\'s own bail path keep the same promise.',
    '# Gate on the NODE ID only — it is what marks a nodeterm-spawned session (a user\'s own',
    '# terminal has neither var and exits here, bit-for-bit legacy no-op). The token is NOT',
    '# required at this point: a phone-spawned session whose endpoint was empty/dead at spawn',
    '# (NODETERM_HOOK_ENDPOINT="" because no host process existed yet) carries a node id but no',
    '# token, and nt_send_request below sources a live sibling endpoint (e.g. a headless Server',
    '# Edition that came up AFTER the session) to heal it. Gating on the token here instead would',
    '# exit before that failover ever ran, leaving such a session dark until it was recreated.',
    'if [ -z "$NODETERM_NODE_ID" ]; then',
    '  cat >/dev/null 2>&1 || :',
    '  exit 0',
    'fi',
    '# Sourced with stdout swallowed, not only stderr: SessionStart and UserPromptSubmit are two of',
    '# the events where Claude ADDS hook stdout to the agent\'s context (#186). The endpoint files',
    '# nodeterm writes print nothing today — this guards the day one of the four candidate paths',
    '# grows a stray echo or an unsilenced warning, which would otherwise be injected into every',
    '# prompt silently.',
    'if [ -n "$NODETERM_HOOK_ENDPOINT" ] && [ -r "$NODETERM_HOOK_ENDPOINT" ]; then',
    '  . "$NODETERM_HOOK_ENDPOINT" >/dev/null 2>&1 || :',
    'fi',
    '# THIS SCRIPT\'s revision, stamped on every POST (X-Nodeterm-Hook-Client) so the server can tell',
    '# a session running a pre-identity script from one whose token file is merely missing — they',
    '# used to be byte-identical on the wire, because the `version` field below comes from the',
    '# ENDPOINT FILE and therefore reports the SERVER\'s protocol version, never the client\'s.',
    '# Deliberately set HERE, outside nt_pick_fallback\'s clearing block: sock/port/token-dir belong',
    '# to whichever endpoint we adopt, but the revision is a property of this file on this disk.',
    '# (The failover SOURCES the endpoint file it adopts, so a file carrying an nt_client_rev line',
    '# would overwrite this. Not defended against and not worth defending: every candidate is a',
    '# 0600 file under our own $HOME, so writing one already means being us — at which point the',
    '# script itself is editable. Noted so the next reader does not have to re-derive it.)',
    `nt_client_rev=${MANAGED_SCRIPT_REVISION}`,
    '# The PER-NODE capability. The endpoint file (v2) advertises the directory; the token itself is',
    '# one file in it named for THIS node id — a lookup by name, never a scan, so a session can only',
    '# ever present its own. Absent (pre-v2 endpoint, pre-upgrade session, remote write that failed)',
    '# leaves it EMPTY, and an empty header is exactly what the server reads as `legacy`: the POST',
    '# still happens and nothing about it fails. Kept in a function because the failover below has to',
    '# RE-read it against the dir of the endpoint it adopted — which is why the resolver takes that',
    '# endpoint as an argument (see node-token-sh.ts, and issue #384 for the population its',
    '# fallbacks exist for: an endpoint file that is still LIVE but advertises no dir at all).',
    NODE_TOKEN_READ_SH,
    'nt_read_node_token',
    HOOK_CURL_HEADERS_SH,
    // Report the effective Claude process env, including env from --settings. Always send
    // an empty value too: removing an override must invalidate a prior observation.
    ...(agentId === 'claude'
      ? [
          'nt_context_window="$CLAUDE_CODE_MAX_CONTEXT_TOKENS"',
          'case "$nt_context_window" in *[!0-9]*) nt_context_window="" ;; esac',
          '[ "${#nt_context_window}" -le 16 ] || nt_context_window=""'
        ]
      : ['nt_context_window=""']),
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    '# Keep the payload OFF curl\'s argv. `--data-urlencode "payload=$payload"` puts the full hook',
    '# body (Edit/Write tool_input, the submitted prompt, the last assistant message) into',
    '# /proc/<pid>/cmdline — world-readable by every co-tenant for the life of each curl, the exact',
    '# leak the headers already avoid via --config. It also caps the event at the kernel argv limit',
    '# (~128KB on Linux): a large PreToolUse/PostToolUse body makes curl\'s execve fail E2BIG and the',
    '# event is dropped SILENTLY (a lost Stop leaves the node stuck RUNNING). A 0600 temp file read',
    '# back with `payload@file` fixes both; it is deleted by whichever POST last reads it (below).',
    'nt_payload_file="$HOME/.nodeterm/pending/payload-$$.tmp"',
    '(umask 077; mkdir -p "$HOME/.nodeterm/pending") 2>/dev/null || :',
    '(umask 077; printf %s "$payload" > "$nt_payload_file") 2>/dev/null || :',
    '# ...but hand curl a path IT can open. Under Git Bash / MSYS this script runs in a POSIX shell',
    '# while `curl` is a NATIVE Windows binary (System32, or the one shipped with git), so `$HOME`',
    '# expands to `/c/Users/<user>` and curl answers `Failed to open /c/...`. MSYS argument',
    '# translation does not save it: the value is embedded after `payload@`, which its heuristic',
    '# does not rewrite. Every hook POST failed that way on Windows — silently, since a hook must',
    '# never break the agent — so no node ever reported and every session showed Unknown.',
    '#',
    '# Gated on what the SHELL reports it is, not merely on cygpath being present. `command -v',
    '# cygpath` alone is a name check: a WSL or Linux box with anything called cygpath on PATH would',
    '# convert a path its own POSIX curl could already open, breaking a case that works today.',
    '# `uname -s` answers MINGW*/MSYS* under Git Bash and MSYS2 — the one environment where the',
    '# shell is POSIX and curl is not — and Linux/Darwin everywhere else. It is read from the',
    '# environment itself rather than inherited, so it still holds when a caller replaces the env',
    '# (which is exactly what the hook tests in this repo do). CYGWIN* is deliberately outside the',
    '# gate: Cygwin ships its own curl, and that one takes POSIX paths.',
    'nt_payload_arg="$nt_payload_file"',
    'case "$(uname -s 2>/dev/null)" in',
    '  MINGW*|MSYS*)',
    '    if command -v cygpath >/dev/null 2>&1; then',
    '      nt_payload_arg=$(cygpath -w "$nt_payload_file" 2>/dev/null) || nt_payload_arg="$nt_payload_file"',
    '      [ -n "$nt_payload_arg" ] || nt_payload_arg="$nt_payload_file"',
    '    fi',
    '    ;;',
    'esac',
    '# Deterministic-approval request: only for a PermissionRequest hook while the wait is armed.',
    '# `nt_pending` stays empty otherwise, so the POST tag and the poll loop below are both inert.',
    'nt_pending=""',
    'nt_pending_file=""',
    // CLAUDE-ONLY, at BUILD time — not env-gated (issue #409). The old assumption was "non-claude
    // agents never see NODETERM_PERM_WAIT_SECS", but the var rides the CLAUDE node's session env
    // (default-on hookReplyApprovals) and env is INHERITED: a codex launched from inside a claude
    // node's shell — or any nested process — carries it. Codex renders its approval dialog only
    // AFTER the PermissionRequest hook exits (measured, codex-cli 0.149.1), so the inherited wait
    // held every codex approval for the full 45s, posted the ask under the WRONG (claude) node id,
    // and on an answer printed claude's decision JSON into codex's own decision contract — which
    // docs/hook-reply-approvals.md explicitly says is unverified. Emitting the arm only into
    // claude's script kills all three for every other agent, whatever the inherited env says;
    // claude's script stays byte-identical. tmux sessions outlive the app with their spawn-time
    // env, which is why "hookReplyApprovals: false" did not stop the field report — the fix must
    // not depend on the env at all.
    ...(agentId === 'claude'
      ? [
          'if [ -n "$NODETERM_PERM_WAIT_SECS" ] && [ "$NODETERM_PERM_WAIT_SECS" -gt 0 ] 2>/dev/null; then',
          '  case "$payload" in',
          '    *\'"hook_event_name":"PermissionRequest"\'*|*\'"hook_event_name": "PermissionRequest"\'*)',
          '      nt_node=$(printf %s "$NODETERM_NODE_ID" | tr -c \'A-Za-z0-9_-\' \'_\')',
          '      nt_ms=$(date +%s%3N 2>/dev/null)',
          '      case "$nt_ms" in \'\'|*[!0-9]*) nt_ms=$(date +%s) ;; esac',
          '      nt_pending="${nt_node}-${nt_ms}-$$"',
          '      nt_dir="$HOME/.nodeterm/pending"',
          '      (umask 077; mkdir -p "$nt_dir") 2>/dev/null || :',
          '      nt_pending_file="$nt_dir/$nt_pending.json"',
          '      (umask 077; printf %s "$payload" > "$nt_pending_file") 2>/dev/null || :',
          '      ;;',
          '  esac',
          'fi'
        ]
      : [
          '# Hook-reply approvals are claude-only; this script never arms the wait, even when the',
          '# session env inherited NODETERM_PERM_WAIT_SECS from a claude node (issue #409).'
        ]),
    // The candidate walk + adopt helpers are SHARED with the canvas-control and context-link
    // shims (hook-endpoint-failover-sh.ts) — issue #445: the shims never learned this walk, so
    // the same stale endpoint a hook event healed itself around stopped every canvas-control
    // verb cold. One definition, three clients; the "Fallback ordering and bound" reasoning in
    // the header comment above still governs it.
    HOOK_ENDPOINT_FALLBACK_SH,
    '# One request POST against the CURRENT endpoint vars. Returns curl\'s exit status so the',
    '# caller can fail over; returns 1 when there is no transport at all (unset/unreadable',
    '# endpoint) so that case also tries a fallback.',
    'nt_request_post() {',
    '  if [ -n "$NODETERM_HOOK_SOCK" ]; then',
    // The pipeline\'s exit status IS curl\'s (POSIX: the status of a pipeline is its last command),
    // which is what nt_send_request below reads to decide whether to fail over.
    '    nt_code=$(nt_hook_headers |',
    `    curl -sS -o /dev/null -w '%{http_code}' -X POST --unix-socket "$NODETERM_HOOK_SOCK" "http://localhost/hook/${agentId}" \\`,
    '      --connect-timeout 0.5 --max-time 1.5 --config - \\',
    '      -H "Content-Type: application/x-www-form-urlencoded" \\',
    '      --data-urlencode "nodeId=${NODETERM_NODE_ID}" \\',
    '      --data-urlencode "version=${NODETERM_HOOK_VERSION}" \\',
    '      --data-urlencode "nodeterm_context_window=${nt_context_window}" \\',
    '      --data-urlencode "nodeterm_pending_id=${nt_pending}" \\',
    '      --data-urlencode "payload@${nt_payload_arg}" 2>/dev/null) || return 1',
    '  elif [ -n "$NODETERM_HOOK_PORT" ]; then',
    '    nt_code=$(nt_hook_headers |',
    `    curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:\${NODETERM_HOOK_PORT}/hook/${agentId}" \\`,
    '      --connect-timeout 0.5 --max-time 1.5 --config - \\',
    '      -H "Content-Type: application/x-www-form-urlencoded" \\',
    '      --data-urlencode "nodeId=${NODETERM_NODE_ID}" \\',
    '      --data-urlencode "version=${NODETERM_HOOK_VERSION}" \\',
    '      --data-urlencode "nodeterm_context_window=${nt_context_window}" \\',
    '      --data-urlencode "nodeterm_pending_id=${nt_pending}" \\',
    '      --data-urlencode "payload@${nt_payload_arg}" 2>/dev/null) || return 1',
    '  else',
    '    return 1',
    '  fi',
    '  [ "$nt_code" != "421" ]',
    '}',
    '# Request POST with a BOUNDED fallback walk. On a failed primary POST, try the OTHER endpoint',
    '# files in most-likely-alive order (nt_candidates) — at most $nt_fallback_max of them — and stop',
    '# at the first POST that succeeds. So a session whose primary endpoint is dead (offline Mac',
    '# reverse-tunnel) still reaches an alive server (e.g. the headless Server Edition) sitting right',
    '# next to it, EVEN when several equally-dead sibling tunnels are listed ahead of it by mtime —',
    '# which is what a single freshest-only retry could never get past. In the perm-wait branch this',
    '# also carries nodeterm_pending_id to whichever endpoint answers, so the phone/canvas still',
    '# learns the ask.',
    '# The happy path is untouched: `&& return 0` means a successful primary POST runs no glob, no',
    '# subshell and no second curl, exactly as before.',
    'nt_send_request() {',
    '  nt_request_post && return 0',
    '  nt_list=$(nt_candidates "$NODETERM_HOOK_ENDPOINT")',
    '  [ -n "$nt_list" ] || return 1',
    '  # Split the list on NEWLINES only, so a candidate path containing spaces survives (the macOS',
    '  # "Application Support" entry already has one). `set -f` for the same span, so a path with a',
    '  # glob character in it is not re-expanded by the unquoted $nt_list.',
    '  nt_ifs="$IFS"',
    '  set -f',
    '  IFS="\n"',
    '  set -- $nt_list',
    '  set +f',
    '  IFS="$nt_ifs"',
    '  nt_n=0',
    '  for nt_ep in "$@"; do',
    '    nt_n=$((nt_n + 1))',
    '    [ "$nt_n" -le "$nt_fallback_max" ] || break',
    '    nt_adopt "$nt_ep" || continue',
    '    # The token is re-read HERE, per candidate, not once at the top: it must come from the dir',
    '    # the endpoint we just adopted advertises. Reusing the primary\'s (or the previous',
    '    # candidate\'s) would send our kid to a server that cannot judge it — harmless, but also',
    '    # pointless, and it would hide a real identity behind a legacy. The adopted path is passed',
    '    # in for the same reason: when that endpoint advertises no dir, the fallback must derive',
    '    # from ITS directory, never from the one we are walking away from.',
    '    nt_read_node_token "$nt_ep"',
    '    nt_request_post && return 0',
    '  done',
    '  return 1',
    '}',
    '# Advertise status (+ pendingId in the perm-wait branch). In the perm-wait branch this runs in',
    '# the FOREGROUND so the ask reaches the (primary or fallback) server before the answer-file poll',
    '# begins — and any fallback it sources persists for the "answered" POST below, which then targets',
    '# the same live endpoint. Otherwise it is backgrounded so a live session\'s hot path never blocks',
    '# on the network (fire-and-forget, exactly as before).',
    'if [ -n "$nt_pending" ]; then',
    '  nt_send_request',
    'else',
    '  # Background the POST (a live session\'s hot path never blocks) and delete the payload temp',
    '  # file only AFTER it — and its one fallback retry — have finished reading it, so the file',
    '  # never outlives its reader. The perm-wait branch keeps the file for its "answered" POST.',
    '  { nt_send_request; rm -f "$nt_payload_file" 2>/dev/null || :; } &',
    'fi',
    // The poll/decision section below is claude-only at BUILD time, like the arm above: with
    // nt_pending permanently empty it was already unreachable in other agents' scripts, but
    // keeping claude's decision JSON inside codex.sh is exactly the kind of latent cross-dialect
    // output issue #409 was about — strip it so nothing in a non-claude script can ever print a
    // decision.
    ...(agentId === 'claude'
      ? [
    '# Hold the hook open for a phone/canvas answer file, polling every 0.5s up to the armed seconds.',
    'if [ -n "$nt_pending" ]; then',
    '  nt_answer="$HOME/.nodeterm/pending/$nt_pending.answer"',
    '  nt_max=$((NODETERM_PERM_WAIT_SECS * 2))',
    '  nt_i=0',
    '  while [ "$nt_i" -lt "$nt_max" ]; do',
    '    if [ -f "$nt_answer" ]; then',
    '      nt_decision=$(cat "$nt_answer" 2>/dev/null)',
    '      rm -f "$nt_answer" "$nt_pending_file" 2>/dev/null || :',
    '      # Fire-and-forget "answered" signal so the canvas/phone NEEDS YOU badge flips to working the',
    '      # instant we read a valid answer, instead of sticking until the agent\'s next hook (which,',
    '      # for a text-only reply, is not until the turn\'s Stop). Backgrounded (&) + short --max-time so',
    '      # the decision JSON below is NEVER delayed. Same POST mechanism as above, tagged',
    '      # nodeterm_answered=<decision>; only for a valid allow/deny (no POST on a bad/timed-out answer).',
    '      # The payload temp file is still needed here (the foreground nt_send_request above read',
    '      # it, and this backgrounded "answered" POST reads it again). Whichever backgrounded POST',
    '      # is launched self-deletes it after curl returns; if none is (no transport, or a decision',
    '      # that is neither allow nor deny), it is deleted inline just below.',
    '      nt_payload_owned=0',
    '      if [ "$nt_decision" = "allow" ] || [ "$nt_decision" = "deny" ]; then',
    '        if [ -n "$NODETERM_HOOK_SOCK" ]; then',
    '          { nt_hook_headers |',
    `          curl -sS -X POST --unix-socket "$NODETERM_HOOK_SOCK" "http://localhost/hook/${agentId}" \\`,
    '            --connect-timeout 0.5 --max-time 1 --config - \\',
    '            -H "Content-Type: application/x-www-form-urlencoded" \\',
    '            --data-urlencode "nodeId=${NODETERM_NODE_ID}" \\',
    '            --data-urlencode "version=${NODETERM_HOOK_VERSION}" \\',
    '            --data-urlencode "nodeterm_context_window=${nt_context_window}" \\',
    '            --data-urlencode "nodeterm_pending_id=${nt_pending}" \\',
    '            --data-urlencode "nodeterm_answered=${nt_decision}" \\',
    '            --data-urlencode "payload@${nt_payload_arg}" >/dev/null 2>&1; rm -f "$nt_payload_file" 2>/dev/null || :; } &',
    '          nt_payload_owned=1',
    '        elif [ -n "$NODETERM_HOOK_PORT" ]; then',
    '          { nt_hook_headers |',
    `          curl -sS -X POST "http://127.0.0.1:\${NODETERM_HOOK_PORT}/hook/${agentId}" \\`,
    '            --connect-timeout 0.5 --max-time 1 --config - \\',
    '            -H "Content-Type: application/x-www-form-urlencoded" \\',
    '            --data-urlencode "nodeId=${NODETERM_NODE_ID}" \\',
    '            --data-urlencode "version=${NODETERM_HOOK_VERSION}" \\',
    '            --data-urlencode "nodeterm_context_window=${nt_context_window}" \\',
    '            --data-urlencode "nodeterm_pending_id=${nt_pending}" \\',
    '            --data-urlencode "nodeterm_answered=${nt_decision}" \\',
    '            --data-urlencode "payload@${nt_payload_arg}" >/dev/null 2>&1; rm -f "$nt_payload_file" 2>/dev/null || :; } &',
    '          nt_payload_owned=1',
    '        fi',
    '      fi',
    '      if [ "$nt_payload_owned" != 1 ]; then rm -f "$nt_payload_file" 2>/dev/null || :; fi',
    '      if [ "$nt_decision" = "allow" ]; then',
    '        printf \'%s\\n\' \'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\'',
    '      elif [ "$nt_decision" = "deny" ]; then',
    '        printf \'%s\\n\' \'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from nodeterm."}}}\'',
    '      fi',
    '      exit 0',
    '    fi',
    '    sleep 0.5 2>/dev/null || sleep 1',
    '    nt_i=$((nt_i + 1))',
    '  done',
    '  # Timed out: clean up the request + payload files and print nothing → Claude shows its normal prompt.',
    '  rm -f "$nt_pending_file" "$nt_payload_file" 2>/dev/null || :',
    'fi'
        ]
      : []),
    'exit 0',
    ''
  ].join('\n')
}
