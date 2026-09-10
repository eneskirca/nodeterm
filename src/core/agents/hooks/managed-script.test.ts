import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildManagedScript, MANAGED_SCRIPT_REVISION } from './managed-script'
import { hookServer } from '../hook-server'
import { nodeAuthToken } from '../node-auth-token'
import { initPlatform, resetPlatformForTests } from '../../platform'
import { fakePlatform } from '../../platform-fake'

describe('buildManagedScript', () => {
  const s = buildManagedScript('claude')
  it('hands curl a path it can open, gated on the shell reporting itself as MSYS', () => {
    // The gate is what `uname -s` reports, not merely that a cygpath exists: the name check by
    // itself would fire on a WSL or Linux box with something called cygpath on PATH, converting a
    // path its own POSIX curl could already open. Reading the shell's own identity also survives a
    // caller that replaces the environment, which the executed tests below do.
    expect(s).toContain('nt_payload_arg="$nt_payload_file"')
    expect(s).toContain('case "$(uname -s 2>/dev/null)" in')
    expect(s).toContain('  MINGW*|MSYS*)')
    expect(s).toContain('    if command -v cygpath >/dev/null 2>&1; then')
    expect(s).toContain('|| nt_payload_arg="$nt_payload_file"')
    expect(s).toContain('[ -n "$nt_payload_arg" ] || nt_payload_arg="$nt_payload_file"')
  })

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
    // The bail drains stdin first (#187) — see the executed bail-path tests at the end of the file.
    expect(s).toContain('if [ -z "$NODETERM_NODE_ID" ]; then\n  cat >/dev/null 2>&1 || :\n  exit 0\nfi')
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
    // The two answered POSTs are wrapped in a `{ … ; rm … } &` group that self-deletes the payload
    // temp file, so `nt_hook_headers |` there is preceded by `{ ` — match either form.
    expect((s.match(/\n *(\{ )?nt_hook_headers \|/g) ?? []).length).toBe(4)
    expect((s.match(/--config -/g) ?? []).length).toBe(4)
  })

  it('stamps its own revision on every POST, through the same stdin emitter', () => {
    // Finding F2: the `version` field below is sourced from the ENDPOINT FILE, so it reports the
    // SERVER's protocol version and can never answer "which client is this?". Without the stamp an
    // old script and a current one with a missing token file are byte-identical on the wire.
    expect(s).toContain(`nt_client_rev=${MANAGED_SCRIPT_REVISION}`)
    expect(s).toContain('printf \'header = "X-Nodeterm-Hook-Client: %s"')
    expect(s).not.toContain('-H "X-Nodeterm-Hook-Client')
    // Set once, at the top — not inside any function, and in particular not where the failover
    // clears the vars that belong to the endpoint rather than to this file.
    expect((s.match(/nt_client_rev=/g) ?? []).length).toBe(1)
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
      // Each backgrounded answered POST reads the payload from the temp file and self-deletes it
      // after curl returns (the file must never outlive its reader).
      const backgrounded = s.match(
        /--data-urlencode "payload@\$\{nt_payload_arg\}" >\/dev\/null 2>&1; rm -f "\$nt_payload_file" 2>\/dev\/null \|\| :; \} &/g
      ) ?? []
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
    // Issue #409: NODETERM_PERM_WAIT_SECS rides the CLAUDE node's session env and is INHERITED by
    // nested processes — a codex launched from inside a claude node's shell carried it, and codex
    // renders its approval dialog only AFTER the PermissionRequest hook exits (measured,
    // codex-cli 0.149.1), so the inherited wait held every codex approval for the full armed
    // seconds and could print claude's decision JSON into codex's own (unverified) decision
    // contract. The wait is therefore claude-only at BUILD time: absent from every other agent's
    // script, whatever the env says.
    it('the wait branch is ABSENT from a non-claude agent script, not merely env-inert', () => {
      for (const agent of ['codex', 'gemini', 'grok', 'copilot', 'opencode', 'devin']) {
        const script = buildManagedScript(agent)
        expect(script, `${agent} script arms the perm wait`).not.toContain('NODETERM_PERM_WAIT_SECS * 2')
        expect(script, `${agent} script polls the answer file`).not.toContain('.answer')
        expect(script, `${agent} script can print a decision`).not.toContain('hookSpecificOutput')
        expect(script).toContain(`/hook/${agent}`)
      }
      // And claude keeps the whole branch.
      const claude = buildManagedScript('claude')
      expect(claude).toContain('nt_max=$((NODETERM_PERM_WAIT_SECS * 2))')
      expect(claude).toContain('"behavior":"deny"')
    })
  })

  describe('payload stays OFF curl argv (/proc leak + E2BIG fix)', () => {
    it('never puts the payload on the command line', () => {
      // `--data-urlencode "payload=$payload"` would publish the full hook body via
      // /proc/<pid>/cmdline and cap the event at the kernel argv limit (E2BIG on a big diff).
      expect(s).not.toContain('payload=${payload}')
    })
    it('writes the payload to a 0600 temp file after reading stdin', () => {
      expect(s).toContain('nt_payload_file="$HOME/.nodeterm/pending/payload-$$.tmp"')
      expect(s).toContain('(umask 077; printf %s "$payload" > "$nt_payload_file")')
    })
    it('every POST reads the payload from the temp file with payload@file', () => {
      // Four POSTs: request (unix-socket + TCP) and answered (unix-socket + TCP). They read
      // `nt_payload_arg`, which is `nt_payload_file` everywhere except Git Bash/MSYS, where it is
      // the same file expressed as a Windows path so a native curl can open it.
      const atFile = s.match(/--data-urlencode "payload@\$\{nt_payload_arg\}"/g) ?? []
      expect(atFile.length).toBe(4)
    })
    it('deletes the temp file on every exit path (hot path, answered, no-transport, timeout)', () => {
      expect(s).toContain('{ nt_send_request; rm -f "$nt_payload_file" 2>/dev/null || :; } &')
      expect(s).toContain('if [ "$nt_payload_owned" != 1 ]; then rm -f "$nt_payload_file" 2>/dev/null || :; fi')
      expect(s).toContain('rm -f "$nt_pending_file" "$nt_payload_file" 2>/dev/null || :')
    })
  })

  // Executed rather than grepped: a string test would stay green if the conversion block moved
  // BELOW the curl calls, which would hand every POST an empty argument. These run the generated
  // script with a fake curl and a fake cygpath and read the argv curl actually received.
  describe('the payload path curl actually receives', () => {
    /** Runs the generated script with a fake curl, a fake cygpath, and a fake `uname` that decides
     *  which branch of the gate is taken. `uname` rather than an env var on purpose: that is what
     *  the script reads, and it is what keeps working when a caller replaces the environment. */
    const run = (unameS: string, cygpath: string | null): CurlCall[] => {
      const dir = mkdtempSync(join(tmpdir(), 'nt-payload-'))
      const bin = join(dir, 'bin')
      const home = join(dir, 'home')
      mkdirSync(bin, { recursive: true })
      mkdirSync(join(home, '.nodeterm'), { recursive: true })
      const log = join(dir, 'curl.log')
      writeFileSync(join(bin, 'curl'), fakeCurlScript(log), { encoding: 'utf8', mode: 0o755 })
      writeFileSync(join(bin, 'uname'), `#!/bin/sh\nprintf %s ${JSON.stringify(unameS)}\n`, {
        encoding: 'utf8',
        mode: 0o755
      })
      if (cygpath !== null) {
        writeFileSync(join(bin, 'cygpath'), `#!/bin/sh\n${cygpath}\n`, { encoding: 'utf8', mode: 0o755 })
      }
      writeFileSync(
        join(home, '.nodeterm', 'hook-endpoint.env'),
        'NODETERM_HOOK_PORT=45999\nNODETERM_HOOK_TOKEN=t\nNODETERM_HOOK_VERSION=1\n',
        'utf8'
      )
      const script = join(dir, 'claude.sh')
      writeFileSync(script, buildManagedScript('claude'), { encoding: 'utf8', mode: 0o755 })
      const res = spawnSync('sh', [script], {
        encoding: 'utf8',
        input: '{"hook_event_name":"PermissionRequest"}',
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          HOME: home,
          NODETERM_NODE_ID: 'node-1',
          NODETERM_HOOK_ENDPOINT: join(home, '.nodeterm', 'hook-endpoint.env'),
          NODETERM_PERM_WAIT_SECS: '1'
        }
      })
      expect(res.status).toBe(0)
      return curlCalls(log)
    }
    const runMsys = (cygpath: string | null): CurlCall[] => run('MINGW64_NT-10.0-26200', cygpath)
    const runPosix = (cygpath: string | null): CurlCall[] => run('Linux', cygpath)

    it('converts the path under MSYS, which is the case that was broken', () => {
      const calls = runMsys('printf %s "C:\\converted\\payload.tmp"')
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].argv).toContain('payload@C:\\converted\\payload.tmp')
    })

    it('leaves the path alone with no MSYSTEM, even when a cygpath exists', () => {
      // The WSL/Linux case: an incidental cygpath must not rewrite a path the local curl can open.
      const calls = runPosix('printf %s "C:\\wrong\\payload.tmp"')
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].argv).not.toContain('C:\\wrong')
      expect(calls[0].argv).toContain('payload@/')
    })

    it('falls back to the original path when cygpath fails or answers empty', () => {
      for (const cyg of ['exit 3', 'printf %s ""']) {
        const calls = runMsys(cyg)
        expect(calls.length).toBeGreaterThan(0)
        // Never an empty argument: an empty payload@ would post nothing at all.
        expect(calls[0].argv).not.toContain('payload@ ')
        expect(calls[0].argv).toContain('payload@/')
      }
    })

    it('keeps a converted path with spaces in one argument', () => {
      const calls = runMsys('printf %s "C:\\Users\\First Last\\payload.tmp"')
      expect(calls[0].argv).toContain('payload@C:\\Users\\First Last\\payload.tmp')
    })
  })

  describe('the Codex thread-identity prelude', () => {
    // It is prepended for EVERY agent, not just codex — the generated scripts all change. That is
    // intended: the block is inert without CODEX_THREAD_ID, which no other agent's tool shell
    // sets, and one builder beats a codex-only fork of it. (Its behavior is exercised for real
    // under /bin/sh in core/codex-thread-identity-sh.test.ts.)
    it('is present in every agent script when an identity root is known', () => {
      for (const agent of ['claude', 'codex', 'gemini', 'grok', 'opencode']) {
        // The account-scoped resolver bakes the (quoted) record root in and scans scopes below it.
        expect(buildManagedScript(agent, '/data/codex-thread-nodes')).toContain(
          "nt_codex_root='/data/codex-thread-nodes'"
        )
      }
    })

    it('is omitted entirely when there is no identity root, leaving the legacy script', () => {
      const legacy = buildManagedScript('claude', null as unknown as string)
      expect(legacy).not.toContain('CODEX_THREAD_ID')
      // The gate PRECEDES the endpoint sourcing (#186): a non-nodeterm session bails before any
      // foreign-env file is executed. Order asserted, not a line index — comments may grow.
      const lines = legacy.split('\n')
      const gate = lines.indexOf('if [ -z "$NODETERM_NODE_ID" ]; then')
      const sourcing = lines.indexOf(
        'if [ -n "$NODETERM_HOOK_ENDPOINT" ] && [ -r "$NODETERM_HOOK_ENDPOINT" ]; then'
      )
      expect(gate).toBeGreaterThan(0)
      expect(sourcing).toBeGreaterThan(gate)
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
    it('emits the LOCAL endpoints before the tunnel glob (failure-domain order, not mtime)', () => {
      // The ordering IS the fix. Every hook-endpoint-*.env tunnel on a host terminates at the same
      // desktop, so they share one fate; a local endpoint (the host's own Server Edition, or a
      // desktop installed here) fails independently. Sorting the whole list by mtime buried the one
      // live endpoint under N dead siblings — see the measured table in managed-script.ts.
      const list = s.slice(s.indexOf('nt_candidates() {'), s.indexOf('nt_adopt() {'))
      const server = list.indexOf('"$HOME/.nodeterm-server/hook-endpoint.env"')
      const appSupport = list.indexOf('"$HOME/Library/Application Support/node-terminal/hook-endpoint.env"')
      const glob = list.indexOf('"$HOME"/.nodeterm/hook-endpoint-*.env')
      expect(server).toBeGreaterThan(-1)
      expect(glob).toBeGreaterThan(appSupport)
      expect(appSupport).toBeGreaterThan(server)
    })
    it('keeps mtime as the tie-break WITHIN the tunnel group only (ls -t over the glob matches)', () => {
      // The live project's endpoint is rewritten and VERIFIED on every connect, so freshest-first is
      // still the right order among tunnels — it is only wrong when applied across failure domains.
      expect(s).toContain('ls -t "$@" 2>/dev/null')
      // The whole-list, single-winner rule is gone: no `head -n 1` anywhere in the candidate scan.
      expect(s).not.toContain('ls -t "$@" 2>/dev/null | head -n 1')
    })
    it('SKIPS the endpoint file already tried (compares each candidate to the tried path)', () => {
      expect(s).toContain('nt_candidates "$NODETERM_HOOK_ENDPOINT"')
      expect(s).toContain('nt_tried="$1"')
      expect(s).toContain('[ "$nt_c" = "$nt_tried" ] && continue')
    })
    it('only considers readable candidates and returns nothing when there are none', () => {
      expect(s).toContain('[ -r "$nt_c" ] || continue')
      expect(s).toContain('[ "$#" -gt 0 ] || return 0')
      expect(s).toContain('[ -n "$nt_list" ] || return 1')
    })
    it('clears SOCK/PORT before sourcing EACH adopted candidate so no transport leaks across', () => {
      const adopt = s.slice(s.indexOf('nt_adopt() {'), s.indexOf('nt_request_post() {'))
      const clearSock = adopt.indexOf('NODETERM_HOOK_SOCK=""')
      const clearPort = adopt.indexOf('NODETERM_HOOK_PORT=""')
      const clearDir = adopt.indexOf('NODETERM_NODE_TOKEN_DIR=""')
      const source = adopt.indexOf('. "$1"')
      expect(clearSock).toBeGreaterThan(-1)
      expect(clearPort).toBeGreaterThan(-1)
      expect(clearDir).toBeGreaterThan(-1)
      expect(source).toBeGreaterThan(clearSock)
      expect(source).toBeGreaterThan(clearPort)
      expect(source).toBeGreaterThan(clearDir)
    })
    it('walks SEVERAL candidates after a failed primary POST, capped by nt_fallback_max', () => {
      // One retry could not get past a single stale sibling — which is exactly what the measured
      // host had. The walk is bounded because a dead reverse-tunnel socket is not cheap to fail:
      // sshd accepts and never answers, so each attempt can burn the full --max-time.
      expect(s).toContain('nt_request_post && return 0')
      expect(s).toContain('nt_fallback_max=3')
      expect(s).toContain('[ "$nt_n" -le "$nt_fallback_max" ] || break')
      // Count CALLS (followed by whitespace/EOL), not the `nt_request_post() {` definition (`(`).
      const reposts = s.match(/\n *nt_request_post(?=\s|$)/g) ?? []
      // Two textual calls: the primary attempt and the ONE inside the bounded loop.
      expect(reposts.length).toBe(2)
      // The token is re-read per adopted candidate, inside the loop — not once before it.
      const loop = s.slice(s.indexOf('for nt_ep in "$@"; do'), s.indexOf('  return 1\n}'))
      expect(loop).toContain('nt_read_node_token')
      expect(loop).toContain('nt_adopt "$nt_ep" || continue')
    })
    it('splits the candidate list on NEWLINES with globbing off (paths contain spaces)', () => {
      // "Application Support" has a space in it. Default IFS would split it into two bogus paths;
      // an unquoted expansion without `set -f` would re-glob a path containing a glob character.
      expect(s).toContain('IFS="\n"')
      expect(s).toContain('  set -f\n')
      expect(s).toContain('  set +f\n')
      expect(s).toContain('nt_ifs="$IFS"')
      expect(s).toContain('IFS="$nt_ifs"')
    })
    it('leaves the happy path untouched: a successful primary POST does no fallback work', () => {
      // `&& return 0` guarantees nt_pick_fallback / the candidate scan never run when curl exits 0.
      const send = s.slice(s.indexOf('nt_send_request() {'), s.indexOf('nt_send_request() {') + 200)
      expect(send).toContain('nt_request_post && return 0')
    })
    it('returns curl exit status from nt_request_post (no `|| true` masking) and returns 1 with no transport', () => {
      // The POST lines end at `>/dev/null 2>&1` (status preserved), NOT `>/dev/null 2>&1 || true`.
      expect(s).not.toContain('--data-urlencode "payload@${nt_payload_file}" >/dev/null 2>&1 || true')
      expect(s).toContain('  else\n    return 1\n  fi')
    })
    it('perm-wait branch advertises the ask in the FOREGROUND (before the poll), non-perm backgrounds it', () => {
      // Foreground in perm-wait (pendingId reaches primary-or-fallback before the answer poll begins),
      // backgrounded otherwise so a live session's hot path never blocks.
      expect(s).toContain('if [ -n "$nt_pending" ]; then\n  nt_send_request\nelse\n')
      // Non-perm-wait backgrounds the POST and self-deletes the payload temp file after it (and its
      // one fallback retry) return, so the file never outlives its reader.
      expect(s).toContain('  { nt_send_request; rm -f "$nt_payload_file" 2>/dev/null || :; } &\nfi')
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
      // The client stamp is a property of THIS SCRIPT, so it survives the endpoint switch that
      // clears sock/port/token-dir — on both legs, with the same value.
      for (const c of calls) {
        expect(c.cfg).toContain(`header = "X-Nodeterm-Hook-Client: ${MANAGED_SCRIPT_REVISION}"`)
      }
    }
  )

  /**
   * The measured outage, reproduced. On the live host (Mac closed, 8 agents running):
   *
   *   hook-endpoint-project-mrkigsjp-4.env  13:25  the primary — excluded as already tried
   *   hook-endpoint-project-msq9marh-4.env  12:52  another project's tunnel to the SAME Mac, dead
   *   .nodeterm-server/hook-endpoint.env    00:26  the host's own Server Edition — ALIVE
   *
   * A freshest-by-mtime single retry lands on the dead sibling and gives up; that host's mirror
   * held 0 nodes and 0 events while every session worked. Ordering by FAILURE DOMAIN (locals before
   * tunnels) is what reaches the live endpoint — and it reaches it FIRST, so the dead sibling is
   * never even dialled.
   */
  it.skipIf(!shAvailable)(
    'reaches the host-local Server Edition even though a fresher sibling tunnel outranks it by mtime',
    () => {
      const home = join(dir, 'home-local-first')
      const bin = join(dir, 'bin-local-first')
      const log = join(dir, 'curl-local-first.log')
      mkdirSync(join(home, '.nodeterm'), { recursive: true })
      mkdirSync(join(home, '.nodeterm-server'), { recursive: true })
      mkdirSync(bin, { recursive: true })
      // The primary: this session's own reverse tunnel, dead with the laptop closed.
      const primary = join(home, '.nodeterm', 'hook-endpoint-project-mrkigsjp-4.env')
      writeFileSync(
        primary,
        `NODETERM_HOOK_SOCK=${join(home, '.nodeterm', 'hook-mrkigsjp.sock')}\nNODETERM_HOOK_TOKEN=primary-token\nNODETERM_HOOK_VERSION=2\n`,
        'utf8'
      )
      // Another project's tunnel to the SAME Mac. Also dead — they share one fate.
      const sibling = join(home, '.nodeterm', 'hook-endpoint-project-msq9marh-4.env')
      writeFileSync(
        sibling,
        `NODETERM_HOOK_SOCK=${join(home, '.nodeterm', 'hook-msq9marh.sock')}\nNODETERM_HOOK_TOKEN=sibling-token\nNODETERM_HOOK_VERSION=2\n`,
        'utf8'
      )
      // The always-on Server Edition on THIS host: oldest file on disk, and the only live endpoint.
      const local = join(home, '.nodeterm-server', 'hook-endpoint.env')
      writeFileSync(
        local,
        'NODETERM_HOOK_PORT=45999\nNODETERM_HOOK_TOKEN=local-token\nNODETERM_HOOK_VERSION=2\n',
        'utf8'
      )
      // Exactly the measured mtime ranking: primary newest, sibling next, local oldest by hours.
      const now = Date.now() / 1000
      utimesSync(primary, now, now)
      utimesSync(sibling, now - 1800, now - 1800)
      utimesSync(local, now - 46_000, now - 46_000)
      // Every tunnel socket is dead; only the local TCP port answers.
      writeFileSync(
        join(bin, 'curl'),
        fakeCurlScript(log, 'case "$*" in *127.0.0.1:45999*) : ;; *) exit 7 ;; esac'),
        { encoding: 'utf8', mode: 0o755 }
      )
      const script = join(dir, 'claude-local-first.sh')
      writeFileSync(script, buildManagedScript('claude'), { encoding: 'utf8', mode: 0o755 })
      const res = spawnSync('sh', [script], {
        encoding: 'utf8',
        input: '{"hook_event_name":"PermissionRequest"}',
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          HOME: home,
          NODETERM_NODE_ID: 'node-1',
          NODETERM_HOOK_ENDPOINT: primary,
          NODETERM_PERM_WAIT_SECS: '1'
        }
      })
      expect(res.status).toBe(0)
      const calls = curlCalls(log)
      // Two calls: the dead primary, then the LOCAL endpoint. The dead sibling tunnel — freshest of
      // the remaining candidates, and the only one the old single retry ever tried — is skipped
      // entirely, because it belongs to the failure domain that just proved itself dead.
      expect(calls).toHaveLength(2)
      expect(calls[0].argv).toContain('--unix-socket')
      expect(calls[0].argv).toContain('hook-mrkigsjp.sock')
      expect(calls[1].argv).toContain('http://127.0.0.1:45999/hook/claude')
      expect(calls[1].argv).not.toContain('--unix-socket')
      expect(calls[1].cfg).toContain('header = "X-Nodeterm-Hook-Token: local-token"')
      for (const c of calls) expect(c.argv).not.toContain('hook-msq9marh.sock')
    }
  )

  // Locals are ordered too, and one of them has a SPACE in its path. A dead local must not end the
  // walk (an exited Server Edition leaves its endpoint file behind), and default IFS would have
  // split "Application Support" into two paths that exist nowhere.
  it.skipIf(!shAvailable)('walks past a dead local to one whose path contains a space', () => {
    const home = join(dir, 'home-space')
    const bin = join(dir, 'bin-space')
    const log = join(dir, 'curl-space.log')
    const appSupportDir = join(home, 'Library', 'Application Support', 'node-terminal')
    mkdirSync(join(home, '.nodeterm'), { recursive: true })
    mkdirSync(join(home, '.nodeterm-server'), { recursive: true })
    mkdirSync(appSupportDir, { recursive: true })
    mkdirSync(bin, { recursive: true })
    const primary = join(home, '.nodeterm', 'hook-endpoint-project-a.env')
    writeFileSync(
      primary,
      `NODETERM_HOOK_SOCK=${join(home, '.nodeterm', 'a.sock')}\nNODETERM_HOOK_TOKEN=primary-token\nNODETERM_HOOK_VERSION=2\n`,
      'utf8'
    )
    // A Server Edition that is no longer running: its endpoint file outlived it.
    writeFileSync(
      join(home, '.nodeterm-server', 'hook-endpoint.env'),
      'NODETERM_HOOK_PORT=46000\nNODETERM_HOOK_TOKEN=stale-server-token\nNODETERM_HOOK_VERSION=2\n',
      'utf8'
    )
    // The live desktop installed on this same host.
    writeFileSync(
      join(appSupportDir, 'hook-endpoint.env'),
      'NODETERM_HOOK_PORT=45999\nNODETERM_HOOK_TOKEN=desktop-token\nNODETERM_HOOK_VERSION=2\n',
      'utf8'
    )
    writeFileSync(
      join(bin, 'curl'),
      fakeCurlScript(log, 'case "$*" in *127.0.0.1:45999*) : ;; *) exit 7 ;; esac'),
      { encoding: 'utf8', mode: 0o755 }
    )
    const script = join(dir, 'claude-space.sh')
    writeFileSync(script, buildManagedScript('claude'), { encoding: 'utf8', mode: 0o755 })
    const res = spawnSync('sh', [script], {
      encoding: 'utf8',
      input: '{"hook_event_name":"PermissionRequest"}',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        NODETERM_NODE_ID: 'node-1',
        NODETERM_HOOK_ENDPOINT: primary,
        NODETERM_PERM_WAIT_SECS: '1'
      }
    })
    expect(res.status).toBe(0)
    const calls = curlCalls(log)
    // primary (dead socket) → stale Server Edition (dead port) → the desktop under the spaced path.
    expect(calls).toHaveLength(3)
    expect(calls[0].argv).toContain('--unix-socket')
    expect(calls[1].argv).toContain('http://127.0.0.1:46000/hook/claude')
    expect(calls[2].argv).toContain('http://127.0.0.1:45999/hook/claude')
    expect(calls[2].cfg).toContain('header = "X-Nodeterm-Hook-Token: desktop-token"')
  })

  // The bound. A dead reverse-tunnel socket is NOT cheap to fail — sshd accepts the connection and
  // then never answers, so each attempt can burn the full --max-time. A host with a dozen stale
  // project endpoints must not turn every hook event into a dozen hanging curls.
  it.skipIf(!shAvailable)('stops after nt_fallback_max fallback POSTs, however many candidates exist', () => {
    const home = join(dir, 'home-bound')
    const bin = join(dir, 'bin-bound')
    const log = join(dir, 'curl-bound.log')
    mkdirSync(join(home, '.nodeterm'), { recursive: true })
    mkdirSync(bin, { recursive: true })
    const primary = join(home, '.nodeterm', 'hook-endpoint-project-0.env')
    writeFileSync(primary, 'NODETERM_HOOK_PORT=46000\nNODETERM_HOOK_VERSION=2\n', 'utf8')
    // Eight more dead tunnels to the same (closed) desktop.
    const now = Date.now() / 1000
    for (let i = 1; i <= 8; i++) {
      const f = join(home, '.nodeterm', `hook-endpoint-project-${i}.env`)
      writeFileSync(f, `NODETERM_HOOK_PORT=${46000 + i}\nNODETERM_HOOK_VERSION=2\n`, 'utf8')
      utimesSync(f, now - i, now - i)
    }
    utimesSync(primary, now, now)
    // Nothing anywhere answers.
    writeFileSync(join(bin, 'curl'), fakeCurlScript(log, 'exit 7'), {
      encoding: 'utf8',
      mode: 0o755
    })
    const script = join(dir, 'claude-bound.sh')
    writeFileSync(script, buildManagedScript('claude'), { encoding: 'utf8', mode: 0o755 })
    const res = spawnSync('sh', [script], {
      encoding: 'utf8',
      input: '{"hook_event_name":"PermissionRequest"}',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        NODETERM_NODE_ID: 'node-1',
        NODETERM_HOOK_ENDPOINT: primary,
        NODETERM_PERM_WAIT_SECS: '1'
      }
    })
    expect(res.status).toBe(0)
    const calls = curlCalls(log)
    // 1 primary + 3 fallbacks, never 1 + 8.
    expect(calls).toHaveLength(4)
    // And they are the FRESHEST three tunnels, in order — mtime is still the tie-break within the
    // tunnel group (this host has no local endpoint at all).
    expect(calls[1].argv).toContain('127.0.0.1:46001')
    expect(calls[2].argv).toContain('127.0.0.1:46002')
    expect(calls[3].argv).toContain('127.0.0.1:46003')
  })

  // Requirement 4, pinned: the overwhelmingly common host is one project, one tunnel, no Server
  // Edition. Its only candidate is the endpoint it already tried, so the walk must find nothing and
  // fire nothing — exactly as before this change.
  it.skipIf(!shAvailable)('a single-tunnel host with no local endpoint does no fallback work', () => {
    const home = join(dir, 'home-single')
    const bin = join(dir, 'bin-single')
    const log = join(dir, 'curl-single.log')
    mkdirSync(join(home, '.nodeterm'), { recursive: true })
    mkdirSync(bin, { recursive: true })
    const primary = join(home, '.nodeterm', 'hook-endpoint-project-only.env')
    writeFileSync(
      primary,
      `NODETERM_HOOK_SOCK=${join(home, '.nodeterm', 'only.sock')}\nNODETERM_HOOK_TOKEN=only-token\nNODETERM_HOOK_VERSION=2\n`,
      'utf8'
    )
    writeFileSync(join(bin, 'curl'), fakeCurlScript(log, 'exit 7'), { encoding: 'utf8', mode: 0o755 })
    const script = join(dir, 'claude-single.sh')
    writeFileSync(script, buildManagedScript('claude'), { encoding: 'utf8', mode: 0o755 })
    const res = spawnSync('sh', [script], {
      encoding: 'utf8',
      input: '{"hook_event_name":"PermissionRequest"}',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        NODETERM_NODE_ID: 'node-1',
        NODETERM_HOOK_ENDPOINT: primary,
        NODETERM_PERM_WAIT_SECS: '1'
      }
    })
    expect(res.status).toBe(0)
    expect(curlCalls(log)).toHaveLength(1)
  })

  // The happy path pays for none of this: a primary POST that SUCCEEDS must produce exactly one
  // curl and never touch the candidate scan, even on a host stuffed with live-looking endpoints.
  it.skipIf(!shAvailable)('a successful primary POST fires exactly one curl and scans nothing', () => {
    const home = join(dir, 'home-happy')
    const bin = join(dir, 'bin-happy')
    const log = join(dir, 'curl-happy.log')
    mkdirSync(join(home, '.nodeterm'), { recursive: true })
    mkdirSync(join(home, '.nodeterm-server'), { recursive: true })
    mkdirSync(bin, { recursive: true })
    const primary = join(home, '.nodeterm', 'hook-endpoint-project-a.env')
    writeFileSync(primary, 'NODETERM_HOOK_PORT=45999\nNODETERM_HOOK_VERSION=2\n', 'utf8')
    for (const other of [
      join(home, '.nodeterm', 'hook-endpoint-project-b.env'),
      join(home, '.nodeterm-server', 'hook-endpoint.env')
    ]) {
      writeFileSync(other, 'NODETERM_HOOK_PORT=45999\nNODETERM_HOOK_VERSION=2\n', 'utf8')
    }
    writeFileSync(join(bin, 'curl'), fakeCurlScript(log), { encoding: 'utf8', mode: 0o755 })
    const script = join(dir, 'claude-happy.sh')
    writeFileSync(script, buildManagedScript('claude'), { encoding: 'utf8', mode: 0o755 })
    const res = spawnSync('sh', [script], {
      encoding: 'utf8',
      input: '{"hook_event_name":"PermissionRequest"}',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        NODETERM_NODE_ID: 'node-1',
        NODETERM_HOOK_ENDPOINT: primary,
        NODETERM_PERM_WAIT_SECS: '1'
      }
    })
    expect(res.status).toBe(0)
    expect(curlCalls(log)).toHaveLength(1)
  })

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

/**
 * The bail path, executed under a real /bin/sh — the two failure modes of issues #186/#187, each
 * pinned by the issue's own repro shape. String assertions above say the lines exist; these prove
 * the behavior: no EPIPE for a big writer, and not one byte of endpoint stdout reaching the agent.
 */
describe('the managed script bail path (issues #186/#187), under /bin/sh', () => {
  const sh = spawnSync('sh', ['-c', 'exit 0'])
  const shAvailable = sh.status === 0 && !sh.error
  const dir = shAvailable ? mkdtempSync(join(tmpdir(), 'nt-bail-path-')) : ''
  const script = dir ? join(dir, 'claude.sh') : ''
  const home = dir ? join(dir, 'home') : ''
  beforeAll(() => {
    if (!dir) return
    mkdirSync(home, { recursive: true })
    writeFileSync(script, buildManagedScript('claude'), { encoding: 'utf8', mode: 0o755 })
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  // HOME points at an empty temp dir in every run: the endpoint failover globs $HOME for candidate
  // files, and a test that let it see the real ~/.nodeterm would depend on this machine's state.
  const baseEnv = { PATH: process.env.PATH ?? '' }

  it.skipIf(!shAvailable)(
    'drains stdin before bailing — a >64KB payload never EPIPEs the writer (#187)',
    async () => {
      // The issue's repro: raw writes (subprocess.communicate-style helpers swallow EPIPE and hide
      // this). 2MB is ~32 pipe buffers, so an un-drained bail fails on the second write at latest.
      const payload = Buffer.alloc(2_000_000, 0x41)
      const child = spawn('sh', [script], {
        env: { ...baseEnv, HOME: home },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const writeError = new Promise<Error | null>((resolve) => {
        child.stdin.on('error', (e) => resolve(e))
        child.stdin.end(payload, () => resolve(null))
      })
      const exit = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)))
      expect(await writeError).toBeNull()
      expect(await exit).toBe(0)
    }
  )

  it.skipIf(!shAvailable)(
    'a no-node-id session never executes the endpoint file, let alone leaks its stdout (#186)',
    () => {
      // The issue's canary, plus a side-effect marker: executed-at-all and leaked-to-stdout are
      // different failures, and the marker file catches the first even if output were swallowed.
      const canary = join(dir, 'canary.env')
      writeFileSync(canary, `echo "LEAKED"\n: > '${join(dir, 'executed.marker')}'\n`, 'utf8')
      const res = spawnSync('sh', [script], {
        encoding: 'utf8',
        input: '{"hook_event_name":"UserPromptSubmit"}',
        env: { ...baseEnv, HOME: home, NODETERM_HOOK_ENDPOINT: canary }
      })
      expect(res.status).toBe(0)
      expect(res.stdout).toBe('')
      expect(existsSync(join(dir, 'executed.marker'))).toBe(false)
    }
  )

  it.skipIf(!shAvailable)(
    'a nodeterm session sources the endpoint file but swallows its stdout (#186 point 2)',
    () => {
      // SessionStart/UserPromptSubmit stdout is ADDED TO THE AGENT'S CONTEXT, so even the legit
      // sourcing path must print nothing. No SOCK/PORT and an empty HOME → the backgrounded POST
      // finds no transport and no fallback candidates; the script still owes a silent exit 0.
      const canary = join(dir, 'canary-live.env')
      writeFileSync(canary, 'echo "LEAKED"\n', 'utf8')
      const res = spawnSync('sh', [script], {
        encoding: 'utf8',
        input: '{"hook_event_name":"UserPromptSubmit"}',
        env: { ...baseEnv, HOME: home, NODETERM_NODE_ID: 'node-1', NODETERM_HOOK_ENDPOINT: canary }
      })
      expect(res.status).toBe(0)
      expect(res.stdout).toBe('')
    }
  )
})
