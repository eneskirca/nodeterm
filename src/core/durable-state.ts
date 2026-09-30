// Orchestration facts that must outlive the process that learned them.
//
// WHY THIS EXISTS. Four facts a canvas-control orchestration leans on lived only in process
// memory, so an app (or Server Edition) restart erased them while the thing they described kept
// going:
//   - a `send` answered `queued` (the sender was told it would be delivered) was silently lost;
//   - a station's `report-outcome` vanished, so every `--after-success` dependent read BLOCKED;
//   - the `--request-id` ledger emptied, so a retry after a restart re-ran an open that happened;
//   - the plain-`--after` hand-over hold was forgotten, so a dependent fired on a stale `done`.
// Each owner keeps its own rules (what a restart MEANS for that fact is decided next to the fact —
// delivery-queue.ts, station-outcome-store.ts, station-handover.ts, control-request-ledger.ts);
// this module is only the storage all of them share, so a new fact is one more `DurableFactSpec`,
// not another copy of the read / sanitize / write / flush dance.
//
// THE RULES, each for a reason:
//   - One file per fact kind under `<userData>/orchestration-state/`, MACHINE-LOCAL. Never
//     `.nodeterm/project.json` (git-shared): a queued message body, a station's verdict and the
//     replies of control calls are one machine's run state, and a clone must not inherit them.
//   - An envelope `{kind, version, savedAt, records}`. A file whose `kind` or `version` this build
//     does not know is IGNORED (start empty, warn) rather than guessed at; a newer build's file is
//     overwritten at the next save — the facts are short-lived (minutes to a day), so losing them on
//     a downgrade is the right price for never misreading one.
//   - The file is hand-editable input: every record is re-checked by the fact's own `sanitize`
//     on READ, a record that fails is DROPPED (never repaired), and the list is capped. A file that
//     is not JSON, too large, or not an envelope is set aside as `<file>.corrupt` (one copy, replaced
//     each time) and the fact starts empty with a warning. Loading NEVER throws: a boot that dies on
//     a bad orchestration file would take the whole app with it.
//   - Written as a unique `wx` temp then `renameAtomicSync` — never a bare rename, see
//     fs-atomic.ts. Mode 0600: a queued message's body is the user's text.
//   - A synchronous flush (quit) is never overwritten by an OLDER async write still in flight: it
//     bumps a generation, and the async path checks the generation and renames in one synchronous
//     step, dropping its temp when it is stale.
//   - Every OWNER must keep its serialized file under `DURABLE_STATE_MAX_BYTES` — a file past it is
//     set aside WHOLE at load. The queue and the ledger enforce a byte budget on what they write
//     (bodies / replies past it are written in their refusal-safe reduced form).
//   - `standDown()` for a process that does not own the fact (a second instance on the same
//     userData that lost the hook endpoint): it neither reads nor writes the file.
//   - Saves are COALESCED (`debounceMs`, a short window — every control call can touch the
//     ledger), at most one write in flight, and the LATEST snapshot always wins. `flushSync` writes
//     whatever is pending before the process exits; a crash inside the window loses that window,
//     which the owners state for their fact.
//
// Pure `src/core`: no electron. The clock and the timer are injectable so tests drive it.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promises as fsp } from 'node:fs'
import { renameAtomicSync, tempNameFor } from './fs-atomic'

/** Where every durable orchestration fact lives, relative to userData. */
export const DURABLE_STATE_DIR = 'orchestration-state'

/** A file larger than this is set aside at load. Every owner budgets its writes below it. */
export const DURABLE_STATE_MAX_BYTES = 16 * 1024 * 1024

/** How long saves are coalesced. Short: a claimed request-id row should reach disk before the call
 *  it guards has had time to do anything visible. */
export const DURABLE_STATE_DEBOUNCE_MS = 50

/** One fact kind: its file name, its schema version, its record sanitizer and its bound. */
export interface DurableFactSpec<T> {
  /** File stem and envelope `kind`. `[a-z0-9-]+`. */
  kind: string
  version: number
  /** The most records a file may carry; a longer list keeps its LAST `maxRecords`. */
  maxRecords: number
  /** Re-check one record read from disk. `null` drops it. Must not throw (a throw drops it too). */
  sanitize(raw: unknown): T | null
}

export interface DurableFactOptions {
  /** `<userData>`; the file is `<userDataDir>/orchestration-state/<kind>.json`. */
  userDataDir: string
  debounceMs?: number
  /** Where warnings go. Defaults to `console.warn`. */
  warn?(message: string): void
  now?(): number
  schedule?(ms: number, fn: () => void): () => void
}

interface Envelope {
  kind: string
  version: number
  savedAt: number
  records: unknown[]
}

/** Every live file, so a shell's quit path can flush them all without holding each one. */
const liveFiles = new Set<{ flushSync(): void }>()

/** Write everything any durable fact still has pending, synchronously. Each shell's final quit step
 *  calls it (desktop: the second `before-quit` pass; Server Edition: `close()`). Never throws. */
export function flushAllDurableFactsSync(): void {
  for (const f of [...liveFiles]) f.flushSync()
}

export class DurableFactFile<T> {
  readonly path: string
  private readonly warn: (m: string) => void
  private readonly now: () => number
  private readonly schedule: (ms: number, fn: () => void) => () => void
  private readonly debounceMs: number
  /** The latest snapshot not yet written, or `null` when disk is current. */
  private pending: T[] | null = null
  private cancelTimer: (() => void) | null = null
  private writing: Promise<void> | null = null
  private disposed = false
  /** Bumped by every synchronous flush; an async write started before it drops its rename. */
  private generation = 0
  private stoodDown = false

  constructor(
    private readonly spec: DurableFactSpec<T>,
    opts: DurableFactOptions
  ) {
    if (!/^[a-z0-9-]+$/.test(spec.kind)) throw new Error(`durable fact kind ${spec.kind} is not [a-z0-9-]+`)
    this.path = join(opts.userDataDir, DURABLE_STATE_DIR, `${spec.kind}.json`)
    this.warn = opts.warn ?? ((m): void => console.warn(m))
    this.now = opts.now ?? Date.now
    this.debounceMs = opts.debounceMs ?? DURABLE_STATE_DEBOUNCE_MS
    this.schedule =
      opts.schedule ??
      ((ms, fn): (() => void) => {
        const t = setTimeout(fn, ms)
        // Never hold the process open for a save; `flushSync` at shutdown writes what is pending.
        t.unref?.()
        return () => clearTimeout(t)
      })
    liveFiles.add(this)
  }

  /** Read and sanitize the file. Synchronous (boot), never throws; absent ⇒ `[]` silently. */
  load(): T[] {
    if (this.stoodDown) return []
    let text: string
    let fd: number | undefined
    try {
      // Stat and read the SAME open file, so what was checked is what is read.
      fd = openSync(this.path, 'r')
      const st = fstatSync(fd)
      if (!st.isFile() || st.size > DURABLE_STATE_MAX_BYTES) {
        closeSync(fd)
        fd = undefined
        this.setAside(`not a regular file under ${DURABLE_STATE_MAX_BYTES} bytes`)
        return []
      }
      text = readFileSync(fd, 'utf-8')
      if (text.length > DURABLE_STATE_MAX_BYTES) {
        closeSync(fd)
        fd = undefined
        this.setAside(`not a regular file under ${DURABLE_STATE_MAX_BYTES} bytes`)
        return []
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT')
        this.warn(`[durable-state] ${this.spec.kind}: could not read ${this.path} (${String(e)}); starting empty`)
      return []
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.setAside('not JSON')
      return []
    }
    const env = parsed as Partial<Envelope> | null
    if (!env || typeof env !== 'object' || !Array.isArray(env.records)) {
      this.setAside('not an envelope')
      return []
    }
    if (env.kind !== this.spec.kind || env.version !== this.spec.version) {
      this.warn(
        `[durable-state] ${this.spec.kind}: ignoring ${this.path} (kind ${String(env.kind)}, version ` +
          `${String(env.version)}; this build reads version ${this.spec.version}); starting empty`
      )
      return []
    }
    const out: T[] = []
    let dropped = 0
    for (const raw of env.records) {
      let rec: T | null = null
      try {
        rec = this.spec.sanitize(raw)
      } catch {
        rec = null
      }
      if (rec === null) dropped++
      else out.push(rec)
    }
    if (dropped > 0) this.warn(`[durable-state] ${this.spec.kind}: dropped ${dropped} malformed record(s)`)
    return out.length > this.spec.maxRecords ? out.slice(out.length - this.spec.maxRecords) : out
  }

  /** Schedule a write of `records` (the WHOLE current list, never a delta). */
  save(records: readonly T[]): void {
    if (this.disposed) return
    this.pending = records.slice(-this.spec.maxRecords)
    if (this.cancelTimer) return
    this.cancelTimer = this.schedule(this.debounceMs, () => {
      this.cancelTimer = null
      void this.writeNow()
    })
  }

  /** Resolves once everything saved so far is on disk (or failed and was warned about). */
  async flush(): Promise<void> {
    if (this.cancelTimer) {
      this.cancelTimer()
      this.cancelTimer = null
    }
    await this.writeNow()
    while (this.writing) await this.writing
  }

  /** Write what is pending, synchronously — the quit path, where an awaited write races exit. */
  flushSync(): void {
    if (this.cancelTimer) {
      this.cancelTimer()
      this.cancelTimer = null
    }
    const snap = this.pending
    if (!snap) return
    this.pending = null
    // Any async write still in flight carries an OLDER snapshot: it must not rename over this one.
    this.generation++
    try {
      this.ensureDir()
      const tmp = tempNameFor(this.path)
      try {
        writeFileSync(tmp, this.serialize(snap), { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
        renameAtomicSync(tmp, this.path)
      } catch (e) {
        rmSync(tmp, { force: true })
        throw e
      }
    } catch (e) {
      this.warn(`[durable-state] ${this.spec.kind}: final save failed (${String(e)})`)
    }
  }

  /**
   * This process does not own the fact (a second instance on the same userData that lost the hook
   * endpoint to the first): never read or write the file again. `load()` answers `[]` from here on,
   * so it neither restores (and expires) messages the owning instance holds nor overwrites its file.
   */
  standDown(): void {
    if (this.cancelTimer) {
      this.cancelTimer()
      this.cancelTimer = null
    }
    this.pending = null
    this.disposed = true
    this.stoodDown = true
    this.generation++
    liveFiles.delete(this)
  }

  /** Stop accepting saves after flushing (shutdown). */
  dispose(): void {
    this.flushSync()
    this.disposed = true
    liveFiles.delete(this)
  }

  private async writeNow(): Promise<void> {
    // One write at a time; a snapshot that arrives meanwhile is written right after.
    while (this.writing) await this.writing
    const snap = this.pending
    if (!snap) return
    this.pending = null
    const generation = this.generation
    this.writing = (async (): Promise<void> => {
      const tmp = tempNameFor(this.path)
      try {
        this.ensureDir()
        // Same shape as `writeFileAtomic` (unique `wx` temp, then the retrying rename), split so the
        // generation check and the rename happen in ONE synchronous step: a `flushSync` that ran
        // while the temp was being written has put a NEWER snapshot on disk, and this older one
        // must not land on top of it. Checked and renamed with nothing able to run in between.
        await fsp.writeFile(tmp, this.serialize(snap), { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
        if (generation !== this.generation) {
          rmSync(tmp, { force: true })
          return
        }
        renameAtomicSync(tmp, this.path)
      } catch (e) {
        rmSync(tmp, { force: true })
        this.warn(`[durable-state] ${this.spec.kind}: save failed (${String(e)})`)
      }
    })()
    try {
      await this.writing
    } finally {
      this.writing = null
    }
    if (this.pending && !this.cancelTimer) await this.writeNow()
  }

  private serialize(records: readonly T[]): string {
    const env: Envelope = {
      kind: this.spec.kind,
      version: this.spec.version,
      savedAt: this.now(),
      records: records as unknown[]
    }
    return JSON.stringify(env)
  }

  private ensureDir(): void {
    mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 })
  }

  /** Keep ONE copy of an unreadable file for inspection, then start empty. */
  private setAside(why: string): void {
    const aside = `${this.path}.corrupt`
    try {
      rmSync(aside, { force: true, recursive: true })
      renameAtomicSync(this.path, aside)
    } catch {
      /* keep going: the next save replaces the file anyway */
    }
    this.warn(`[durable-state] ${this.spec.kind}: ${this.path} is ${why}; set aside as ${aside}, starting empty`)
  }
}

// ── Small shared sanitizer helpers (every fact re-checks its records with these) ──────────────

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** A string of at most `max` UTF-16 units. */
export function isBoundedString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max
}
