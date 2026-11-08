// Deterministic hook-reply approvals — the answer-file side (docs/hook-reply-approvals.md).
//
// The managed permission hook (managed-script.ts) holds an incoming PermissionRequest open and
// polls `<home>/.nodeterm/pending/<pendingId>.answer` for a one-line `allow` | `deny`. This module
// writes that answer file (LOCAL fs — the host the agent runs on for a local project) and sweeps
// stale request files left by killed/timed-out sessions.
//
// Electron-free (fs/path/os only), so both shells boot it. Every function fails soft: an invalid
// pendingId or an fs error resolves false / logs, never throws.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeFileAtomic } from '../fs-atomic'
import { normalizeClaude, type NormalizedAgentEvent } from '../../shared/agents/normalize'
import { isBoundedAnswerContent, PENDING_REQUEST_MAX_BYTES, type HeldPermissionIo } from './permission-decision'

/** pendingId shape the script generates (`<node>-<ms>-<pid>`) and the ONLY thing we interpolate
 *  into a filename. Validated everywhere a pendingId becomes a path so a forged value can't
 *  traverse (`../`) or inject. Keep in sync with the managed script's `tr -c 'A-Za-z0-9_-'`. */
export const PENDING_ID_RE = /^[A-Za-z0-9_-]+$/

/** How old a request (`.json`) / answer (`.answer`) file may get before the sweeper removes it. */
export const PENDING_MAX_AGE_MS = 10 * 60_000
/** Sweep cadence (boot + this interval). */
export const PENDING_SWEEP_INTERVAL_MS = 60 * 60_000

export function isValidPendingId(pendingId: string): boolean {
  return typeof pendingId === 'string' && pendingId.length > 0 && pendingId.length <= 256 && PENDING_ID_RE.test(pendingId)
}

/** `<home>/.nodeterm/pending`. `homeDir` is injected so tests never touch the real home. */
export function pendingDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.nodeterm', 'pending')
}

/**
 * Write the answer file for a held permission hook, atomically (tmp + rename, mode 0600).
 * Resolves true on success, false on an invalid pendingId, content the hook script would not
 * print (`isBoundedAnswerContent` — the legacy words, or a core-built JSON decision), or any fs
 * error (fail-open — the hook simply times out to the interactive prompt).
 */
export async function writePendingAnswerLocal(
  pendingId: string,
  content: string,
  homeDir: string = os.homedir(),
  // What the hook that polls this file would print. The PR write gate passes its own (@shared/pr-write-hook).
  bounded: (content: string) => boolean = isBoundedAnswerContent
): Promise<boolean> {
  if (!isValidPendingId(pendingId)) return false
  if (typeof content !== 'string' || !bounded(content)) return false
  const dir = pendingDir(homeDir)
  const file = path.join(dir, `${pendingId}.answer`)
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    // writeFileAtomic: unique tmp + retrying rename (core/fs-atomic.ts); removes its temp on failure.
    await writeFileAtomic(file, content, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Read the request file the held hook wrote (`<pendingId>.json` — the raw PermissionRequest
 * payload). This is the SOURCE OF TRUTH a structured answer is validated against. Null when the
 * file is missing (the hold ended: answered, timed out, or swept), over-long, or unreadable.
 */
export async function readPendingRequestLocal(
  pendingId: string,
  homeDir: string = os.homedir()
): Promise<string | null> {
  if (!isValidPendingId(pendingId)) return null
  const file = path.join(pendingDir(homeDir), `${pendingId}.json`)
  // ONE file descriptor for the check and the read (no stat-then-read on a path, which a swap in
  // between could defeat). O_NOFOLLOW refuses a symlink planted at the name; where the platform has
  // no such flag (Windows) it is 0 and the isFile() check on the opened handle still applies.
  let fh: fs.promises.FileHandle | undefined
  try {
    fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const st = await fh.stat()
    if (!st.isFile() || st.size > PENDING_REQUEST_MAX_BYTES) return null
    // Read at most one byte past the cap from the SAME handle: a file that grew after the fstat is
    // still refused rather than slurped.
    const buf = Buffer.alloc(PENDING_REQUEST_MAX_BYTES + 1)
    let total = 0
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > PENDING_REQUEST_MAX_BYTES) return null
    return buf.subarray(0, total).toString('utf8')
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * Build the synthetic "answered" agent event the managed hook's second POST would produce, so a
 * caller that just wrote the answer file (the desktop Approve/Deny handler) can OPTIMISTICALLY flip
 * the badge to working before that POST round-trips. Goes through the same `normalizeClaude` path the
 * hook server uses, so its shape is identical — the later hook POST is an idempotent duplicate
 * (a same-state working re-assert is a no-op in the mirror + renderer store). Threads the pendingId
 * so the open approval resolves. Claude-only (PermissionRequest is a Claude concept). Returns null on
 * an invalid decision. See docs/hook-reply-approvals.md.
 */
export function syntheticAnsweredEvent(
  nodeId: string,
  pendingId: string,
  decision: 'allow' | 'deny'
): NormalizedAgentEvent | null {
  if (decision !== 'allow' && decision !== 'deny') return null
  return normalizeClaude({
    nodeId,
    agentId: 'claude',
    payload: { nodeterm_answered: decision, nodeterm_pending_id: pendingId }
  })
}

/**
 * Remove `.json` / `.answer` files under the pending dir older than `maxAgeMs` (orphans from killed
 * or timed-out sessions). Returns the count removed. Best-effort — a missing dir or unreadable
 * entry is silently skipped. Pure w.r.t. its `now`/`homeDir` inputs for testing.
 */
export async function sweepPendingDir(
  now: number = Date.now(),
  maxAgeMs: number = PENDING_MAX_AGE_MS,
  homeDir: string = os.homedir()
): Promise<number> {
  const dir = pendingDir(homeDir)
  let removed = 0
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return 0 // no dir yet / unreadable
  }
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.answer')) continue
    const p = path.join(dir, name)
    try {
      const st = await fs.promises.stat(p)
      if (now - st.mtimeMs > maxAgeMs) {
        await fs.promises.rm(p, { force: true })
        removed++
      }
    } catch {
      // Raced deletion / stat error: skip.
    }
  }
  return removed
}

export interface PendingSweeperHandle {
  stop(): void
}

/**
 * Start the pending-dir sweeper: one sweep now, then every `intervalMs`. The interval is unref'd so
 * it never keeps the process alive. Wired once per shell on boot.
 */
export function startPendingSweep(
  homeDir: string = os.homedir(),
  intervalMs: number = PENDING_SWEEP_INTERVAL_MS
): PendingSweeperHandle {
  void sweepPendingDir(Date.now(), PENDING_MAX_AGE_MS, homeDir).catch(() => {})
  const timer = setInterval(() => {
    void sweepPendingDir(Date.now(), PENDING_MAX_AGE_MS, homeDir).catch(() => {})
  }, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}

/** The local-fs I/O pair for `answerHeldPermission` (the host the agent runs on IS this machine). */
export function localHeldPermissionIo(
  pendingId: string,
  homeDir: string = os.homedir(),
  bounded: (content: string) => boolean = isBoundedAnswerContent
): HeldPermissionIo {
  return {
    readPending: () => readPendingRequestLocal(pendingId, homeDir),
    write: (content) => writePendingAnswerLocal(pendingId, content, homeDir, bounded)
  }
}
