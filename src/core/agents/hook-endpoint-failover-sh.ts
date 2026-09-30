/**
 * ENDPOINT FAILOVER, THE SH HALF — one candidate walk, every generated client.
 *
 * A session is pinned for life to the endpoint PATH it was handed at tmux creation
 * (`buildPtyEnv` / `remoteHookEnvArgs`): tmux ignores `-e` on an existing session, and the env of
 * a live shell cannot be rewritten from outside. So every generated sh client ultimately trusts
 * one file on disk, and that file can go stale in ways the session cannot see:
 *
 *  - the app quit or crashed and the file still advertises its old random port (issue #445 — a
 *    `nodeterm.sh open-agent` from a live worktree session died with "endpoint unreachable"
 *    while the reviewer launch it carried was silently dropped);
 *  - the path carries a project id that a cross-lineage adoption retired, so the file is never
 *    rewritten again while the session keeps posting into it (the managed script's stale-project
 *    case);
 *  - the session was spawned before any endpoint file existed at all (phone spawn on a bare
 *    host).
 *
 * The managed hook script grew this walk first (see the "Fallback ordering and bound" block in
 * `hooks/managed-script.ts` for the measured reasoning behind the ordering and the bound); the
 * canvas-control and context-link shims did not, so the SAME stale file that a hook event healed
 * itself around stopped every canvas-control verb cold — the exact asymmetry issue #384 already
 * documented for the token read, one layer up. The helpers live here now, like
 * `node-token-sh.ts`, because a rule with three copies is a rule where one copy is wrong
 * (this repo's own drift lesson, three times over).
 *
 * What the fragment defines:
 *  - `nt_fallback_max` — how many candidates may be tried AFTER the primary failed;
 *  - `nt_candidates <tried>` — the candidate endpoint files, one per line, most-likely-alive
 *    first (locals before reverse tunnels — they fail independently; tunnels share one fate);
 *  - `nt_adopt <file>` — source one candidate, clearing SOCK/PORT/TOKEN_DIR first so a dead
 *    transport or a foreign token dir never leaks from one candidate into the next.
 *
 * Callers own the retry loop itself (the managed script's `nt_send_request`, each shim's walk):
 * the POST shape differs per client, the walk does not. After `nt_adopt`, re-read the token with
 * `nt_read_node_token "$candidate"` (node-token-sh.ts) — the capability must come from the dir
 * the adopted endpoint advertises, never from the one being walked away from.
 *
 * Hook events retain the legacy failover policy: foreign node tokens classify as legacy on the
 * receiver. That is NOT sufficient routing evidence for control/context requests: a foreign
 * instance can answer an unsupported-edition or unknown-node refusal before a live owning tunnel
 * is reached. Those clients use OWNED_ENDPOINT_FALLBACK_SH below to retain a known capability.
 */
/**
 * The line both shims append under their generic transport-failure sentence when a transport WAS
 * advertised and nothing — primary or fallback — answered. It names the actual state (a stale
 * endpoint, not a broken canvas link) and the one action that works, so an agent reading it stops
 * relinking/restarting things that were never the problem. Shared for the same reason as the walk:
 * two copies of one diagnosis drift into two diagnoses.
 */
export const STALE_ENDPOINT_HINT =
  'The endpoint this session was handed appears stale (nodeterm may have quit or restarted since this terminal was created), and no live fallback endpoint answered. If nodeterm is running, retry once — it re-advertises the endpoint on start.'

export const HOOK_ENDPOINT_FALLBACK_SH = [
  '# --- Endpoint failover helpers (shared: managed hook script + both sh shims) ---------------',
  // How many endpoints we may POST to AFTER the primary failed. See the "Fallback ordering and
  // bound" block comment above buildManagedScript for the full reasoning; the short version:
  // the ordered list is (at most 3) LOCAL endpoints followed by the reverse tunnels, only one or
  // two locals can exist on a real host (the two desktop userData paths are per-OS and mutually
  // exclusive), so 3 attempts always reaches a live local endpoint AND still leaves a tunnel slot.
  // The cost ceiling is what bounds it: each dead attempt can burn --max-time 1.5s, because an
  // sshd-held reverse-tunnel socket ACCEPTS and then never answers.
  'nt_fallback_max=3',
  '# Print the candidate endpoint files, ONE PER LINE, most-likely-alive first, skipping the',
  '# already-tried path ($1) and anything unreadable. Ordering, and why it is not mtime:',
  "#  1. LOCAL endpoints — the host's own Server Edition, then a desktop installed on this host.",
  '#     They are written by a process running HERE, a different failure domain from the tunnels.',
  '#  2. The per-project SSH reverse tunnels, freshest first (the old whole-list rule, kept as the',
  "#     tie-break within this group, because the live project's endpoint is rewritten and VERIFIED",
  '#     on every connect).',
  '# The tunnels all terminate at the SAME desktop, so they share one fate: when the primary tunnel',
  '# is dead (closed laptop) its siblings are almost always dead too, and mtime happily ranks those',
  '# siblings above a local endpoint that is actually listening. That is the whole bug — a host with',
  '# an always-on Server Edition sat silent while every one of its agents ran.',
  'nt_candidates() {',
  '  nt_tried="$1"',
  '  for nt_c in \\',
  '    "$HOME/.nodeterm-server/hook-endpoint.env" \\',
  '    "$HOME/.config/node-terminal/hook-endpoint.env" \\',
  '    "$HOME/Library/Application Support/node-terminal/hook-endpoint.env"; do',
  '    [ "$nt_c" = "$nt_tried" ] && continue',
  '    [ -r "$nt_c" ] || continue',
  "    printf '%s\\n' \"$nt_c\"",
  '  done',
  '  set --',
  // Unquoted glob (with $HOME itself still quoted): the per-project SSH reverse-tunnel
  // endpoints. On no match the pattern stays literal and the `-r` test below drops it.
  '  for nt_c in "$HOME"/.nodeterm/hook-endpoint-*.env; do',
  '    [ "$nt_c" = "$nt_tried" ] && continue',
  '    [ -r "$nt_c" ] || continue',
  '    set -- "$@" "$nt_c"',
  '  done',
  '  [ "$#" -gt 0 ] || return 0',
  '  ls -t "$@" 2>/dev/null',
  '}',
  '# Adopt one candidate endpoint file ($1): source it into NODETERM_HOOK_{SOCK,PORT,TOKEN,VERSION}',
  '# + NODETERM_NODE_TOKEN_DIR. Returns 0 if it was sourced, else 1.',
  '# SOCK/PORT are cleared first so a primary-vs-fallback transport switch (e.g. dead SOCK →',
  '# live PORT) never leaves the stale transport winning in the re-POST below — and, now that we',
  "# may walk several candidates, so one candidate's transport never leaks into the next one.",
  '# NODE_TOKEN_DIR is cleared for the same reason and one more: our token belongs to the instance',
  "# that MINTED it, so carrying our dir into someone else's endpoint would point the read at a",
  '# directory that server cannot verify. Cleared, the newly sourced file sets its own — we then',
  "# present THAT instance's token for this node, or (if it has none) nothing at all, which is",
  '# honest `legacy`.',
  'nt_adopt() {',
  '  NODETERM_HOOK_SOCK=""',
  '  NODETERM_HOOK_PORT=""',
  '  NODETERM_HOOK_TOKEN=""',
  '  NODETERM_NODE_TOKEN_DIR=""',
  // stdout swallowed for the same reason as the endpoint source at the top of every client (#186):
  // in the managed script's perm-wait branch this runs in the FOREGROUND of a hook whose stdout
  // reaches the agent's context.
  '  . "$1" >/dev/null 2>&1 || return 1',
  '  return 0',
  '}'
].join('\n')


/** Control/context requests must retain a known node identity across endpoint discovery.
 * Hook event failover deliberately keeps its existing policy. This is client-side ROUTING, not
 * authorization and not proof of ownership: the receiving server still checks every bearer, node
 * and verb. What a token match shows is only that the candidate reads its token for this node from
 * the same place, with the same content, as the endpoint this session was born on. On an SSH host
 * that place is shared per unix account (`remote-hooks.ts`, KNOWN LIMITATION: two desktops driving
 * the same account overwrite each other's files), so it narrows the walk to "the same family of
 * endpoints", which is what keeps an unrelated local Server Edition from answering for a desktop
 * node; it does not tell two such desktops apart.
 *
 * Runs at the point it is spliced in, while the endpoint vars are still the PRIMARY's (both shims
 * place it after the primary endpoint file is sourced and before the first POST).
 *
 *  - THE OWNER TOKEN is read from the primary's own dir only — the one it advertises, else
 *    `<dir of the endpoint file>/node-tokens` — never from the global search `nt_read_node_token`
 *    walks. That search exists to PRESENT a capability (issue #384) and is kept for that; as an
 *    ownership reference it let a Server Edition that opened the same project.json (same node ids)
 *    supply the "owner's" token whenever the desktop's own token write had failed, and then pass
 *    the owner check against itself.
 *  - OWNER MODE needs that dir to EXIST. With a token there, a candidate must hold the same value
 *    in its own dir. With NONE there (the desktop's token write failed), a value proves nothing — a
 *    Server Edition that never heard of this node holds nothing either, and "" === "" adopted it —
 *    so the candidate's token dir must be the SAME real directory (`pwd -P`, so an adjacent-derived
 *    or symlinked spelling still matches): sibling tunnels and a restarted desktop share it, an
 *    unrelated instance does not. No such dir at all (a session with no endpoint file, a pre-token
 *    layout) is the only unknown-owner case, and keeps the legacy walk: adopt, re-read.
 *  - A FALLBACK candidate is probed before it is posted to (`nt_probe_endpoint`). The real POST has
 *    no --max-time on purpose — a confirm-gated verb waits for a human, and a client-side timeout
 *    would fail over mid-wait and let a second instance raise a second dialog — but a reverse-
 *    tunnel socket whose sshd outlived the desktop's connection (the Mac asleep) ACCEPTS and never
 *    answers, so posting straight into one hung the call. The primary is never probed: its POST is
 *    the question, and its genuine answer, however slow, stays final.
 *  - A skipped candidate leaves no endpoint behind (`nt_restore_endpoint`): the vars go back to
 *    the last endpoint this node could use, which is what the codex-sandbox hint names as the
 *    socket to allow. */
export const OWNED_ENDPOINT_FALLBACK_SH = `
# nt_token_dir_of <endpoint-file>: print the REAL path (pwd -P) of the token dir the CURRENTLY
# SOURCED endpoint keeps — the one it advertises, else the one beside its file. Fails (status 1) when
# neither names an existing directory: the unknown-owner case. Never the global dirs (see above).
nt_token_dir_of() {
  nt_otd="$NODETERM_NODE_TOKEN_DIR"
  [ -n "$nt_otd" ] || nt_otd=$(nt_token_dir_beside "$1")
  [ -n "$nt_otd" ] && [ -d "$nt_otd" ] || return 1
  (cd "$nt_otd" 2>/dev/null && pwd -P)
}
nt_owner_known=""
nt_owner_dir=""
nt_owner_node_token=""
nt_skipped_foreign_endpoint=""
if nt_owner_dir=$(nt_token_dir_of "$NODETERM_HOOK_ENDPOINT"); then
  nt_owner_known=1
  nt_owner_node_token=$(head -n 1 "$nt_owner_dir/$NODETERM_NODE_ID" 2>/dev/null) || nt_owner_node_token=""
fi
# An SSH project's reverse-tunnel endpoint: the only files the desktop writes under ~/.nodeterm.
# Decides which advice a dead transport gets (TUNNEL_DOWN_HINT vs STALE_ENDPOINT_HINT).
nt_primary_tunnel=""
case "$NODETERM_HOOK_ENDPOINT" in
  "$HOME"/.nodeterm/hook-endpoint.env|"$HOME"/.nodeterm/hook-endpoint-*.env) nt_primary_tunnel=1 ;;
esac

nt_restore_endpoint() {
  NODETERM_HOOK_SOCK="$nt_prev_sock"
  NODETERM_HOOK_PORT="$nt_prev_port"
  NODETERM_HOOK_TOKEN="$nt_prev_token"
  NODETERM_NODE_TOKEN_DIR="$nt_prev_dir"
  nt_node_token="$nt_prev_node_token"
}

nt_adopt_for_node() {
  nt_prev_sock="$NODETERM_HOOK_SOCK"
  nt_prev_port="$NODETERM_HOOK_PORT"
  nt_prev_token="$NODETERM_HOOK_TOKEN"
  nt_prev_dir="$NODETERM_NODE_TOKEN_DIR"
  nt_prev_node_token="$nt_node_token"
  if ! nt_adopt "$1"; then
    nt_restore_endpoint
    return 1
  fi
  if [ -z "$nt_owner_known" ]; then
    nt_read_node_token "$1"
    return 0
  fi
  nt_cand_dir=$(nt_token_dir_of "$1") || nt_cand_dir=""
  if [ -n "$nt_owner_node_token" ]; then
    # A reference VALUE: the candidate's own dir must hold the same capability for this node.
    nt_cand_token=""
    if [ -n "$nt_cand_dir" ]; then
      nt_cand_token=$(head -n 1 "$nt_cand_dir/$NODETERM_NODE_ID" 2>/dev/null) || nt_cand_token=""
    fi
    if [ "$nt_cand_token" = "$nt_owner_node_token" ]; then
      nt_node_token="$nt_cand_token"
      return 0
    fi
  elif [ -n "$nt_cand_dir" ] && [ "$nt_cand_dir" = "$nt_owner_dir" ]; then
    # An EMPTY reference proves nothing by value — a Server Edition that never heard of this node
    # holds nothing too. Compare WHERE the tokens are kept: the same real directory is the same
    # family of endpoints (sibling tunnels, a restarted desktop), and it holds nothing to present.
    nt_node_token=""
    return 0
  fi
  nt_skipped_foreign_endpoint=1
  nt_restore_endpoint
  return 1
}

# Bounded liveness probe for an ADOPTED fallback candidate. /hook/verify answers 204 on the bearer
# alone on every server build (the desktop's own tunnel probe used it before /verify existed, and
# the server keeps it answering for that reason) and 421 for a bearer it does not own. On failure
# nt_code is set as the POST would have left it (421, or 000 for a dead transport), and the reply
# body lands in $nt_out exactly where the POST's would have, so the final diagnosis reads the same
# (a 421 into /dev/null once left the control shim exiting 1 with an empty stderr). The candidate
# stays adopted, since it is this node's own endpoint.
nt_probe_endpoint() {
  nt_pc=""
  if [ -n "$NODETERM_HOOK_SOCK" ]; then
    nt_pc=$(nt_hook_headers |
      curl -s -o "$nt_out" -w '%{http_code}' -X POST --config - --connect-timeout 0.5 --max-time 1.5 --unix-socket "$NODETERM_HOOK_SOCK" "http://localhost/hook/verify" --data '' 2>/dev/null)
  elif [ -n "$NODETERM_HOOK_PORT" ]; then
    nt_pc=$(nt_hook_headers |
      curl -s -o "$nt_out" -w '%{http_code}' -X POST --config - --connect-timeout 0.5 --max-time 1.5 "http://127.0.0.1:$NODETERM_HOOK_PORT/hook/verify" --data '' 2>/dev/null)
  else
    nt_code=""
    return 1
  fi
  nt_had_transport=1
  [ "$nt_pc" = "204" ] && return 0
  if [ "$nt_pc" = "421" ]; then nt_code="421"; else nt_code="000"; fi
  return 1
}
`

/**
 * What the shims print when the walk skipped at least one foreign endpoint and nothing that owns
 * this node answered. Measured on an SSH host (2026-09-28/29): the desktop slept, its reverse
 * tunnel's socket stayed on disk with no listener, and the walk used to reach an unrelated Server
 * Edition whose reply — "permanent on this host … do not retry" — was true about that server and
 * false about this session. An agent that reads a permanent refusal stops for good; the tunnel came
 * back minutes later. So this sentence says the three things that are actually known: the OWNER is
 * unreachable, the other endpoints were not asked, and the state is temporary. The tunnel is named
 * as the usual cause for an SSH project, not asserted: the shim cannot see why a socket is silent.
 *
 * `OWNER_UNREACHABLE_LEAD` is quoted verbatim by the agent-facing bodies (see
 * `ownerUnreachableGuidanceLines`), so the docs and the script cannot drift apart.
 */
export const OWNER_UNREACHABLE_LEAD = 'The nodeterm connection that owns this node is unreachable.'

export const FOREIGN_ENDPOINT_HINT =
  `${OWNER_UNREACHABLE_LEAD} Other nodeterm endpoints on this machine were skipped: they keep a ` +
  'different identity for this node, so their answer would describe a different canvas. This is temporary — for an SSH ' +
  "project it usually means the desktop's reverse tunnel is down (the desktop is asleep, offline or " +
  'reconnecting). Retry the same command after it reconnects.'

/**
 * The same diagnosis when nothing foreign was skipped but the session's primary endpoint is an SSH
 * project's reverse-tunnel file (`~/.nodeterm/hook-endpoint*.env` — the only files the desktop
 * writes under that dir). On that host the stale-endpoint advice ("retry once — it re-advertises the
 * endpoint on start") describes an app restart; what brings a tunnel back is the desktop
 * reconnecting. Starts with OWNER_UNREACHABLE_LEAD, so the agent-facing bodies' quote covers it.
 */
export const TUNNEL_DOWN_HINT =
  `${OWNER_UNREACHABLE_LEAD} This session reaches it through an SSH project's reverse tunnel, and ` +
  'the tunnel is not answering: the desktop is asleep, offline or reconnecting, or nodeterm on it ' +
  'has quit. This is temporary — retry the same command after the desktop reconnects.'

/** The agent-facing half of FOREIGN_ENDPOINT_HINT, rendered into all four bodies (canvas skill +
 *  instructions block, context skill + instructions block). Without it an agent has only the
 *  bodies' other refusal lines to go on, and several of those correctly say "do not retry". */
export function ownerUnreachableGuidanceLines(): string[] {
  return [
    `Owner unreachable: if a call fails with "${OWNER_UNREACHABLE_LEAD.replace(/\.$/, '')}", the`,
    'nodeterm app that owns this session is not answering right now; for an SSH project that usually',
    "means the desktop's reverse tunnel is down (asleep, offline or reconnecting). This is temporary:",
    'retry the same command later rather than giving up.'
  ]
}
