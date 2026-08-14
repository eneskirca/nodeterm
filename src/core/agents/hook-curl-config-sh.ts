/**
 * The one POSIX-sh helper every generated curl client uses to hand its credentials to curl.
 *
 * WHY IT EXISTS: a command line is not private. `ps` and `/proc/<pid>/cmdline` are world-readable
 * on a stock Linux, so `curl -H "X-Nodeterm-Node-Token: <token>"` publishes that token to every
 * other account on the machine for as long as the curl lives — locally AND on every SSH host,
 * where the hook clients are installed for remote agent nodes. The per-node token exists precisely
 * to answer "which node is calling?"; a co-tenant who scrapes one out of the process table can
 * impersonate that node, and the app-wide bearer alongside it is the key to the whole hook API.
 * So the headers are written into a curl config file on stdin (`--config -`) instead, the same
 * way `usage/remote-claude-usage.ts` and the codex launcher in `codex-identity-proxy.ts` already
 * do it. There is deliberately no argv fallback for an ancient curl: `--config` has been there
 * since the 1990s, and a silent downgrade to argv would be the leak wearing a compatibility hat.
 *
 * ONE COPY OF THE ESCAPING RULE, FOUR CLIENTS: the managed hook script, the canvas-control shim
 * and the context-link shim all send the same two hook headers (`HOOK_CURL_HEADERS_SH` below);
 * the SSH askpass helper in `main/remote-ssh/ssh-askpass.ts` sends a different, single header and
 * builds its own emitter from `curlHeaderConfigSh`. They all go through `headerLine`, because four
 * copies of a quoting rule is how one of them stays wrong.
 */

/**
 * THE ESCAPING RULE, ONCE. A curl config file is LINE-based and its quoted values understand
 * backslash escapes, so exactly four characters could end a header line and start a directive of
 * their own: `"`, `\`, LF and CR. All four are STRIPPED from a value before it is written.
 *
 * Stripping (rather than escaping) is safe here because none can occur in a value we send — the
 * per-node token is `kid.mac` over `[A-Za-z0-9._-]`, the bearer is a `randomUUID()` — so nothing
 * legitimate is altered, and a value that somehow acquired one still cannot break out of its line.
 *
 * Two emitters read this list and no third may invent its own: `headerLine` (POSIX sh, for the
 * generated clients) and `curlHeaderConfigLine` (Node, for a config file this process writes
 * itself). A rule with two copies is a rule where one copy is wrong — which is how the SSH tunnel
 * probe ended up ESCAPING two of the four and ignoring the line breaks entirely.
 */
const CURL_CONFIG_STRIP = ['\\', '"', '\n', '\r'] as const

/** The same four characters as a `tr -d` set, single-quoted in sh (`tr` reads its own escapes). */
const TR_STRIP_SET = CURL_CONFIG_STRIP.map((c) =>
  c === '\\' ? '\\\\' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c
).join('')

/**
 * One `header = "<name>: <value>"` line for a curl config file, emitted by `printf` so the value
 * is read from its sh variable AT CALL TIME (callers such as the managed script's failover re-read
 * their token between POSTs, and the emitter must see the current value, not one captured once).
 *
 * `valueRef` is the sh expression holding the value, e.g. `$NODETERM_HOOK_TOKEN` — it is expanded
 * inside double quotes here, so it is never word-split or globbed.
 */
function headerLine(name: string, valueRef: string): string {
  return `  printf 'header = "${name}: %s"\\n' "$(printf %s "${valueRef}" | tr -d '${TR_STRIP_SET}')"`
}

/**
 * The same rule for a config file NODE writes and pipes to curl itself — today the SSH tunnel probe
 * in `main/remote-ssh/remote-hooks.ts`, which is on the far side of a `ssh` child and so cannot use
 * the sh emitter above.
 *
 * Newline-terminated, because a curl config file is line-based and an unterminated last line is a
 * directive curl may or may not read depending on its version.
 */
export function curlHeaderConfigLine(name: string, value: string): string {
  let v = value
  for (const c of CURL_CONFIG_STRIP) v = v.split(c).join('')
  return `header = "${name}: ${v}"\n`
}

/**
 * Build a POSIX-sh function that writes a curl config file (for `curl --config -`) carrying
 * `headers`, to be piped into curl. `note` is the client-specific comment placed above it.
 *
 * The quoting rule lives here and nowhere else: a curl config file is LINE-based and its quoted
 * values understand backslash escapes, so four characters could end a header line and start a
 * directive of their own — `"`, `\`, and the two line breaks. All four are stripped from a value
 * before it is written.
 */
export function curlHeaderConfigSh(
  fnName: string,
  headers: { name: string; valueRef: string }[],
  note: string
): string {
  return [
    note,
    `${fnName}() {`,
    ...headers.map((h) => headerLine(h.name, h.valueRef)),
    '}'
  ].join('\n')
}

export const HOOK_CURL_HEADERS_SH = curlHeaderConfigSh(
  'nt_hook_headers',
  [
    { name: 'X-Nodeterm-Hook-Token', valueRef: '$NODETERM_HOOK_TOKEN' },
    // The caller's variable (each client reads it from the token dir the endpoint file advertises,
    // keyed by its own node id) — read here, not passed, because the failover in the managed
    // script RE-READS it between POSTs and the emitter must see the current value.
    { name: 'X-Nodeterm-Node-Token', valueRef: '$nt_node_token' }
  ],
  `# Both credentials go to curl on STDIN as a config file, never in argv: a command line is
# world-readable through \`ps\` / /proc/<pid>/cmdline for the life of the process, locally and on
# every SSH host, so an argv header hands the app-wide bearer — and this node's own capability —
# to any co-tenant who looks at the process table. Reading another node's token out of \`ps\` is
# exactly the impersonation the per-node token exists to prevent.
#
# Quoting: a curl config file is LINE-based and its quoted values understand backslash escapes, so
# four characters could end a header line and start a directive of their own — \`"\`, \`\\\`, and the
# two line breaks. All four are stripped before the value is written. None can occur in a value we
# send today — the per-node token is kid.mac over [A-Za-z0-9._-] and the bearer is a UUID — which
# is what makes STRIPPING (rather than escaping) safe here: nothing legitimate is altered, and a
# value that somehow acquired one still could not break out of its own header line.
#
# An EMPTY value keeps the legacy contract exactly as \`-H\` did: curl sends no header at all when
# there is nothing after the colon, and the server reads absent and empty identically as \`legacy\`.`
)
