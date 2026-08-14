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
// So the request POST captures curl's exit status and, on failure, retries ONCE against the
// freshest OTHER endpoint file among the known candidates (the SSH reverse-tunnel endpoints
// `~/.nodeterm/hook-endpoint-*.env` + the server-edition dataDir + the desktop userData dirs),
// sourcing its sock/port/token. The happy path (primary alive) is
// unchanged — curl succeeds, no candidate scan, no re-POST. A host with no candidate files
// behaves exactly as before (nothing posts).
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
    'if [ -n "$NODETERM_HOOK_ENDPOINT" ] && [ -r "$NODETERM_HOOK_ENDPOINT" ]; then',
    '  . "$NODETERM_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    '# The PER-NODE capability. The endpoint file (v2) advertises the directory; the token itself is',
    '# one file in it named for THIS node id — a lookup by name, never a scan, so a session can only',
    '# ever present its own. Absent (pre-v2 endpoint, pre-upgrade session, remote write that failed)',
    '# leaves it EMPTY, and an empty header is exactly what the server reads as `legacy`: the POST',
    '# still happens and nothing about it fails. Kept in a function because the failover below has to',
    '# RE-read it against the dir of the endpoint it adopted.',
    'nt_read_node_token() {',
    '  nt_node_token=""',
    '  if [ -n "$NODETERM_NODE_TOKEN_DIR" ] && [ -n "$NODETERM_NODE_ID" ]; then',
    '    nt_node_token=$(head -n 1 "$NODETERM_NODE_TOKEN_DIR/$NODETERM_NODE_ID" 2>/dev/null)',
    '  fi',
    '}',
    'nt_read_node_token',
    HOOK_CURL_HEADERS_SH,
    '# Gate on the NODE ID only — it is what marks a nodeterm-spawned session (a user\'s own',
    '# terminal has neither var and exits here, bit-for-bit legacy no-op). The token is NOT',
    '# required at this point: a phone-spawned session whose endpoint was empty/dead at spawn',
    '# (NODETERM_HOOK_ENDPOINT="" because no host process existed yet) carries a node id but no',
    '# token, and nt_send_request below sources a live sibling endpoint (e.g. a headless Server',
    '# Edition that came up AFTER the session) to heal it. Gating on the token here instead would',
    '# exit before that failover ever ran, leaving such a session dark until it was recreated.',
    'if [ -z "$NODETERM_NODE_ID" ]; then',
    '  exit 0',
    'fi',
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    '# Deterministic-approval request: only for a PermissionRequest hook while the wait is armed.',
    '# `nt_pending` stays empty otherwise, so the POST tag and the poll loop below are both inert.',
    'nt_pending=""',
    'nt_pending_file=""',
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
    'fi',
    '# --- Endpoint failover helpers --------------------------------------------------',
    '# Source the freshest EXISTING candidate endpoint file, skipping the already-tried path',
    '# ($1), into NODETERM_HOOK_{SOCK,PORT,TOKEN,VERSION} + NODETERM_NODE_TOKEN_DIR. Returns 0 if one',
    '# was sourced, else 1.',
    '# SOCK/PORT are cleared first so a primary-vs-fallback transport switch (e.g. dead SOCK →',
    '# live PORT) never leaves the stale transport winning in the re-POST below. NODE_TOKEN_DIR is',
    '# cleared for the same reason and one more: our token belongs to the instance that MINTED it, so',
    '# carrying our dir into someone else\'s endpoint would point the read at a directory that server',
    '# cannot verify. Cleared, the newly sourced file sets its own — we then present THAT instance\'s',
    '# token for this node, or (if it has none) nothing at all, which is honest `legacy`.',
    'nt_pick_fallback() {',
    '  nt_tried="$1"',
    '  set --',
    '  for nt_c in \\',
    // Unquoted glob (with $HOME itself still quoted): the per-project SSH reverse-tunnel
    // endpoints. On no match the pattern stays literal and the `-r` test below drops it.
    '    "$HOME"/.nodeterm/hook-endpoint-*.env \\',
    '    "$HOME/.nodeterm-server/hook-endpoint.env" \\',
    '    "$HOME/.config/node-terminal/hook-endpoint.env" \\',
    '    "$HOME/Library/Application Support/node-terminal/hook-endpoint.env"; do',
    '    [ "$nt_c" = "$nt_tried" ] && continue',
    '    [ -r "$nt_c" ] || continue',
    '    set -- "$@" "$nt_c"',
    '  done',
    '  [ "$#" -gt 0 ] || return 1',
    '  nt_fresh=$(ls -t "$@" 2>/dev/null | head -n 1)',
    '  [ -n "$nt_fresh" ] && [ -r "$nt_fresh" ] || return 1',
    '  NODETERM_HOOK_SOCK=""',
    '  NODETERM_HOOK_PORT=""',
    '  NODETERM_NODE_TOKEN_DIR=""',
    '  . "$nt_fresh" 2>/dev/null || return 1',
    '  return 0',
    '}',
    '# One request POST against the CURRENT endpoint vars. Returns curl\'s exit status so the',
    '# caller can fail over; returns 1 when there is no transport at all (unset/unreadable',
    '# endpoint) so that case also tries a fallback.',
    'nt_request_post() {',
    '  if [ -n "$NODETERM_HOOK_SOCK" ]; then',
    // The pipeline\'s exit status IS curl\'s (POSIX: the status of a pipeline is its last command),
    // which is what nt_send_request below reads to decide whether to fail over.
    '    nt_hook_headers |',
    `    curl -sS -X POST --unix-socket "$NODETERM_HOOK_SOCK" "http://localhost/hook/${agentId}" \\`,
    '      --connect-timeout 0.5 --max-time 1.5 --config - \\',
    '      -H "Content-Type: application/x-www-form-urlencoded" \\',
    '      --data-urlencode "nodeId=${NODETERM_NODE_ID}" \\',
    '      --data-urlencode "version=${NODETERM_HOOK_VERSION}" \\',
    '      --data-urlencode "nodeterm_pending_id=${nt_pending}" \\',
    '      --data-urlencode "payload=${payload}" >/dev/null 2>&1',
    '  elif [ -n "$NODETERM_HOOK_PORT" ]; then',
    '    nt_hook_headers |',
    `    curl -sS -X POST "http://127.0.0.1:\${NODETERM_HOOK_PORT}/hook/${agentId}" \\`,
    '      --connect-timeout 0.5 --max-time 1.5 --config - \\',
    '      -H "Content-Type: application/x-www-form-urlencoded" \\',
    '      --data-urlencode "nodeId=${NODETERM_NODE_ID}" \\',
    '      --data-urlencode "version=${NODETERM_HOOK_VERSION}" \\',
    '      --data-urlencode "nodeterm_pending_id=${nt_pending}" \\',
    '      --data-urlencode "payload=${payload}" >/dev/null 2>&1',
    '  else',
    '    return 1',
    '  fi',
    '}',
    '# Request POST with a single fallback retry. On a failed primary POST, source the freshest',
    '# OTHER endpoint file (nt_pick_fallback) and re-POST with its sock/port/token — so a session',
    '# whose primary endpoint is dead (offline Mac reverse-tunnel) still reaches an alive server',
    '# (e.g. the headless Server Edition) sitting right next to it. In the perm-wait branch this',
    '# also carries nodeterm_pending_id to the fallback, so the phone/canvas still learns the ask.',
    'nt_send_request() {',
    '  nt_request_post && return 0',
    '  if nt_pick_fallback "$NODETERM_HOOK_ENDPOINT"; then',
    '    # The token is re-read HERE, not once at the top: it must come from the dir the endpoint we',
    '    # just adopted advertises. Reusing the primary\'s would send our kid to a server that cannot',
    '    # judge it — harmless, but also pointless, and it would hide a real identity behind a legacy.',
    '    nt_read_node_token',
    '    nt_request_post',
    '  fi',
    '}',
    '# Advertise status (+ pendingId in the perm-wait branch). In the perm-wait branch this runs in',
    '# the FOREGROUND so the ask reaches the (primary or fallback) server before the answer-file poll',
    '# begins — and any fallback it sources persists for the "answered" POST below, which then targets',
    '# the same live endpoint. Otherwise it is backgrounded so a live session\'s hot path never blocks',
    '# on the network (fire-and-forget, exactly as before).',
    'if [ -n "$nt_pending" ]; then',
    '  nt_send_request',
    'else',
    '  nt_send_request &',
    'fi',
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
    '      if [ "$nt_decision" = "allow" ] || [ "$nt_decision" = "deny" ]; then',
    '        if [ -n "$NODETERM_HOOK_SOCK" ]; then',
    '          nt_hook_headers |',
    `          curl -sS -X POST --unix-socket "$NODETERM_HOOK_SOCK" "http://localhost/hook/${agentId}" \\`,
    '            --connect-timeout 0.5 --max-time 1 --config - \\',
    '            -H "Content-Type: application/x-www-form-urlencoded" \\',
    '            --data-urlencode "nodeId=${NODETERM_NODE_ID}" \\',
    '            --data-urlencode "version=${NODETERM_HOOK_VERSION}" \\',
    '            --data-urlencode "nodeterm_pending_id=${nt_pending}" \\',
    '            --data-urlencode "nodeterm_answered=${nt_decision}" \\',
    '            --data-urlencode "payload=${payload}" >/dev/null 2>&1 &',
    '        elif [ -n "$NODETERM_HOOK_PORT" ]; then',
    '          nt_hook_headers |',
    `          curl -sS -X POST "http://127.0.0.1:\${NODETERM_HOOK_PORT}/hook/${agentId}" \\`,
    '            --connect-timeout 0.5 --max-time 1 --config - \\',
    '            -H "Content-Type: application/x-www-form-urlencoded" \\',
    '            --data-urlencode "nodeId=${NODETERM_NODE_ID}" \\',
    '            --data-urlencode "version=${NODETERM_HOOK_VERSION}" \\',
    '            --data-urlencode "nodeterm_pending_id=${nt_pending}" \\',
    '            --data-urlencode "nodeterm_answered=${nt_decision}" \\',
    '            --data-urlencode "payload=${payload}" >/dev/null 2>&1 &',
    '        fi',
    '      fi',
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
    '  # Timed out: clean up the request file and print nothing → Claude shows its normal prompt.',
    '  rm -f "$nt_pending_file" 2>/dev/null || :',
    'fi',
    'exit 0',
    ''
  ].join('\n')
}
