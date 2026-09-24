// POSIX transport for the same guarded user-settings transaction as settings-file.ts.
import { posixQuote } from '../../../shared/ssh'
import { parseSettings } from './settings-file'

type Result = { code: number; stdout: string }
export type SettingsRunner = (command: string, stdin?: string) => Promise<Result>

// macOS readlink has no -f. Resolve each link relative to its physical parent with plain
// readlink + cd -P instead; aliases then share one lock. Bound cycles and reject ambiguous
// newline paths (the read protocol uses a line header). Never create dangling link targets.
const resolveTarget = `nt_resolve() {
  nt_file=$1
  nt_links=0
  while :; do
    case "$nt_file" in *'
'*) return 1;; esac
    nt_parent=$(CDPATH= cd -P "$(dirname "$nt_file")" && pwd -P && printf '.') || return 1
    nt_parent=\${nt_parent%.}
    nt_parent=\${nt_parent%'
'}
    case "$nt_parent" in *'
'*) return 1;; esac
    nt_file="$nt_parent/$(basename "$nt_file")"
    if [ ! -L "$nt_file" ]; then break; fi
    nt_links=$((nt_links + 1))
    [ "$nt_links" -le 40 ] || return 1
    nt_link=$(readlink "$nt_file" && printf '.') || return 1
    nt_link=\${nt_link%.}
    nt_link=\${nt_link%'
'}
    case "$nt_link" in /*) nt_file=$nt_link;; *) nt_file="$nt_parent/$nt_link";; esac
  done
  [ "$nt_links" -eq 0 ] || [ -f "$nt_file" ] || return 1
}`

export async function updateRemoteSettingsFile(
  file: string,
  run: SettingsRunner,
  update: (config: Record<string, unknown>) => Record<string, unknown>
): Promise<boolean> {
  const requested = posixQuote(file)
  try {
    const read = await run(`${resolveTarget}
umask 077
mkdir -p "$(dirname ${requested})" || exit 1
nt_resolve ${requested} || exit 1
printf '%s\\n' "$nt_file"
if [ -e "$nt_file" ]; then [ -f "$nt_file" ] && cat "$nt_file"; else exit 44; fi`)
    if (read.code !== 0 && read.code !== 44) throw new Error('Remote settings read failed')
    const separator = read.stdout.indexOf('\n')
    const target = read.stdout.slice(0, separator)
    if (separator < 1 || !target.startsWith('/')) throw new Error('Remote settings target missing')
    const q = posixQuote(target)
    const lockPath = `${target}.nodeterm-lock`
    const lock = posixQuote(lockPath)
    if (read.code === 44 && read.stdout.slice(separator + 1) !== '') throw new Error('Invalid missing-file response')
    const before = read.code === 44 ? null : read.stdout.slice(separator + 1)
    const config = before === null ? {} : parseSettings(before)
    const original = JSON.stringify(config)
    const updated = update(config)
    if (before !== null && JSON.stringify(updated) === original) return false
    const next = JSON.stringify(updated, null, 2)
    // Both snapshots travel on stdin, never in argv. dd reads exactly the UTF-8 byte count;
    // cat consumes the remaining new document. No remote Python/Node/jq dependency.
    const count = Buffer.byteLength(before ?? '', 'utf8')
    const unchanged = `nt_resolve ${requested} && [ "$nt_file" = ${q} ] && ` + (before === null
      ? `[ ! -e ${q} ] && [ ! -L ${q} ]`
      : `[ ! -L ${q} ] && [ -f ${q} ] && cmp -s "$nt_stage/before" ${q}`)
    const command = `${resolveTarget}
umask 077
mkdir ${lock} 2>/dev/null || exit 73
nt_stage=''
nt_lock=${lock}
trap 'if [ -n "$nt_stage" ]; then rm -rf -- "$nt_stage"; fi; rmdir "$nt_lock"' 0
trap 'exit 1' HUP INT TERM
nt_stage=$(mktemp -d "$(dirname ${q})/.nodeterm-settings-XXXXXXXX") || exit 1
dd bs=1 count=${count} of="$nt_stage/before" 2>/dev/null || exit 1
cat > "$nt_stage/next" || exit 1
[ "$(wc -c < "$nt_stage/next")" -eq ${Buffer.byteLength(next, 'utf8')} ] || exit 1
${unchanged} || exit 1
${before === null ? ':' : `cp -p ${q} "$nt_stage/publish" || exit 1`}
cat "$nt_stage/next" > "$nt_stage/publish" || exit 1
${unchanged} || exit 1
mv -f -- "$nt_stage/publish" ${q}`
    const result = await run(command, (before ?? '') + next)
    if (result.code === 73) {
      console.warn(`[agent-hooks] Remote settings lock unavailable: ${lockPath}. Installation skipped; if it persists, stop nodeterm writers and inspect/remove the stale lock before retrying.`)
      return false
    }
    if (result.code !== 0) throw new Error('Remote settings publication failed (conflict or I/O error)')
    return true
  } catch {
    // Do not log parse errors: their messages can include private settings contents.
    console.warn(`[agent-hooks] Remote settings unchanged: ${file} (read, parse, resolution or publication failed).`)
    return false
  }
}
