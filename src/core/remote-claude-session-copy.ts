// The SSH leg of the running-node "Switch Claude account" copy (`claude-session-copy.ts` is the
// local one). An SSH project's transcripts and account dirs live ON THE HOST, so the copy runs
// there: one POSIX `sh` script over the project's ControlMaster, whose only output is a marker line.
// Same rules as the local copy — the renderer runs it after the CLI has exited, a target that is a
// byte-prefix of the source is an older copy and is replaced, a diverged target is never touched,
// and the sidecars (subagent transcripts, `/rewind` file history) are copied best-effort without
// ever overwriting a file the target already has.
//
// Pure string builder + parser. `src/main` runs it; `remote-claude-session-copy.test.ts` runs the
// generated script for real under `/bin/sh` against a fake host tree (the same discipline as the
// other generated remote shells — a quoting slip here is invisible to the type checker).
import type { ClaudeSessionCopyResult } from '../shared/types'
import { posixQuote } from '../shared/ssh'
import { remoteAccountConfigDirAbs } from './claude-accounts-core'
import { SESSION_ID_RE } from './transcript-reader'

/** Absolute config dir ON THE HOST: a managed remote account's, or the system `~/.claude`. */
export function remoteClaudeConfigDir(remoteHome: string, accountId: string | undefined): string {
  return accountId
    ? remoteAccountConfigDirAbs(remoteHome, accountId)
    : `${remoteHome.replace(/\/+$/, '')}/.claude`
}

export interface RemoteSessionCopyPlan {
  sessionId: string
  /** Absolute config dirs on the host (`remoteClaudeConfigDir`). */
  sourceConfigDir: string
  targetConfigDir: string
  /** A fresh UUID for the temp leaf. Independent of the target's own name, and chosen app-side so
   *  two concurrent copies can never share a temp. */
  tempId: string
}

const TEMP_ID_RE = /^[0-9a-fA-F-]{8,64}$/
const MARKER = '##COPY'

/**
 * The script, or null for an input that must never reach a shell (a malformed session or temp id,
 * a relative dir). Every interpolated value is either validated here or app-built from a validated
 * account id, and each is passed through `posixQuote` — the script body only ever references the
 * shell variables.
 *
 * Exits 0 in every branch: "no such conversation" and "diverged" are ANSWERS carried by the marker.
 * A non-zero exit or a missing marker therefore means the ssh call itself failed.
 */
export function remoteSessionCopyCommand(plan: RemoteSessionCopyPlan): string | null {
  if (!SESSION_ID_RE.test(plan.sessionId) || !TEMP_ID_RE.test(plan.tempId)) return null
  if (!plan.sourceConfigDir.startsWith('/') || !plan.targetConfigDir.startsWith('/')) return null
  const out = (what: string): string => `printf '%s %s\\n' '${MARKER}' ${what}`
  return [
    `SC=${posixQuote(plan.sourceConfigDir)}`,
    `TC=${posixQuote(plan.targetConfigDir)}`,
    `ID=${posixQuote(plan.sessionId)}`,
    `TMPLEAF=${posixQuote(`.nodeterm-${plan.tempId}.tmp`)}`,
    'S="$SC/projects"',
    'T="$TC/projects"',
    // The session's project dir is whichever one holds it (the pane may have `cd`ed since launch).
    // An unmatched glob stays literal, and `[ -f ]` rejects it.
    'src=',
    'for f in "$S"/*/"$ID.jsonl"; do [ -f "$f" ] && { src=$f; break; }; done',
    `if [ -z "$src" ]; then ${out('no-transcript')}; exit 0; fi`,
    'd=${src%/*}',
    'd=${d##*/}',
    'tgt="$T/$d/$ID.jsonl"',
    `if [ "$src" = "$tgt" ]; then ${out('identical')}; exit 0; fi`,
    `mkdir -p "$T/$d" || { ${out('failed')}; exit 0; }`,
    'st=copied',
    'if [ -e "$tgt" ]; then',
    `  ts=$(wc -c < "$tgt") && ss=$(wc -c < "$src") || { ${out('failed')}; exit 0; }`,
    // `$((…))` strips the leading blanks BSD `wc` prints.
    '  ts=$((ts)); ss=$((ss))',
    `  if [ "$ts" -gt "$ss" ]; then ${out('diverged')}; exit 0; fi`,
    `  head -c "$ts" "$src" | cmp -s - "$tgt" || { ${out('diverged')}; exit 0; }`,
    '  [ "$ts" -eq "$ss" ] && st=identical',
    'fi',
    'if [ "$st" = copied ]; then',
    '  tmp="$T/$d/$TMPLEAF"',
    `  if cp "$src" "$tmp" && mv -f "$tmp" "$tgt"; then :; else rm -f "$tmp"; ${out('failed')}; exit 0; fi`,
    'fi',
    // Sidecars: best-effort, never clobbering (`-n`), silent. The transcript is what `--resume` needs.
    '[ -d "$S/$d/$ID" ] && { mkdir -p "$T/$d/$ID" && cp -R -n "$S/$d/$ID/." "$T/$d/$ID/"; } >/dev/null 2>&1',
    '[ -d "$SC/file-history/$ID" ] && { mkdir -p "$TC/file-history/$ID" && cp -R -n "$SC/file-history/$ID/." "$TC/file-history/$ID/"; } >/dev/null 2>&1',
    out('"$st"'),
    'exit 0'
  ].join('\n')
}

/** The marker line's answer. No marker (a cut stream, a failed ssh) is `failed`, never `ok`. */
export function parseRemoteSessionCopy(stdout: string): ClaudeSessionCopyResult {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^##COPY (copied|identical|diverged|no-transcript|failed)$/.exec(lines[i].trim())
    if (!m) continue
    switch (m[1]) {
      case 'copied':
        return { ok: true, copied: true }
      case 'identical':
        return { ok: true, copied: false }
      case 'diverged':
        return { ok: false, reason: 'diverged' }
      case 'no-transcript':
        return { ok: false, reason: 'no-transcript' }
      default:
        return { ok: false, reason: 'failed' }
    }
  }
  return { ok: false, reason: 'failed' }
}
