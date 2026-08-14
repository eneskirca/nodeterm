# task: hook credentials off curl's command line

Status: **done**, committed to `feat/node-identity`.

## The leak

Every generated curl client passed both credentials as `-H` arguments:

```
curl … -H "X-Nodeterm-Hook-Token: ${NODETERM_HOOK_TOKEN}" -H "X-Nodeterm-Node-Token: ${nt_node_token}"
```

A command line is not private. `ps` and `/proc/<pid>/cmdline` are world-readable on a stock Linux,
so for the life of each curl any other account on the machine could read both the app-wide bearer
and *this node's* per-node capability. That applies locally and — worse — on every SSH host, where
these same scripts are installed for remote agent nodes and the other accounts are strangers.
Scraping a node token out of the process table is exactly the impersonation the per-node token
exists to prevent, so the identity series was not actually closed until this was fixed.

## The fix

One shared POSIX-sh helper, `HOOK_CURL_HEADERS_SH` in **`src/core/agents/hook-curl-config-sh.ts`**,
emitting:

```sh
nt_hook_headers() {
  printf 'header = "X-Nodeterm-Hook-Token: %s"\n' "$(printf %s "$NODETERM_HOOK_TOKEN" | tr -d '\\"\n\r')"
  printf 'header = "X-Nodeterm-Node-Token: %s"\n' "$(printf %s "$nt_node_token"       | tr -d '\\"\n\r')"
}
```

piped into `curl … --config -` at every call site. This is the pattern already used by
`src/core/usage/remote-claude-usage.ts` and `src/core/codex-identity-proxy.ts`, not a new one. It
lives in one module because three clients send the same two headers and three copies of an escaping
rule is how one of them stays wrong.

Call sites converted (8):

| file | sites |
| --- | --- |
| `src/core/agents/hooks/managed-script.ts` | request POST (unix socket + TCP) and the backgrounded "answered" POST (unix socket + TCP) |
| `src/main/canvas-control-core.ts` | `CONTROL_SHIM_SCRIPT`, both transports |
| `src/core/context-link-core.ts` | `CONTEXT_SHIM_SCRIPT`, both transports |

### Behaviour deliberately preserved

- **Exit codes.** POSIX says a pipeline's status is its last command's, so `nt_hook_headers | curl …`
  still returns curl's status — which is what `nt_send_request` reads to decide whether to fail over,
  and what the shims' `nt_code` capture depends on. The `else return 1` no-transport arm is untouched.
- **Endpoint re-source per POST**, `nt_pick_fallback`'s single retry, and its **post-fallback token
  re-read** — the helper reads `$NODETERM_HOOK_TOKEN`/`$nt_node_token` at call time, not once at the
  top, so the fallback leg still presents the adopted endpoint's token.
- **Empty header = legacy.** Verified against real curl 8.5: `header = "X-…-Token: "` in a config file
  behaves identically to `-H "X-…-Token: "` — curl sends *no header at all* when there is nothing
  after the colon. Nothing sends a literal `""`. The server keeps reading absent and empty alike.
- **Socket-vs-TCP branch selection**, `--connect-timeout`/`--max-time` budgets, backgrounding (`&`),
  and `>/dev/null 2>&1` redirections are unchanged.

### Escaping

A curl config file is line-based and its quoted values understand backslash escapes, so four
characters could end a header line and inject a directive of their own: `"`, `\`, LF and CR. All four
are **stripped**. None can occur in a value we send today — the per-node token is `kid.mac` over
`[A-Za-z0-9._-]` and the bearer is a UUID — which is precisely what makes stripping (rather than
escaping) safe: nothing legitimate is altered, and a value that somehow acquired one still cannot
break out of its own header line. Covered by a test that feeds `ab"\nuser-agent = "pwned` as the
bearer and asserts no `user-agent` directive appears in the config curl reads.

POSIX sh only: `printf` + a pipe + `tr`. No bashisms, no process substitution. All three generated
scripts pass `sh -n` and `dash -n`.

## Tests

Red-first shape: the fake `curl` in the two existing failover tests used to *assert the credentials
were in `$*`* — i.e. the old suite asserted the leak. It now records **both** channels (`ARGV …` /
`CFG …` / `END`) and asserts the credentials are only ever on stdin.

New/extended coverage:

- `managed-script.test.ts`
  - both failover legs: neither `dead-token`, `live-token`, `PRIMARY-NODE-TOKEN` nor
    `FALLBACK-NODE-TOKEN` appears in argv; each leg's config on stdin carries the right pair
    (socket transport + TCP transport + the failover path, in one run).
  - a **passthrough** curl shim (record argv + stdin, then exec the real curl) against the real hook
    server: `verified: true` still recorded, and argv contains neither token nor even the header
    names.
  - a source assertion covering the fourth block (the "answered" POST, unreachable without an answer
    file): 4 curls, 4 `nt_hook_headers |`, 4 `--config -`, zero `-H "X-Nodeterm-*-Token`.
- `canvas-control-shim.test.ts` — passthrough curl over TCP **and** over the unix socket; server
  still sees both headers; argv clean; plus the quote/newline breakout case.
- `context-link.cli.test.ts` — same two transports, plus the "no token file" case proving the
  header is still dropped entirely (server sees `''`).

The recording shim only attaches a stdin reader when it sees `--config -`; otherwise a regression
would hang on an unclosed stdin and the failure would read as a timeout rather than an assertion.

### Mutation check

Reverting a single call site to the `-H` form and re-running:

| mutation | result |
| --- | --- |
| `context-link-core.ts` TCP branch → `-H` | 2 failed — `expected '-sS -o …' not to contain 'SECRET-BEARER'` |
| `managed-script.ts` TCP request POST → `-H` | 3 failed — argv contained the real node token; both failover configs empty |
| `canvas-control-core.ts` unix-socket branch → `-H` | 1 failed — `expected '-sS -o …' not to contain 'SECRET-BEARER'` |

All three restored afterwards; the working tree contains no mutation.

## opencode plugin

**No change needed, and none made.** `src/core/agents/hooks/opencode.ts` generates a JavaScript
plugin, not a shell script: it sets `x-nodeterm-hook-token` / `x-nodeterm-node-token` in a `headers`
object handed to `fetch(…)` or `http.request(…)` inside the opencode process. Those values never
become process arguments, so there is nothing on any command line to leak. (It was also the file
most at risk from the template-literal trap, which is a second reason not to touch it.)

## Gates

- `npx vitest run src/core/agents src/main/canvas-control-shim.test.ts src/core/context-link.cli.test.ts src/core/no-electron.test.ts src/server/no-electron.test.ts`
  → **24 files, 308 tests, all passing**
- `npm run typecheck` → **clean** (both `tsconfig.node.json` and `tsconfig.web.json`)
- Also re-run green as collateral: `context-link.handler`, `context-link-core`,
  `server/context-link`, `canvas-control-core`, `test/server/hook-install-guard`,
  `src/main/remote-ssh` → 15 files, 307 tests.

## Remaining credential-on-a-command-line in the repo

One, out of this task's scope:

- **`src/main/remote-ssh/ssh-askpass.ts:117`** — the generated SSH askpass helper still does
  `curl … -H "X-Nodeterm-Askpass-Token: ${NODETERM_ASKPASS_TOKEN}"`. Same class of leak, local-only
  (the socket is `~/.nodeterm/askpass/*.sock`, 0600 in a 0700 dir), but the bearer is visible in `ps`
  for the life of that curl — which, for a passphrase prompt, is up to `--max-time 300`. The same
  `printf … | curl --config -` shape applies unchanged; `nt_hook_headers` is not directly reusable
  because the header name and variable differ.

Checked and clean: `codex-identity-proxy.ts` and `remote-claude-usage.ts` (already stdin);
`remote-hooks.ts` probe (already stdin); the tmux `-e` channel (closed earlier in this series —
`hook-server.ts` deliberately omits `NODETERM_HOOK_TOKEN`/`PORT` from the session env); endpoint
files and node-token files (0600 on disk, not argv); `relay-socket.ts` (token in a WebSocket URL
built in-process, never argv).
