// Background index of all Claude session transcripts under ~/.claude/projects AND every managed
// LOCAL account's {userData}/claude-accounts/<id>/projects. Built on launch + refreshed every 5
// min, incrementally by mtime, and persisted to userData so a relaunch doesn't cold re-scan.
// Search runs in-memory over the index. Read-only and local.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { platform } from './platform'
import type { ClaudeAccount } from '../shared/types'
import { accountConfigDir, normalizeLinkedConfigDir } from './claude-accounts-core'
import { SESSION_ID_RE } from './transcript-reader'
import {
  extractEntryFields,
  planRefresh,
  searchEntries,
  type ScanFile,
  type TranscriptIndexEntry,
  type TranscriptHit
} from './transcript-index-core'

export const TRANSCRIPT_INDEX_REFRESH_MS = 5 * 60 * 1000
const READ_CAP_BYTES = 5 * 1024 * 1024 // mirror transcript-reader: never read more than the tail

let entries: TranscriptIndexEntry[] = []
let timer: NodeJS.Timeout | undefined
let accountsGetter: (() => ClaudeAccount[]) | undefined

function indexFilePath(): string {
  return path.join(platform().userDataDir, 'transcript-index.json')
}

// Every LOCAL transcript root to index: the system default plus each managed LOCAL account's
// projects dir. Remote accounts (a `host` set) live on another host's fs → not scanned here.
function projectsRoots(): string[] {
  return accountRoots().map((r) => r.root)
}

function accountRoots(): Array<{ root: string; accountId?: string }> {
  const roots: Array<{ root: string; accountId?: string }> = [
    { root: path.join(os.homedir(), '.claude', 'projects') }
  ]
  const userData = platform().userDataDir
  for (const acct of accountsGetter?.() ?? []) {
    if (acct.host || acct.pending) continue
    try {
      // A LINKED account indexes the user's OWN dir. Re-validated here rather than
      // trusted — settings.json is hand-editable — and an unusable value falls back to the managed
      // path, which simply contributes an absent root.
      const dir = normalizeLinkedConfigDir(acct.configDir) ?? accountConfigDir(userData, acct.id)
      roots.push({ root: path.join(dir, 'projects'), accountId: acct.id })
    } catch {
      /* invalid account id → skip that root (fail-open) */
    }
  }
  return roots
}

// Walk each root's <projectDir>/<sessionId>.jsonl, returning {sessionId, path, mtime}. Fail-open
// per root (a missing/unreadable account dir just contributes nothing).
async function scanTranscripts(): Promise<ScanFile[]> {
  const out: ScanFile[] = []
  for (const root of projectsRoots()) {
    let dirs: string[]
    try {
      dirs = await fs.promises.readdir(root)
    } catch {
      continue
    }
    for (const d of dirs) {
      let files: string[]
      try {
        files = await fs.promises.readdir(path.join(root, d))
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const sessionId = f.slice(0, -'.jsonl'.length)
        if (!SESSION_ID_RE.test(sessionId)) continue
        const p = path.join(root, d, f)
        try {
          const st = await fs.promises.stat(p)
          out.push({ sessionId, transcriptPath: p, mtime: Math.floor(st.mtimeMs) })
        } catch {
          /* skip */
        }
      }
    }
  }
  return out
}

async function readTail(filePath: string): Promise<string> {
  try {
    const st = await fs.promises.stat(filePath)
    if (st.size > READ_CAP_BYTES) {
      const fd = await fs.promises.open(filePath, 'r')
      try {
        const { buffer } = await fd.read({
          position: st.size - READ_CAP_BYTES,
          length: READ_CAP_BYTES,
          buffer: Buffer.alloc(READ_CAP_BYTES)
        })
        const s = buffer.toString('utf8')
        const nl = s.indexOf('\n')
        return nl >= 0 ? s.slice(nl + 1) : s
      } finally {
        await fd.close()
      }
    }
    return await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

function loadPersisted(): TranscriptIndexEntry[] {
  try {
    const raw = fs.readFileSync(indexFilePath(), 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data) ? (data as TranscriptIndexEntry[]) : []
  } catch {
    return []
  }
}

async function persist(): Promise<void> {
  try {
    await fs.promises.writeFile(indexFilePath(), JSON.stringify(entries), 'utf8')
  } catch {
    /* best-effort */
  }
}

async function refresh(): Promise<void> {
  const scan = await scanTranscripts()
  const { toRead, keep } = planRefresh(entries, scan)
  // Only persist when the index actually changed (new/updated entries or dropped ones).
  const changed = toRead.length > 0 || keep.length !== entries.length
  const fresh: TranscriptIndexEntry[] = [...keep]
  for (const f of toRead) {
    const text = await readTail(f.transcriptPath)
    const { cwd, title, text: body } = extractEntryFields(text)
    fresh.push({
      sessionId: f.sessionId,
      transcriptPath: f.transcriptPath,
      cwd,
      mtime: f.mtime,
      title,
      text: body
    })
  }
  entries = fresh
  if (changed) await persist()
}

export function searchTranscripts(query: string): TranscriptHit[] {
  const roots = accountRoots()
  return searchEntries(entries, query, undefined, (p) =>
    roots.find((r) => p.startsWith(r.root + path.sep))?.accountId
  )
}

export function initTranscriptIndex(getAccounts?: () => ClaudeAccount[]): void {
  accountsGetter = getAccounts
  entries = loadPersisted()
  void refresh()
  timer = setInterval(() => void refresh(), TRANSCRIPT_INDEX_REFRESH_MS)
  if (timer.unref) timer.unref()
}
