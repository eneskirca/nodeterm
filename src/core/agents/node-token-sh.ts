/**
 * THE PER-NODE CAPABILITY, READ — one POSIX-sh resolver, every generated client.
 *
 * Four generated clients present this node's token: the managed hook script, the canvas-control
 * shim (`nodeterm.sh`), the context-link shim (`context.sh`) and the codex launcher. Three of them
 * carried the SAME two lines by copy — read `$NODETERM_NODE_TOKEN_DIR/$NODETERM_NODE_ID`, or
 * nothing — and that copy is what issue #384 was:
 *
 *   the dir is advertised ONLY by the endpoint file, and a session is pinned for life to the
 *   endpoint PATH it was handed at tmux creation (`buildPtyEnv` / `remoteHookEnvArgs`).
 *
 * So a session whose endpoint file does not advertise a dir presents no token at all, forever,
 * while its token file sits in the standard place. Three populations land there, all measured:
 *
 *  - **A pre-v2 endpoint file that is still LIVE.** SSH hosts used to share one
 *    `~/.nodeterm/hook-endpoint.env`; the current build writes per-project
 *    `hook-endpoint-<projectId>.env` and never rewrites the old path again. The old file names
 *    `~/.nodeterm/hook-<projectId>.sock` — a path that is RE-BOUND on every connect of that
 *    project — so it keeps reaching a live server while advertising no token dir. Reproduced on a
 *    real host: a `VERSION=1` file dated a month earlier, pointing at a socket created minutes ago.
 *  - **A session whose env carries the transport directly and no readable endpoint file** — what
 *    the phone hands a session it spawns (see the managed script's own gate comment).
 *  - **A partial read of an endpoint file** being rewritten under the reader.
 *
 * The failure this produces is not "unverified": it is a hard 403 with
 * `IDENTITY_REFUSED_NOTE`, because the node is LATCHED. The managed hook script has an endpoint
 * FAILOVER that adopts a live sibling endpoint and re-reads the token from ITS dir, so the same
 * node proves itself through the hook and is refused through the shim — trust-on-first-proof then
 * refuses every canvas-control call for the life of the session. The shims never learned the
 * failover, so the asymmetry was permanent and invisible.
 *
 * THE FIX, and why it can only ever help: the read falls back from the advertised dir to
 * `<dir of the endpoint file>/node-tokens` — which is the layout BY CONSTRUCTION on all three
 * surfaces (`<userData>/hook-endpoint.env` + `<userData>/node-tokens` on desktop and Server
 * Edition, `<home>/.nodeterm/hook-endpoint-<p>.env` + `<home>/.nodeterm/node-tokens` on an SSH
 * host) — and then to the same well-known data dirs the managed script already walks for endpoint
 * files.
 *
 * It is monotone, and that is the whole safety argument:
 *
 *  - the ADVERTISED dir is always tried first, so nothing that verifies today stops verifying;
 *  - the lookup is by `$NODETERM_NODE_ID` FILENAME in every candidate, so a session can still only
 *    ever present its own node's token — the property `never presents ANOTHER node's token file`
 *    is a property of the key, not of the directory;
 *  - a dir belonging to a DIFFERENT instance mints under a different secret, so its token carries a
 *    foreign `kid`, which `verifyNodeToken` reads as `legacy` — bit-for-bit what presenting nothing
 *    already gave. It can never read as `forged` (that needs OUR kid over another node's mac, and
 *    the filename forbids it) and it can never read as a different node.
 *
 * So each candidate can turn `legacy` into `verified` and nothing else. The happy path costs one
 * file read by the shell's own `read` and no process at all: only a miss walks.
 *
 * NOT USED BY the codex launcher (`core/codex-identity-proxy.ts`), deliberately. That client
 * REFUSES outright when the endpoint file is unreadable (`nt_fail hook-endpoint-unavailable`) and
 * degrades to plain codex with a named reason, which is a different and already-honest contract;
 * folding it in here would change what it reports, not just what it reads. Its read is one line
 * beside a `case` gate on the wire shape — if it ever grows a fallback, it grows THIS one.
 */

/**
 * Defines `nt_read_node_token [endpoint-file]`, which sets `nt_node_token` to this node's
 * capability or to '' when there is none to present. Never fails: '' is an ordinary state (a
 * pre-token session, a remote write that did not land) that the server reads as `legacy`, and a
 * hook client must not be able to die over identity.
 *
 * The optional argument is for the managed script's failover, which must anchor the derivation to
 * the endpoint it JUST ADOPTED rather than to the primary it is walking away from. Omitted, it
 * anchors to `$NODETERM_HOOK_ENDPOINT`.
 */
export const NODE_TOKEN_READ_SH = [
  '# Sets $nt_tdb_dir to `<dir of $1>/node-tokens`, or to nothing when $1 names no directory. The',
  '# endpoint file and the token dir are siblings on every surface we ship, so this needs no',
  '# per-platform knowledge. It SETS A VARIABLE rather than printing so the caller needs no command',
  '# substitution: this runs on every hook event, and a subshell there is a whole process.',
  'nt_token_dir_beside() {',
  '  nt_tdb_dir=""',
  '  case "$1" in */*) ;; *) return 0 ;; esac',
  '  nt_tdb=${1%/*}',
  '  [ -n "$nt_tdb" ] || return 0',
  '  nt_tdb_dir="$nt_tdb/node-tokens"',
  '}',
  '# nt_read_node_token [endpoint-file] — sets $nt_node_token. See node-token-sh.ts for why the',
  '# fallbacks below can only ever turn `legacy` into `verified`, and never anything into anything',
  '# worse. The lookup is by node-id FILENAME in every candidate, so a session can only ever',
  '# present its OWN token however many directories are searched.',
  'nt_read_node_token() {',
  '  nt_node_token=""',
  '  [ -n "$NODETERM_NODE_ID" ] || return 0',
  '  nt_ntep="$1"',
  '  [ -n "$nt_ntep" ] || nt_ntep="$NODETERM_HOOK_ENDPOINT"',
  '  nt_token_dir_beside "$nt_ntep"',
  '  for nt_ntd in \\',
  '    "$NODETERM_NODE_TOKEN_DIR" \\',
  '    "$nt_tdb_dir" \\',
  '    "$HOME/.nodeterm/node-tokens" \\',
  '    "$HOME/.nodeterm-server/node-tokens" \\',
  '    "$HOME/.config/node-terminal/node-tokens" \\',
  '    "$HOME/Library/Application Support/node-terminal/node-tokens"; do',
  '    [ -n "$nt_ntd" ] || continue',
  '    # The first line, read by the shell itself: what `head -n 1` in a command substitution gave,',
  '    # without the process. `read` answers non-zero at EOF, which is also what an unterminated',
  '    # last line looks like — and it has ALREADY assigned that line by then, so the status is',
  '    # ignored and only an unopenable file (the redirection fails, nothing is assigned) stays',
  '    # empty. The braces are what put a missing file\'s "cannot open" behind 2>/dev/null.',
  '    nt_node_token=""',
  '    { IFS= read -r nt_node_token < "$nt_ntd/$NODETERM_NODE_ID"; } 2>/dev/null || :',
  '    # A CRLF token file. Git for Windows\' bash drops the CR inside a command substitution, so the',
  '    # `head` form read such a file clean there; `read` keeps it. Drop one trailing CR so the two',
  '    # agree. It costs a process ONLY when the value really ends in a control character — never',
  '    # for a token we wrote — and the wire was never at risk either way: the header emitter',
  '    # strips CR from anything outside the token alphabet.',
  '    case "$nt_node_token" in',
  '      *[[:cntrl:]]) nt_cr=$(printf \'\\r\'); nt_node_token=${nt_node_token%"$nt_cr"} ;;',
  '    esac',
  '    [ -n "$nt_node_token" ] && return 0',
  '  done',
  '  nt_node_token=""',
  '  return 0',
  '}'
].join('\n')
