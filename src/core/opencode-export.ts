// The opencode session export — the one way nodeterm reads an opencode conversation. Two spellings:
// `opencode export <id>` (1.x) and `opencode session export --standalone <id>` (2.x).
//
// opencode >= 1.18 keeps sessions in SQLite (`~/.local/share/opencode/opencode.db`, which also
// holds its account tokens), so its disk is never parsed: the export is the contract. Two readers
// share this module — Context Link (flat lines, `context-link.ts`) and the ⌘M chat view
// (`opencode-chat.ts`) — so the id check and the bounds below exist once.
//
// MEASURED on opencode 1.18.25 (2026-09-28): stdout is the JSON document alone
// (`JSON.stringify(doc, null, 2)` + EOL); stderr carries `Exporting session: <id>`; an unknown id
// exits 1 with an EMPTY stdout and `Session not found: <id>` (ANSI-coloured) on stderr; an unknown
// option exits 1 (yargs strict), so no flag is passed that an older CLI might not know. One export
// costs 1.0–1.7 s wall and ~320 MB peak RSS on this host, which is why the chat view gates it
// (`createOpencodeExportGate`).
//
// MEASURED on @opencode/cli 2.2.7 (2026-11-13, issue #1438) — NO spelling works on both lines:
//  - 2.x: `export <id>` exits 1 with usage text on stdout ending in
//    `Unexpected positional argument: "<id>"`. The command is `session export [flags] [<session>]`.
//  - 1.x (1.18.33): `session` has only `list` / `delete`; `session export <id>` prints help, exit 1.
//  - 2.x WITHOUT `--standalone` talks to the shared background service and STARTS it when it is
//    not running (a daemon that outlives the read and keeps the environment of whoever started it
//    — see hooks/opencode.ts), and fails outright when the service port is taken. `--standalone`
//    runs a private server for the one command and reads the same `opencode.db`: 1.5 s wall,
//    ~160 MB peak RSS, and it answers while the service is running too.
//  - 2.x unknown id: exit 1, EMPTY stdout, `Session not found: <id>` on stderr (no ANSI) — the same
//    answer the 1.x detector below already reads as a clean miss.
// So 1.x's spelling is tried first and 2.x's only on 2.x's own measured refusal of it; which one
// worked is remembered per binary, so a 2.x host pays the wasted first spawn once.
import os from 'os'
import { directExecutableInvocation } from './exec-path'

/** An export names ONE provider session. The id reaches us from a hook payload, so it is re-checked
 *  here, where it becomes an argv entry: `directExecutableInvocation` stops it being read as shell
 *  syntax, and nothing but this stops a leading `-` being read by opencode as an option. */
const SAFE_OPENCODE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/

export function isSafeOpencodeSessionId(sessionId: string): boolean {
  return SAFE_OPENCODE_SESSION_ID.test(sessionId)
}

// A whole conversation comes back on stdout. execFile's default 1 MiB buffer turns a long session
// into an error, which reads as "no transcript".
export const OPENCODE_EXPORT_MAX_BYTES = 32 * 1024 * 1024

/**
 * `ok` — the export's stdout. `absent` — opencode LOOKED and has no such session (a clean miss,
 * positive evidence). Anything else — no binary, a crash, a timeout, an oversized export — is `{ok:false}`: we could not read, which is never evidence of absence.
 */
export type OpencodeExportOutcome = { ok: true; stdout: string } | { ok: false; absent?: true }

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g

type OpencodeExportDialect = 'v1' | 'v2'

const EXPORT_ARGV: Record<OpencodeExportDialect, (sessionId: string) => string[]> = {
  v1: (sessionId) => ['export', sessionId],
  // `--standalone` BEFORE the id, and no other flag (see the header for why it is not optional).
  v2: (sessionId) => ['session', 'export', '--standalone', sessionId]
}

/** 2.x's refusal of the 1.x spelling. The only failure that proves the OTHER spelling is the right
 *  one — a timeout, a crash or a locked database on 1.x must not be answered by a second spawn. */
const V1_SPELLING_REFUSED = 'Unexpected positional argument'

/** Which spelling last produced an answer, per binary path. An in-place upgrade or downgrade is
 *  healed by the rules in `runOpencodeExportAt`, never by trusting this forever. */
const dialectByBin = new Map<string, OpencodeExportDialect>()

/** Test seam: forget every remembered spelling. */
export function resetOpencodeExportDialects(): void {
  dialectByBin.clear()
}

type Attempt = { outcome: OpencodeExportOutcome; v1SpellingRefused: boolean }

async function attemptExport(
  bin: string,
  dialect: OpencodeExportDialect,
  sessionId: string,
  timeoutMs: number
): Promise<Attempt> {
  const fail: Attempt = { outcome: { ok: false }, v1SpellingRefused: false }
  const invocation = directExecutableInvocation(bin, EXPORT_ARGV[dialect](sessionId))
  if (!invocation) return fail
  try {
    const { execFile } = await import('node:child_process')
    return await new Promise<Attempt>((resolve) => {
      execFile(
        invocation.executable,
        invocation.args,
        {
          ...invocation.options,
          // Never the app's cwd: opencode bootstraps a project for its cwd and, inside a git repo,
          // writes `<repo>/.git/opencode`. An export resolves the session by its GLOBAL id, so a
          // neutral directory changes nothing about what is read.
          cwd: os.tmpdir(),
          encoding: 'utf-8',
          maxBuffer: OPENCODE_EXPORT_MAX_BYTES,
          timeout: timeoutMs
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ outcome: { ok: true, stdout }, v1SpellingRefused: false })
          // Only the measured answer about THIS id is absence: exit 1, nothing on stdout, and the
          // not-found line naming exactly the id we asked for. A killed/timed-out process has a
          // non-numeric code (or `killed`), so it can never match.
          const code = (err as { code?: unknown }).code
          const exited1 = code === 1 && !(err as { killed?: boolean }).killed
          const errText = String(stderr ?? '').replace(ANSI, '')
          const notFound = exited1 && stdout === '' && errText.includes(`Session not found: ${sessionId}`)
          resolve({
            outcome: notFound ? { ok: false, absent: true } : { ok: false },
            // 2.2.7 prints its usage (and this line) on stdout; either stream is accepted.
            v1SpellingRefused:
              exited1 && (String(stdout ?? '').includes(V1_SPELLING_REFUSED) || errText.includes(V1_SPELLING_REFUSED))
          })
        }
      )
    })
  } catch {
    return fail
  }
}

/** Callers check `isSafeOpencodeSessionId` first — this runs whatever id it is handed, exactly as
 *  `opencodeExportAt` always has (the Windows shim test hands it an id with `&` and a space to
 *  prove the shim does not reinterpret it).
 *
 *  Spelling: the remembered one, else 1.x's. 1.x's falls through to 2.x's ONLY on 2.x's own
 *  refusal of it. A remembered 2.x spelling that fails without an answer is forgotten (the binary
 *  may have been downgraded in place), so the next read starts from 1.x's again; that read itself
 *  stays a failed read. */
export async function runOpencodeExportAt(
  bin: string,
  sessionId: string,
  timeoutMs: number
): Promise<OpencodeExportOutcome> {
  const answered = (o: OpencodeExportOutcome): boolean => o.ok || o.absent === true
  if (dialectByBin.get(bin) === 'v2') {
    const { outcome } = await attemptExport(bin, 'v2', sessionId, timeoutMs)
    if (!answered(outcome)) dialectByBin.delete(bin)
    return outcome
  }
  const first = await attemptExport(bin, 'v1', sessionId, timeoutMs)
  if (!first.v1SpellingRefused) {
    if (answered(first.outcome)) dialectByBin.set(bin, 'v1')
    return first.outcome
  }
  const second = await attemptExport(bin, 'v2', sessionId, timeoutMs)
  if (answered(second.outcome)) dialectByBin.set(bin, 'v2')
  return second.outcome
}

/**
 * The same read as ONE remote command line (Context Link over an SSH project's ControlMaster),
 * where there is no second round trip to spend on a retry. `quotedSessionId` is already
 * single-quoted by the caller. Wrapped in `sh -c` because the host's login shell may not be POSIX
 * (fish has no `if …; then`). The 1.x spelling's stdout is held back until it SUCCEEDS: 2.x answers
 * it with usage text on stdout, which would otherwise land in front of the real document.
 * Run for real under /bin/sh in `opencode-export.test.ts`.
 */
export function remoteOpencodeExportCommand(quotedSessionId: string): string {
  const script =
    'if o=$(opencode export "$1" 2>/dev/null); then printf "%s\\n" "$o"; ' +
    'else opencode session export --standalone "$1"; fi'
  return `sh -c '${script}' sh ${quotedSessionId}`
}
