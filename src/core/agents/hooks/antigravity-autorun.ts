// Does `cmd.exe` run an AutoRun command on this machine?
//
// `agy` runs every hook through `cmd /c` WITHOUT `/d`, so cmd.exe first executes the AutoRun
// command from the registry (`cmd /?`: "/D Disable execution of AutoRun commands from registry").
// Anything that AutoRun prints lands on the hook's stdout AHEAD of our answer — non-JSON, which agy
// 1.2.3 treats as a DENY (measured on agy 1.2.3, Windows 11, in a temporary HOME). A silent AutoRun can still hurt: a `cd` moves
// the cwd our relative command depends on (the guard then falls silent, and the badge goes dark).
// Our install is what makes agy open a cmd.exe at all, so the installer refuses to arm the hook
// while any AutoRun is set. Not reproduced on a device (that would mean writing the registry); the
// behaviour is cmd.exe's documented one.
//
// HOW IT READS. `reg query` — no PowerShell (~4× the start cost) and no native module. Three
// values, the ones cmd.exe consults: HKCU, HKLM, and the 32-bit view of HKLM.
//
// The trap is that `reg` answers exit 1 with a LOCALIZED message both for "that key does not exist"
// and for a real failure, and a missing `Command Processor` key under HKCU is the normal case (it is
// missing on the machine this was written on). So absence is never read from an error. A key that
// fails to list is judged by listing its PARENT: if the parent lists and the key is not among its
// subkeys, the key is absent — a positive answer, in key names reg does not translate. If the
// parent fails too, the same question is asked one level up; a hive root that cannot be listed is
// an unreadable registry.
//
// UNREADABLE ⇒ DO NOT INSTALL. The choice between the two safe-looking sides is not symmetric: not
// installing costs the badge; installing over an AutoRun that prints costs every tool call of every
// agy on the machine. When we cannot tell, we take the side that cannot deny a tool.
import { execFileSync } from 'child_process'

/** The three values cmd.exe reads, as `reg` spells the hives in its own output. */
export const CMD_AUTORUN_KEYS = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Command Processor',
  'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Command Processor',
  'HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Command Processor'
] as const

/** One `reg query <key>`: exit status and stdout. `status: null` = the process did not run. */
export type RegQuery = (key: string) => { status: number | null; stdout: string }

export type CmdAutoRunCheck =
  | { kind: 'clear' }
  | { kind: 'set'; entries: { key: string; value: string }[] }
  | { kind: 'unreadable'; reason: string }

/**
 * The AutoRun value in one key's `reg query` listing, or undefined when the value is absent or
 * empty. Value names are case-insensitive in the registry; the type may be REG_SZ or REG_EXPAND_SZ.
 */
export function parseAutoRunValue(listing: string): string | undefined {
  for (const line of listing.split(/\r?\n/)) {
    const m = /^\s+AutoRun\s+REG_[A-Z_]+(?:\s+(.*))?$/i.exec(line)
    if (m) {
      const value = (m[1] ?? '').trim()
      return value === '' ? undefined : value
    }
  }
  return undefined
}

/** Does a parent's `reg query` listing name `key` among its subkeys? (Exact line, any case.) */
export function listingHasSubkey(listing: string, key: string): boolean {
  const want = key.toLowerCase()
  return listing.split(/\r?\n/).some((line) => line.trim().toLowerCase() === want)
}

const parentOf = (key: string): string | null => {
  const i = key.lastIndexOf('\\')
  return i > 0 ? key.slice(0, i) : null
}

type KeyListing = { kind: 'listing'; stdout: string } | { kind: 'absent' } | { kind: 'unreadable'; reason: string }

/** List a key, telling "absent" from "failed" by asking the parent (recursively, up to the hive). */
function listKey(query: RegQuery, key: string): KeyListing {
  const r = query(key)
  if (r.status === 0) return { kind: 'listing', stdout: r.stdout }
  const parent = parentOf(key)
  if (!parent) return { kind: 'unreadable', reason: `cannot list ${key} (reg exit ${r.status})` }
  const up = listKey(query, parent)
  if (up.kind === 'absent') return up
  if (up.kind === 'unreadable') return up
  return listingHasSubkey(up.stdout, key)
    ? { kind: 'unreadable', reason: `${key} exists but could not be listed (reg exit ${r.status})` }
    : { kind: 'absent' }
}

/** Pure over the injected query: the verdict for the three AutoRun values. */
export function checkCmdAutoRun(query: RegQuery): CmdAutoRunCheck {
  const entries: { key: string; value: string }[] = []
  for (const key of CMD_AUTORUN_KEYS) {
    let listing: KeyListing
    try {
      listing = listKey(query, key)
    } catch (e) {
      return { kind: 'unreadable', reason: `reg query threw: ${String(e)}` }
    }
    if (listing.kind === 'unreadable') return listing
    if (listing.kind === 'absent') continue
    const value = parseAutoRunValue(listing.stdout)
    if (value !== undefined) entries.push({ key, value })
  }
  return entries.length ? { kind: 'set', entries } : { kind: 'clear' }
}

/** Runs one program and returns its stdout; throws like `execFileSync` on a non-zero exit. */
export type ExecFile = (file: string, args: readonly string[]) => string

const defaultExec: ExecFile = (file, args) =>
  execFileSync(file, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    windowsHide: true
  })

/**
 * The real `reg query`, READ-ONLY, over an injectable exec.
 *
 * - `reg.exe` by ABSOLUTE path under `%SystemRoot%` (or `%windir%`). With neither variable set there
 *   is no trustworthy path, and a `reg.*` planted earlier on PATH could answer "no AutoRun" — so the
 *   query does not run at all and answers `status: null`, which the checker turns into
 *   `unreadable` (= do not install).
 * - `/reg:64` on every HKLM query (parent listings included). In a 32-bit process
 *   `System32\reg.exe` is redirected to the SysWOW64 copy and plain HKLM\Software reads the 32-bit
 *   view, hiding the 64-bit AutoRun that agy's 64-bit cmd.exe actually runs. On this 64-bit machine
 *   the answers with and without the switch were byte-identical (read-only check).
 *   HKCU\Software is not redirected, so it is queried plainly.
 */
export function makeRegQuery(
  exec: ExecFile = defaultExec,
  env: Readonly<Record<string, string | undefined>> = process.env
): RegQuery {
  return (key) => {
    const root = env.SystemRoot || env.windir
    if (!root) return { status: null, stdout: '' }
    const reg = `${root}\\System32\\reg.exe`
    const args = ['query', key]
    if (/^HKEY_LOCAL_MACHINE(\\|$)/i.test(key)) args.push('/reg:64')
    try {
      return { status: 0, stdout: exec(reg, args) }
    } catch (e) {
      const err = e as { status?: number | null; stdout?: string }
      return { status: typeof err.status === 'number' ? err.status : null, stdout: err.stdout ?? '' }
    }
  }
}

export const readCmdAutoRun = (): CmdAutoRunCheck => checkCmdAutoRun(makeRegQuery())
