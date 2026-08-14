import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildManagedScript } from './managed-script'
import { hookServer } from '../hook-server'
import { nodeAuthToken } from '../node-auth-token'
import { initPlatform, resetPlatformForTests } from '../../platform'
import { fakePlatform } from '../../platform-fake'

describe('buildManagedScript', () => {
  const s = buildManagedScript('claude')
  it('keeps the local TCP POST path', () => {
    expect(s).toContain('http://127.0.0.1:${NODETERM_HOOK_PORT}/hook/claude')
  })
  it('adds a unix-socket POST branch gated on NODETERM_HOOK_SOCK', () => {
    expect(s).toContain('NODETERM_HOOK_SOCK')
    expect(s).toContain('--unix-socket')
    expect(s).toContain('/hook/claude')
  })
  it('still no-ops without node id / endpoint', () => {
    expect(s).toContain('NODETERM_NODE_ID')
  })
  it('gates the hook body on the NODE ID only (not the token) so an empty-endpoint session self-heals', () => {
    // A phone-spawned session created before any host process existed has a node id but no token
    // (its baked NODETERM_HOOK_ENDPOINT resolved empty). The gate must exit on a MISSING NODE ID,
    // NOT on a missing token — otherwise the failover in nt_send_request never runs and the session
    // stays dark until it is recreated. See buildManagedScript's "Empty-endpoint self-heal" note.
    expect(s).toContain('if [ -z "$NODETERM_NODE_ID" ]; then\n  exit 0\nfi')
    expect(s).not.toContain('if [ -z "$NODETERM_HOOK_TOKEN" ] || [ -z "$NODETERM_NODE_ID" ]; then')
  })

  // The executed tests below cover the request POST on both transports and the failover leg; this
  // one covers the FOURTH block too — the backgrounded "answered" POST, which fires only after a
  // phone/canvas answer file appears and is therefore hard to reach under /bin/sh. All four must
  // read their credentials from a config on stdin; none may name a token header in argv.
  it('never names a credential header on curl\'s command line, in any POST block', () => {
    expect(s).not.toContain('-H "X-Nodeterm-Hook-Token')
    expect(s).not.toContain('-H "X-Nodeterm-Node-Token')
    expect((s.match(/\n *curl -sS/g) ?? []).length).toBe(4)
    expect((s.match(/\n *nt_hook_headers \|/g) ?? []).length).toBe(4)
    expect((s.match(/--config -/g) ?? []).length).toBe(4)
  })

  describe('deterministic hook-reply approvals (PermissionRequest wait branch)', () => {
    it('gates the wait branch on NODETERM_PERM_WAIT_SECS > 0', () => {
      expect(s).toContain('[ -n "$NODETERM_PERM_WAIT_SECS" ] && [ "$NODETERM_PERM_WAIT_SECS" -gt 0 ]')
    })
    it('only arms on a PermissionRequest hook', () => {
      expect(s).toContain('"hook_event_name":"PermissionRequest"')
    })
    it('generates a pendingId and writes the request file under ~/.nodeterm/pending with umask 077', () => {
      expect(s).toContain('nt_pending="${nt_node}-${nt_ms}-$$"')
      expect(s).toContain('$HOME/.nodeterm/pending')
      expect(s).toContain('(umask 077; mkdir -p "$nt_dir")')
      expect(s).toContain('(umask 077; printf %s "$payload" > "$nt_pending_file")')
    })
    it('sanitizes the node id to the safe filename charset', () => {
      expect(s).toContain("tr -c 'A-Za-z0-9_-' '_'")
    })
    it('tags the POST body with nodeterm_pending_id on both transports', () => {
      // Four POST blocks now carry the tag: the initial request POST (unix-socket + TCP) AND the
      // "answered" signal POST fired from the wait branch (unix-socket + TCP).
      const matches = s.match(/--data-urlencode "nodeterm_pending_id=\$\{nt_pending\}"/g) ?? []
      expect(matches.length).toBe(4)
    })
    it('fires a backgrounded "answered" POST in the wait branch after reading a valid answer', () => {
      // Guarded on a valid allow/deny answer, tagged nodeterm_answered on both transports, and
      // backgrounded (& + short --max-time) so the decision JSON is never delayed.
      expect(s).toContain('if [ "$nt_decision" = "allow" ] || [ "$nt_decision" = "deny" ]; then')
      const answered = s.match(/--data-urlencode "nodeterm_answered=\$\{nt_decision\}"/g) ?? []
      expect(answered.length).toBe(2)
      const backgrounded = s.match(/--data-urlencode "payload=\$\{payload\}" >\/dev\/null 2>&1 &/g) ?? []
      expect(backgrounded.length).toBe(2)
      expect(s).toContain('--max-time 1')
    })
    it('does NOT fire the answered POST on timeout (only inside the answer-found branch)', () => {
      // The answered POST lives strictly between reading the answer file and the timeout cleanup:
      // it appears before the "Timed out" comment, and the timeout tail has no answered field.
      const answeredIdx = s.indexOf('nodeterm_answered')
      const timeoutIdx = s.indexOf('# Timed out')
      expect(answeredIdx).toBeGreaterThan(-1)
      expect(timeoutIdx).toBeGreaterThan(answeredIdx)
      const timeoutTail = s.slice(timeoutIdx)
      expect(timeoutTail).not.toContain('nodeterm_answered')
    })
    it('polls the answer file every 0.5s up to the armed seconds', () => {
      expect(s).toContain('nt_answer="$HOME/.nodeterm/pending/$nt_pending.answer"')
      expect(s).toContain('nt_max=$((NODETERM_PERM_WAIT_SECS * 2))')
      expect(s).toContain('sleep 0.5')
    })
    it('prints the exact allow / deny decision JSON', () => {
      expect(s).toContain(
        '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
      )
      expect(s).toContain('"behavior":"deny"')
      expect(s).toContain('"message":"Denied from nodeterm."')
    })
    it('cleans up request + answer files and, on timeout, removes the request file', () => {
      expect(s).toContain('rm -f "$nt_answer" "$nt_pending_file"')
      expect(s).toContain('rm -f "$nt_pending_file"')
    })
    it('is a no-op branch for a non-claude agent script too (env-gated, present but inert)', () => {
      const codex = buildManagedScript('codex')
      expect(codex).toContain('NODETERM_PERM_WAIT_SECS')
      expect(codex).toContain('/hook/codex')
    })
  })

  describe('the Codex thread-identity prelude', () => {
    // It is prepended for EVERY agent, not just codex — the generated scripts all change. That is
    // intended: the block is inert without CODEX_THREAD_ID, which no other agent's tool shell
    // sets, and one builder beats a codex-only fork of it. (Its behavior is exercised for real
    // under /bin/sh in core/codex-thread-identity-sh.test.ts.)
    it('is present in every agent script when an identity root is known', () => {
      for (const agent of ['claude', 'codex', 'gemini', 'grok', 'opencode']) {
        expect(buildManagedScript(agent, '/data/codex-thread-nodes')).toContain(
          "nt_codex_map='/data/codex-thread-nodes'/\"$CODEX_THREAD_ID\""
        )
      }
    })

    it('is omitted entirely when there is no identity root, leaving the legacy script', () => {
      const legacy = buildManagedScript('claude', null as unknown as string)
      expect(legacy).not.toContain('CODEX_THREAD_ID')
      expect(legacy.split('\n')[1]).toBe('if [ -n "$NODETERM_HOOK_ENDPOINT" ] && [ -r "$NODETERM_HOOK_ENDPOINT" ]; then')
    })
  })

  describe('endpoint failover (dead-primary retry against a live sibling endpoint)', () => {
    it('lists the three known candidate endpoint files', () => {
      expect(s).toContain('"$HOME/.nodeterm-server/hook-endpoint.env"')
      expect(s).toContain('"$HOME/.config/node-terminal/hook-endpoint.env"')
      expect(s).toContain('"$HOME/Library/Application Support/node-terminal/hook-endpoint.env"')
    })
    it('also globs the per-project SSH endpoints, with $HOME quoted but the pattern NOT', () => {
      // A quoted glob never expands — the whole self-heal for a session left on a dead project
      // id's endpoint file would silently do nothing.
      expect(s).toContain('"$HOME"/.nodeterm/hook-endpoint-*.env')
      expect(s).not.toContain('"$HOME/.nodeterm/hook-endpoint-*.env"')
    })
    it('picks the FRESHEST existing candidate (ls -t | head -n 1)', () => {
      expect(s).toContain('nt_fresh=$(ls -t "$@" 2>/dev/null | head -n 1)')
    })
    it('SKIPS the endpoint file already tried (compares each candidate to the tried path)', () => {
      expect(s).toContain('nt_pick_fallback "$NODETERM_HOOK_ENDPOINT"')
      expect(s).toContain('nt_tried="$1"')
      expect(s).toContain('[ "$nt_c" = "$nt_tried" ] && continue')
    })
    it('only considers readable candidates and returns 1 when there are none', () => {
      expect(s).toContain('[ -r "$nt_c" ] || continue')
      expect(s).toContain('[ "$#" -gt 0 ] || return 1')
    })
    it('clears SOCK/PORT before sourcing the fallback so a transport switch takes effect', () => {
      const clearSock = s.indexOf('NODETERM_HOOK_SOCK=""')
      const clearPort = s.indexOf('NODETERM_HOOK_PORT=""')
      const source = s.indexOf('. "$nt_fresh"')
      expect(clearSock).toBeGreaterThan(-1)
      expect(clearPort).toBeGreaterThan(-1)
      expect(source).toBeGreaterThan(clearSock)
      expect(source).toBeGreaterThan(clearPort)
    })
    it('re-POSTs against the fallback exactly ONCE on a failed primary POST', () => {
      // nt_send_request: primary attempt short-circuits on success (`&& return 0`), else a single
      // fallback source + one re-POST. No loop → at most one retry.
      expect(s).toContain('nt_request_post && return 0')
      expect(s).toContain('if nt_pick_fallback "$NODETERM_HOOK_ENDPOINT"; then')
      // Count CALLS (followed by whitespace/EOL), not the `nt_request_post() {` definition (`(`).
      const reposts = s.match(/\n *nt_request_post(?=\s|$)/g) ?? []
      // Two textual calls: the primary attempt and the single fallback retry.
      expect(reposts.length).toBe(2)
    })
    it('leaves the happy path untouched: a successful primary POST does no fallback work', () => {
      // `&& return 0` guarantees nt_pick_fallback / the candidate scan never run when curl exits 0.
      const send = s.slice(s.indexOf('nt_send_request() {'), s.indexOf('nt_send_request() {') + 200)
      expect(send).toContain('nt_request_post && return 0')
    })
    it('returns curl exit status from nt_request_post (no `|| true` masking) and returns 1 with no transport', () => {
      // The POST lines end at `>/dev/null 2>&1` (status preserved), NOT `>/dev/null 2>&1 || true`.
      expect(s).not.toContain('--data-urlencode "payload=${payload}" >/dev/null 2>&1 || true')
      expect(s).toContain('  else\n    return 1\n  fi')
    })
    it('perm-wait branch advertises the ask in the FOREGROUND (before the poll), non-perm backgrounds it', () => {
      // Foreground in perm-wait (pendingId reaches primary-or-fallback before the answer poll begins),
      // backgrounded otherwise so a live session's hot path never blocks.
      expect(s).toContain('if [ -n "$nt_pending" ]; then\n  nt_send_request\nelse\n  nt_send_request &\nfi')
      // The request POST carries nodeterm_pending_id, so the fallback learns the ask too.
      expect(s).toContain('--data-urlencode "nodeterm_pending_id=${nt_pending}"')
    })
  })
})

/**
 * A stand-in `curl` that records BOTH channels of every invocation: its argv (`$*`) and whatever
 * it was fed on stdin (the `--config -` file). One log, three line kinds per call:
 *
 *   ARGV <the command line>
 *   CFG  <each line of the config read from stdin>
 *   END
 *
 * Recording stdin is the point. A test that only inspected argv could not tell "the credential
 * moved to stdin" from "the credential was dropped"; a test that only inspected the server could
 * not tell "sent on stdin" from "sent on the command line". Both together pin the fix.
 */
function fakeCurlScript(log: string, tail = ''): string {
  return [
    '#!/bin/sh',
    `printf 'ARGV %s\\n' "$*" >> ${JSON.stringify(log)}`,
    `sed 's/^/CFG /' >> ${JSON.stringify(log)}`,
    `printf 'END\\n' >> ${JSON.stringify(log)}`,
    tail,
    'exit 0',
    ''
  ].join('\n')
}

interface CurlCall {
  /** The command line, exactly as `ps` would show it. */
  argv: string
  /** The curl config file curl read from stdin. */
  cfg: string
}

function curlCalls(log: string): CurlCall[] {
  const out: CurlCall[] = []
  let argv = ''
  let cfg: string[] = []
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (line.startsWith('ARGV ')) {
      argv = line.slice(5)
      cfg = []
    } else if (line.startsWith('CFG ')) {
      cfg.push(line.slice(4))
    } else if (line === 'END') {
      out.push({ argv, cfg: cfg.join('\n') })
    }
  }
  return out
}

// Generated shell no compiler checks: run it for real against a fake $HOME + a fake curl, the
// same discipline as the canvas-control shim and the remote-usage command. This is the ONLY thing
// that proves the glob candidate actually expands (a quoted pattern passes every string assertion
// above and still self-heals nothing).
describe('buildManagedScript endpoint failover, executed under /bin/sh', () => {
  const sh = spawnSync('sh', ['-c', 'exit 0'])
  const shAvailable = sh.status === 0 && !sh.error
  const dir = shAvailable ? mkdtempSync(join(tmpdir(), 'nt-hook-failover-')) : ''
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(!shAvailable)(
    'falls back to the freshest ~/.nodeterm/hook-endpoint-*.env when the primary tunnel is dead',
    () => {
      const home = join(dir, 'home')
      const bin = join(dir, 'bin')
      const log = join(dir, 'curl.log')
      mkdirSync(join(home, '.nodeterm'), { recursive: true })
      mkdirSync(bin, { recursive: true })
      // A remote session left pointing at a DEAD project id's endpoint (the tunnel that socket
      // named is long gone) — exactly the "active but idle forever" state.
      const dead = join(home, '.nodeterm', 'hook-endpoint-oldproject.env')
      // Each endpoint advertises its OWN node-token dir (the v2 line), and each dir holds a
      // DIFFERENT token for the same node id — that is what makes "whose token went out?"
      // observable on the retry.
      const deadTokens = join(home, 'dead-tokens')
      const liveTokens = join(home, 'live-tokens')
      mkdirSync(deadTokens, { recursive: true })
      mkdirSync(liveTokens, { recursive: true })
      writeFileSync(join(deadTokens, 'node-1'), 'PRIMARY-NODE-TOKEN\n', 'utf8')
      writeFileSync(join(liveTokens, 'node-1'), 'FALLBACK-NODE-TOKEN\n', 'utf8')
      writeFileSync(
        dead,
        `NODETERM_HOOK_SOCK=${join(home, '.nodeterm', 'hook-oldproject.sock')}\nNODETERM_HOOK_TOKEN=dead-token\nNODETERM_HOOK_VERSION=1\nNODETERM_NODE_TOKEN_DIR=${deadTokens}\n`,
        'utf8'
      )
      // The live project's endpoint, rewritten by the most recent connect.
      writeFileSync(
        join(home, '.nodeterm', 'hook-endpoint-liveproject.env'),
        `NODETERM_HOOK_PORT=45999\nNODETERM_HOOK_TOKEN=live-token\nNODETERM_HOOK_VERSION=1\nNODETERM_NODE_TOKEN_DIR=${liveTokens}\n`,
        'utf8'
      )
      // Fake curl: log every invocation, fail the unix-socket transport (dead tunnel), succeed on TCP.
      writeFileSync(
        join(bin, 'curl'),
        fakeCurlScript(log, 'case "$*" in *--unix-socket*) exit 7 ;; esac'),
        { encoding: 'utf8', mode: 0o755 }
      )
      const script = join(dir, 'claude.sh')
      writeFileSync(script, buildManagedScript('claude'), { encoding: 'utf8', mode: 0o755 })
      // The perm-wait branch sends the request POST in the FOREGROUND, so the run is deterministic
      // (the normal branch backgrounds it and would race this assertion).
      const res = spawnSync('sh', [script], {
        encoding: 'utf8',
        input: '{"hook_event_name":"PermissionRequest"}',
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          HOME: home,
          NODETERM_NODE_ID: 'node-1',
          NODETERM_HOOK_ENDPOINT: dead,
          NODETERM_PERM_WAIT_SECS: '1'
        }
      })
      expect(res.status).toBe(0)
      const calls = curlCalls(log)
      expect(calls).toHaveLength(2)
      // 1st: the dead primary over its socket. 2nd: the retry against the live project's endpoint.
      expect(calls[0].argv).toContain('--unix-socket')
      expect(calls[1].argv).toContain('http://127.0.0.1:45999/hook/claude')
      expect(calls[1].argv).toContain('nodeId=node-1')
      // The dead transport must not survive into the retry (SOCK/PORT are cleared before sourcing).
      expect(calls[1].argv).not.toContain('--unix-socket')
      // BOTH credentials arrive on stdin as a curl config, and NEITHER is on the command line —
      // on the failover leg as much as the primary one. `ps` on a shared host is readable by every
      // other account, and a leaked per-node token is a leaked node identity.
      expect(calls[0].cfg).toContain('header = "X-Nodeterm-Hook-Token: dead-token"')
      expect(calls[1].cfg).toContain('header = "X-Nodeterm-Hook-Token: live-token"')
      for (const c of calls) {
        for (const secret of [
          'dead-token',
          'live-token',
          'PRIMARY-NODE-TOKEN',
          'FALLBACK-NODE-TOKEN'
        ]) {
          expect(c.argv).not.toContain(secret)
        }
      }
      // The per-node token follows the ENDPOINT, not the process: the primary POST carries the
      // primary dir's token, and the retry carries the FALLBACK dir's — a stale token dir would
      // send our kid to an instance that cannot judge it.
      expect(calls[0].cfg).toContain('header = "X-Nodeterm-Node-Token: PRIMARY-NODE-TOKEN"')
      expect(calls[1].cfg).toContain('header = "X-Nodeterm-Node-Token: FALLBACK-NODE-TOKEN"')
      expect(calls[1].cfg).not.toContain('PRIMARY-NODE-TOKEN')
    }
  )

  // The other half of the same subtlety: an OLDER instance's endpoint file carries no
  // NODETERM_NODE_TOKEN_DIR line at all. Sourcing it must leave the dir EMPTY (nt_pick_fallback
  // clears it first), not silently keep ours — otherwise the retry reads OUR token dir and hands
  // our kid to a server that never minted it.
  it.skipIf(!shAvailable)('drops our token dir when the adopted endpoint advertises none', () => {
    const home = join(dir, 'home2')
    const bin = join(dir, 'bin2')
    const log = join(dir, 'curl2.log')
    mkdirSync(join(home, '.nodeterm'), { recursive: true })
    mkdirSync(bin, { recursive: true })
    const tokens = join(home, 'tokens')
    mkdirSync(tokens, { recursive: true })
    writeFileSync(join(tokens, 'node-1'), 'PRIMARY-ONLY-TOKEN\n', 'utf8')
    const dead = join(home, '.nodeterm', 'hook-endpoint-oldproject.env')
    writeFileSync(
      dead,
      `NODETERM_HOOK_SOCK=${join(home, '.nodeterm', 'dead.sock')}\nNODETERM_HOOK_TOKEN=dead-token\nNODETERM_HOOK_VERSION=1\nNODETERM_NODE_TOKEN_DIR=${tokens}\n`,
      'utf8'
    )
    // A pre-v2 endpoint file: port + token + version, and no token dir.
    writeFileSync(
      join(home, '.nodeterm', 'hook-endpoint-liveproject.env'),
      'NODETERM_HOOK_PORT=45999\nNODETERM_HOOK_TOKEN=live-token\nNODETERM_HOOK_VERSION=1\n',
      'utf8'
    )
    writeFileSync(join(bin, 'curl'), fakeCurlScript(log, 'case "$*" in *--unix-socket*) exit 7 ;; esac'), {
      encoding: 'utf8',
      mode: 0o755
    })
    const script = join(dir, 'claude2.sh')
    writeFileSync(script, buildManagedScript('claude'), { encoding: 'utf8', mode: 0o755 })
    const res = spawnSync('sh', [script], {
      encoding: 'utf8',
      input: '{"hook_event_name":"PermissionRequest"}',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        NODETERM_NODE_ID: 'node-1',
        NODETERM_HOOK_ENDPOINT: dead,
        NODETERM_PERM_WAIT_SECS: '1'
      }
    })
    expect(res.status).toBe(0)
    const calls = curlCalls(log)
    expect(calls).toHaveLength(2)
    expect(calls[0].cfg).toContain('header = "X-Nodeterm-Node-Token: PRIMARY-ONLY-TOKEN"')
    expect(calls[1].cfg).toContain('header = "X-Nodeterm-Hook-Token: live-token"')
    // Nothing was carried over — and neither leg put a credential on the command line.
    expect(calls[1].cfg).toContain('header = "X-Nodeterm-Node-Token: "')
    expect(calls[1].cfg).not.toContain('PRIMARY-ONLY-TOKEN')
    for (const c of calls) {
      for (const secret of ['dead-token', 'live-token', 'PRIMARY-ONLY-TOKEN']) {
        expect(c.argv).not.toContain(secret)
      }
    }
  })
})

// The per-node token (task A10). Everything here runs the REAL generated script under /bin/sh
// with the REAL curl against the REAL hook server, and asserts the server's own verdict — the
// only thing that proves the header is on the wire in the shape verifyNodeToken accepts.
//
// One environment fact worth stating once: curl DROPS a header whose value is empty
// (`-H "X: ${empty}"` sends nothing at all). That is exactly the contract we want — the server
// treats an absent header and an empty one identically as `legacy` — so "empty header" below
// means "absent or empty", read as `headers[...] ?? ''`.
describe('managed script presents the per-node token', () => {
  const SECRET = Buffer.alloc(32, 7)
  const FOREIGN_SECRET = Buffer.alloc(32, 9)
  const NODE = 'node-1'
  const sh = spawnSync('sh', ['-c', 'exit 0'])
  const shAvailable = sh.status === 0 && !sh.error

  let dir = ''
  let script = ''
  let raws: { nodeId: string; verified: boolean }[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nt-hook-node-token-'))
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: join(dir, 'userData') }))
    await hookServer.start()
    hookServer.setNodeAuthSecret(SECRET)
    hookServer.setRawListener((_agentId, nodeId, _payload, meta) => {
      raws.push({ nodeId, verified: meta.verified })
    })
    script = join(dir, 'claude.sh')
    writeFileSync(script, buildManagedScript('claude'), { encoding: 'utf8', mode: 0o755 })
  })

  afterAll(() => {
    hookServer.clearNodeAuthSecretForTests()
    hookServer.stop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    raws = []
  })

  /** A fresh $HOME per case: the failover scan globs ~/.nodeterm/hook-endpoint-*.env. */
  function newHome(name: string): string {
    const home = join(dir, name)
    mkdirSync(join(home, '.nodeterm'), { recursive: true })
    return home
  }

  function tokenDirWith(name: string, files: Record<string, string>): string {
    const d = join(dir, name)
    mkdirSync(d, { recursive: true })
    for (const [nodeId, token] of Object.entries(files)) {
      writeFileSync(join(d, nodeId), `${token}\n`, { encoding: 'utf8', mode: 0o600 })
    }
    return d
  }

  /**
   * Runs the hook the way claude does. NODETERM_PERM_WAIT_SECS arms the perm-wait branch, whose
   * request POST is in the FOREGROUND — so by the time sh exits the server has already seen it and
   * the assertions are deterministic (the normal branch backgrounds the POST and would race).
   *
   * ASYNC on purpose: `spawnSync` blocks node's event loop, so the hook server in this very
   * process never accepts the connection and every POST "fails" into the failover path.
   */
  function runHook(home: string, env: Record<string, string>): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn('sh', [script], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          NODETERM_NODE_ID: NODE,
          NODETERM_HOOK_PORT: String(hookServer.getPort()),
          NODETERM_HOOK_TOKEN: hookServer.getToken(),
          NODETERM_PERM_WAIT_SECS: '1',
          ...env
        },
        stdio: ['pipe', 'ignore', 'ignore']
      })
      child.stdin.end('{"hook_event_name":"PermissionRequest"}')
      child.on('close', (code) => resolve(code ?? -1))
    })
  }

  it.skipIf(!shAvailable)('makes the event verified when this node has a token file', async () => {
    const tokens = tokenDirWith('tokens-good', { [NODE]: nodeAuthToken(SECRET, NODE) })
    expect(await runHook(newHome('home-good'), { NODETERM_NODE_TOKEN_DIR: tokens })).toBe(0)
    expect(raws).toEqual([{ nodeId: NODE, verified: true }])
  })

  it.skipIf(!shAvailable)('reads the dir the ENDPOINT FILE advertises, not just the env', async () => {
    // The v2 endpoint file is how a remote session (and a session that outlived a restart) learns
    // where its token lives — so the read has to happen AFTER the file is sourced.
    const home = newHome('home-endpoint')
    const tokens = tokenDirWith('tokens-endpoint', { [NODE]: nodeAuthToken(SECRET, NODE) })
    const endpoint = join(home, '.nodeterm', 'hook-endpoint-live.env')
    writeFileSync(
      endpoint,
      `NODETERM_HOOK_PORT=${hookServer.getPort()}\nNODETERM_HOOK_TOKEN=${hookServer.getToken()}\nNODETERM_HOOK_VERSION=2\nNODETERM_NODE_TOKEN_DIR=${tokens}\n`,
      'utf8'
    )
    expect(
      await runHook(home, {
        NODETERM_HOOK_PORT: '',
        NODETERM_HOOK_TOKEN: '',
        NODETERM_HOOK_ENDPOINT: endpoint
      })
    ).toBe(0)
    expect(raws).toEqual([{ nodeId: NODE, verified: true }])
  })

  it.skipIf(!shAvailable)('still posts — unverified, nothing fails — when there is no token file', async () => {
    const empty = tokenDirWith('tokens-empty', {})
    expect(await runHook(newHome('home-none'), { NODETERM_NODE_TOKEN_DIR: empty })).toBe(0)
    expect(raws).toEqual([{ nodeId: NODE, verified: false }])
  })

  it.skipIf(!shAvailable)('still posts when no token dir is advertised at all (pre-v2 endpoint)', async () => {
    expect(await runHook(newHome('home-nodir'), {})).toBe(0)
    expect(raws).toEqual([{ nodeId: NODE, verified: false }])
  })

  it.skipIf(!shAvailable)('is keyed by $NODETERM_NODE_ID — another node\'s token file is never presented', async () => {
    // The dir holds a token this instance minted for a DIFFERENT node. Presenting it would be
    // `forged` (our kid, wrong mac) and the server would answer 403 with NO listener call — so
    // "exactly one event, unverified" is the assertion that the client looked up by node id
    // rather than picking whatever file was lying there.
    const tokens = tokenDirWith('tokens-other', { 'node-other': nodeAuthToken(SECRET, 'node-other') })
    expect(await runHook(newHome('home-other'), { NODETERM_NODE_TOKEN_DIR: tokens })).toBe(0)
    expect(raws).toEqual([{ nodeId: NODE, verified: false }])
  })

  // The leak this fix closes: both credentials used to ride on `curl -H …`, i.e. on a command
  // line, and a command line is world-readable through `ps` / /proc/<pid>/cmdline for the life of
  // the process — locally AND on every SSH host, where this exact script is installed. A co-tenant
  // who scrapes another node's token out of the process table can impersonate that node, which is
  // the one thing the per-node token exists to stop.
  //
  // The shim is a PASSTHROUGH: it records argv + stdin and then runs the real curl, so one case
  // proves the leak is gone AND that delivery still works (the server's own verdict below). A test
  // that only checked the server would pass with the leak fully intact.
  it.skipIf(!shAvailable)('sends both credentials on stdin, never on curl\'s command line', async () => {
    const realCurl = spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim()
    const bin = join(dir, 'argv-bin')
    mkdirSync(bin, { recursive: true })
    const argvLog = join(dir, 'argv-curl.argv')
    const stdinLog = join(dir, 'argv-curl.stdin')
    writeFileSync(
      join(bin, 'curl'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
        // Only a curl told to read its config from stdin gets a reader, so a regression that put
        // the headers back on argv fails on the assertions below rather than blocking on a stdin
        // nobody closes.
        'case "$*" in',
        `  *"--config -"*) tee -a ${JSON.stringify(stdinLog)} | ${JSON.stringify(realCurl)} "$@" ;;`,
        `  *) ${JSON.stringify(realCurl)} "$@" </dev/null ;;`,
        'esac',
        ''
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 }
    )
    // Truncated up front: a regression must fail on the assertions, not on a missing file.
    writeFileSync(argvLog, '')
    writeFileSync(stdinLog, '')
    const token = nodeAuthToken(SECRET, NODE)
    const tokens = tokenDirWith('tokens-argv', { [NODE]: token })
    expect(
      await runHook(newHome('home-argv'), {
        NODETERM_NODE_TOKEN_DIR: tokens,
        PATH: `${bin}:${process.env.PATH ?? ''}`
      })
    ).toBe(0)
    // Delivery is unchanged: the server still verified this node from the header it received.
    expect(raws).toEqual([{ nodeId: NODE, verified: true }])
    const argv = readFileSync(argvLog, 'utf8')
    const stdin = readFileSync(stdinLog, 'utf8')
    expect(argv).not.toContain(token)
    expect(argv).not.toContain(hookServer.getToken())
    expect(argv).not.toContain('X-Nodeterm-Node-Token')
    expect(argv).not.toContain('X-Nodeterm-Hook-Token')
    expect(stdin).toContain(`header = "X-Nodeterm-Hook-Token: ${hookServer.getToken()}"`)
    expect(stdin).toContain(`header = "X-Nodeterm-Node-Token: ${token}"`)
  })

  // THE failover subtlety: after adopting another instance's endpoint file, the token must be
  // RE-READ from that instance's dir. The primary's dir here holds a FOREIGN token (minted from a
  // different secret): if it survived the fallback — because the dir was not cleared, or because
  // the read happened once at the top — the server would see a foreign kid and label the event
  // `legacy`, i.e. verified:false. Only a genuine re-read produces verified:true.
  it.skipIf(!shAvailable)('re-reads the token from the endpoint it FELL BACK to', async () => {
    const home = newHome('home-failover')
    const primaryTokens = tokenDirWith('tokens-primary', {
      [NODE]: nodeAuthToken(FOREIGN_SECRET, NODE)
    })
    const fallbackTokens = tokenDirWith('tokens-fallback', { [NODE]: nodeAuthToken(SECRET, NODE) })
    const dead = join(home, '.nodeterm', 'hook-endpoint-dead.env')
    writeFileSync(
      dead,
      `NODETERM_HOOK_SOCK=${join(home, '.nodeterm', 'nothing-listens-here.sock')}\nNODETERM_HOOK_TOKEN=dead\nNODETERM_HOOK_VERSION=2\nNODETERM_NODE_TOKEN_DIR=${primaryTokens}\n`,
      'utf8'
    )
    const live = join(home, '.nodeterm', 'hook-endpoint-live.env')
    writeFileSync(
      live,
      `NODETERM_HOOK_PORT=${hookServer.getPort()}\nNODETERM_HOOK_TOKEN=${hookServer.getToken()}\nNODETERM_HOOK_VERSION=2\nNODETERM_NODE_TOKEN_DIR=${fallbackTokens}\n`,
      'utf8'
    )
    // `ls -t` picks the freshest candidate — make the dead one unambiguously older.
    const old = Date.now() / 1000 - 600
    utimesSync(dead, old, old)

    expect(
      await runHook(home, {
        NODETERM_HOOK_PORT: '',
        NODETERM_HOOK_TOKEN: '',
        NODETERM_HOOK_ENDPOINT: dead
      })
    ).toBe(0)
    expect(raws).toEqual([{ nodeId: NODE, verified: true }])
  })
})

describe('buildManagedScript generated shell is syntactically valid', () => {
  const sh = spawnSync('sh', ['-c', 'exit 0'])
  const shAvailable = sh.status === 0 && !sh.error
  const dir = shAvailable ? mkdtempSync(join(tmpdir(), 'nt-managed-script-')) : ''
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  for (const agentId of ['claude', 'codex', 'gemini']) {
    it.skipIf(!shAvailable)(`passes \`sh -n\` for ${agentId}`, () => {
      const file = join(dir, `hook-${agentId}.sh`)
      writeFileSync(file, buildManagedScript(agentId), 'utf8')
      const res = spawnSync('sh', ['-n', file], { encoding: 'utf8' })
      expect(res.stderr || '').toBe('')
      expect(res.status).toBe(0)
    })
  }
})
