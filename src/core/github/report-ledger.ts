/**
 * The machine-local record of what has already been reported, per project.
 *
 * MACHINE-LOCAL by construction, and that is a rule rather than a convenience: the ledger decides
 * whether a report is filed, so a git-shared copy would let a cloned repository hand a stranger's
 * machine a pre-loaded "already reported everything" ledger (silencing every gap) or an empty one
 * (re-filing all of them). It lives beside the other per-machine stores in the data directory, on
 * the same precedent as `IndexEntryV3.capabilityAck` and `trigger-arm-store`.
 *
 * Reads FAIL OPEN to an empty ledger and writes are best-effort: losing the ledger costs at most
 * one duplicate comment on an existing issue, because the authoritative dedupe is the fingerprint
 * marker in the repository itself. Refusing to report because a local cache file was unreadable
 * would be the worse failure.
 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { writeFileAtomic } from '../fs-atomic'
import { emptyLedger, type ReportLedger } from './report-issue-core'

const DIR = 'agent-reports'

/** A project id is hand-editable and arrives from a shared file, so it never becomes a path
 *  segment directly — `../../etc` is a project id a hostile `project.json` can carry. The hash is
 *  stable, collision-free in practice, and cannot escape the directory. */
function ledgerFile(dir: string, projectId: string): string {
  const key = createHash('sha256').update(projectId).digest('hex').slice(0, 32)
  return path.join(dir, DIR, `${key}.json`)
}

/** Read one field defensively: the file is JSON on disk and may be truncated, hand-edited, or from
 *  a future version. Anything unexpected reads as "no history", never as a crash. */
function parseLedger(raw: string): ReportLedger {
  try {
    const value = JSON.parse(raw) as Partial<ReportLedger>
    const seen: ReportLedger['seen'] = {}
    if (value.seen && typeof value.seen === 'object') {
      for (const [fingerprint, entry] of Object.entries(value.seen)) {
        if (!entry || typeof entry !== 'object') continue
        const { issueNumber, lastSpokeAt } = entry as { issueNumber?: unknown; lastSpokeAt?: unknown }
        if (typeof issueNumber !== 'number' || !Number.isSafeInteger(issueNumber)) continue
        if (typeof lastSpokeAt !== 'number' || !Number.isFinite(lastSpokeAt)) continue
        seen[fingerprint] = { issueNumber, lastSpokeAt }
      }
    }
    const filedAt = Array.isArray(value.filedAt)
      ? value.filedAt.filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
      : []
    return { seen, filedAt }
  } catch {
    return emptyLedger()
  }
}

export class ReportLedgerStore {
  constructor(private readonly dataDir: string) {}

  async load(projectId: string): Promise<ReportLedger> {
    try {
      return parseLedger(await fs.readFile(ledgerFile(this.dataDir, projectId), 'utf8'))
    } catch {
      return emptyLedger()
    }
  }

  async save(projectId: string, ledger: ReportLedger): Promise<void> {
    const target = ledgerFile(this.dataDir, projectId)
    await fs.mkdir(path.dirname(target), { recursive: true })
    // Atomic, like every other store here — a torn ledger would be parsed as "nothing reported"
    // and answer the next gap by filing a duplicate. Never a bare `fs.rename` (fs-atomic.guard).
    await writeFileAtomic(target, JSON.stringify(ledger), { mode: 0o600 })
  }
}
