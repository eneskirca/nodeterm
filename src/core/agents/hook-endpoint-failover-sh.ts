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
 * Safety is the same argument as the token resolver's: sending one node's request over another
 * instance's endpoint is correct where it can succeed at all — the node id in the body is what
 * identifies the session, a foreign instance that does not know it refuses with its ordinary
 * answer, and a foreign token dir yields a foreign kid = `legacy`, bit-for-bit what presenting
 * nothing already gave.
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
