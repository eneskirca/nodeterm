// The files agent integrations put into user-owned config dirs (skills), and the ownership
// receipts that let a decline remove ONLY what we wrote (issue #744).
//
// A receipt is the SHA-256 of the exact bytes we last wrote at a path. A file is ours to replace or
// remove when its current bytes match that receipt (or the body we are about to write); a file whose
// bytes match neither was edited by the user and is KEPT and reported, never overwritten or deleted.
// A path with no receipt (written by a build from before receipts) is ours by NAME — the skill dirs
// carry nodeterm's own names — so the next enabled reconcile rewrites it and records the receipt.
import { createHash } from 'crypto'
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'fs'
import path from 'path'
import { writeManagedHookFileAtomic } from './agents/hooks/install-helper'
import { mergeInstructionFile } from './agents/hooks/settings-file'
import { CANVAS_CONTROL_MARKERS } from './canvas-control-core'
import { LINKED_CONTEXT_MARKERS } from './context-link-core'

const RECEIPTS_FILE = 'integration-receipts.json'
/** Bounded: every entry is a line in Settings and a path in a log. */
export const MAX_RETAINED = 20
/** Bounded: one skill per (agent, config dir, name); a hand-edited file must not grow us forever. */
const MAX_RECEIPTS = 2000

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

interface ReceiptFile {
  version: 1
  files: Record<string, string>
}

export class ReceiptStore {
  private cache: Record<string, string> | null = null
  constructor(private readonly dir: () => string) {}

  private file(): string {
    return path.join(this.dir(), RECEIPTS_FILE)
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache
    let files: Record<string, string> = {}
    try {
      const parsed = JSON.parse(readFileSync(this.file(), 'utf8')) as Partial<ReceiptFile>
      if (parsed && typeof parsed.files === 'object' && parsed.files) {
        for (const [k, v] of Object.entries(parsed.files)) {
          if (typeof v === 'string' && /^([0-9a-f]{64}|\d{1,10} \d{1,12})$/.test(v) && (path.isAbsolute(k) || /^ssh:[^\s/]+:\//.test(k))) files[k] = v
        }
      }
    } catch {
      files = {}
    }
    this.cache = files
    return files
  }

  get(p: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(this.load(), p) ? this.load()[p] : undefined
  }

  set(p: string, hash: string | null): void {
    const files = { ...this.load() }
    if (hash === null) delete files[p]
    else files[p] = hash
    const keys = Object.keys(files)
    if (keys.length > MAX_RECEIPTS) for (const k of keys.slice(0, keys.length - MAX_RECEIPTS)) delete files[k]
    this.cache = files
    try {
      mkdirSync(this.dir(), { recursive: true })
      writeManagedHookFileAtomic(this.file(), JSON.stringify({ version: 1, files }, null, 2), undefined, 0o600)
    } catch (e) {
      console.warn('[integrations] receipt write failed', e)
    }
  }
}

/** The file at `p` if it is a plain regular file; null when nothing is there; 'not-regular' for a
 *  link, directory, FIFO or anything unreadable. ONE descriptor serves the check and the read (no
 *  stat-then-read on a path, which a swap in between could defeat). O_NOFOLLOW refuses a symlink at
 *  the name and O_NONBLOCK keeps a FIFO from hanging the open; fstat then judges what we hold.
 *  Where the platform has no O_NOFOLLOW (Windows) the open follows a link, so the name is lstat'ed
 *  AFTER the open and must be a plain file that is the very file we hold (same dev + ino, when the
 *  filesystem reports one). Same shape as `readAlertSound` in alert-sounds.ts. */
function readIfRegular(p: string): string | null | 'not-regular' {
  let fd: number
  try {
    fd = openSync(p, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return 'not-regular'
    // A dangling link is still something at the name (the open followed it on Windows).
    try {
      lstatSync(p)
      return 'not-regular'
    } catch {
      return null
    }
  }
  try {
    const st = fstatSync(fd, { bigint: true })
    if (!st.isFile()) return 'not-regular'
    const named = lstatSync(p, { bigint: true })
    if (!named.isFile() || (st.ino !== 0n && (named.dev !== st.dev || named.ino !== st.ino))) return 'not-regular'
    return readFileSync(fd, 'utf8')
  } catch {
    return 'not-regular'
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* already closed */
    }
  }
}

export type OwnedWrite = 'written' | 'unchanged' | 'retained' | 'failed'

/** Write `body` at `p` unless the file there is the user's (edited since our last write). */
export function writeOwnedFile(receipts: ReceiptStore, p: string, body: string): OwnedWrite {
  const current = readIfRegular(p)
  if (current === 'not-regular') return 'retained'
  const want = sha256(body)
  if (current !== null) {
    const have = sha256(current)
    if (have === want) {
      if (receipts.get(p) !== want) receipts.set(p, want)
      return 'unchanged'
    }
    const receipt = receipts.get(p)
    if (receipt !== undefined && receipt !== have) return 'retained'
  }
  try {
    mkdirSync(path.dirname(p), { recursive: true })
    writeManagedHookFileAtomic(p, body)
    receipts.set(p, want)
    return 'written'
  } catch (e) {
    console.warn('[integrations] write failed', p, e)
    return 'failed'
  }
}

export type OwnedRemove = 'removed' | 'absent' | 'retained' | 'failed'

/** Remove `p` only if its bytes are what we wrote; then drop its now-empty skill dir. `known`
 *  are bodies this build would write there (a pre-receipt install is recognised by them). */
export function removeOwnedFile(receipts: ReceiptStore, p: string, known: readonly string[] = []): OwnedRemove {
  const current = readIfRegular(p)
  if (current === null) {
    receipts.set(p, null)
    return 'absent'
  }
  if (current === 'not-regular') return 'retained'
  const have = sha256(current)
  const ours = receipts.get(p) === have || known.some((b) => sha256(b) === have)
  if (!ours) return 'retained'
  try {
    rmSync(p, { force: true })
    receipts.set(p, null)
    const dir = path.dirname(p)
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir)
    } catch {
      /* not empty / not ours to remove */
    }
    return 'removed'
  } catch (e) {
    console.warn('[integrations] remove failed', p, e)
    return 'failed'
  }
}

/** Remove one marker-delimited block (start through end, end searched after start) and the blank
 *  separator the merge put before it. Everything else is preserved byte for byte. */
export function stripMarkerBlock(existing: string, markers: { start: string; end: string }): string {
  const start = existing.indexOf(markers.start)
  if (start < 0) return existing
  const end = existing.indexOf(markers.end, start)
  if (end < 0) return existing
  let before = existing.slice(0, start)
  let after = existing.slice(end + markers.end.length)
  if (after.startsWith('\n')) after = after.slice(1)
  if (before.endsWith('\n\n')) before = before.slice(0, -1)
  else if (!after && before.endsWith('\n') && before.trim() === '') before = ''
  return before + after
}

/** Strip both legacy discovery blocks (canvas control, context link) from an instruction file.
 *  These were ~17 KB in ~/.codex/AGENTS.md and crowded codex's 32 KiB project-doc budget (#744);
 *  skills replaced them. Runs through the guarded transaction (link + mode kept, an unreadable file
 *  left alone, nothing written when nothing changes). */
export function stripLegacyBlocks(file: string): 'written' | 'unchanged' | 'failed' {
  const strip = (existing: string): string =>
    stripMarkerBlock(stripMarkerBlock(existing, CANVAS_CONTROL_MARKERS), LINKED_CONTEXT_MARKERS)
  // A regular file that held NOTHING but our blocks was ours (an older build created it to hold
  // them): remove it rather than leave an empty AGENTS.md behind. Re-read right before the unlink.
  const before = readIfRegular(file)
  if (before === null) return 'unchanged'
  if (before !== 'not-regular') {
    const after = strip(before)
    if (after !== before && after.trim() === '') {
      if (readIfRegular(file) !== before) return 'unchanged'
      try {
        rmSync(file, { force: true })
      } catch {
        return 'failed'
      }
      return 'written'
    }
  }
  // Everything else through the guarded transaction (link + mode kept, an unreadable file left
  // alone, nothing written when nothing changes). A linked file reduced to nothing keeps one
  // newline: the transaction never publishes an empty file, and the link is the user's.
  return mergeInstructionFile(file, (existing) => {
    const after = strip(existing)
    return after !== existing && after.trim() === '' ? '\n' : after
  })
}

/** A bounded list of paths we kept because the user changed them. */
export function pushRetained(list: string[], p: string): void {
  if (list.length < MAX_RETAINED && !list.includes(p)) list.push(p)
}
