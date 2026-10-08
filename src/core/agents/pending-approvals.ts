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
import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import { renameAtomic, writeFileAtomic } from '../fs-atomic'
import { normalizeClaude, type NormalizedAgentEvent } from '../../shared/agents/normalize'
import { buildHookReply, HOOK_REQUEST_MAX_BYTES, type HookAnswer } from '../../shared/hook-answers'
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
 * What writing an answer did. `gone` is the hook's hold having ENDED — it deletes
 * `<pendingId>.json` when it times out (managed-script.ts) or when another surface answered — so no
 * answer can reach it any more and the interactive prompt is (or was) on screen instead. `failed` is
 * a write that could not happen. The two are different facts for a caller: one says "go to the
 * session", the other "try again" (audit A06/A35).
 */
export type PendingAnswerResult = 'sent' | 'gone' | 'failed'

/** The script appends its timestamp and PID to THIS node, not an arbitrary valid filename. */
export function pendingBelongsToNode(nodeId: string, pendingId: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(nodeId) && isValidPendingId(pendingId) &&
    pendingId.startsWith(`${nodeId}-`) && /^\d+-\d+$/.test(pendingId.slice(nodeId.length + 1))
}

/** Structured v2 answers are derived from the live request; clients never send hook output. */
export async function answerPendingHookLocal(
  nodeId: string, pendingId: string, answer: HookAnswer, homeDir: string = os.homedir()
): Promise<PendingAnswerResult> {
  if (!pendingBelongsToNode(nodeId, pendingId)) return 'failed'
  const dir = pendingDir(homeDir)
  const request = path.join(dir, `${pendingId}.json`)
  let temporary: string | undefined
  try {
    const before = await fs.promises.lstat(request)
    if (!before.isFile() || before.isSymbolicLink() || before.size > HOOK_REQUEST_MAX_BYTES) return 'failed'
    const bytes = await fs.promises.readFile(request)
    if (bytes.length > HOOK_REQUEST_MAX_BYTES) return 'failed'
    const reply = buildHookReply(JSON.parse(bytes.toString('utf8')), answer)
    if (!reply) return 'failed'
    temporary = path.join(dir, `.reply-${randomUUID()}.tmp`)
    await fs.promises.writeFile(temporary, reply, { mode: 0o600, flag: 'wx' })
    // Check AFTER the complete reply is written: a timeout during that write must not publish.
    const after = await fs.promises.lstat(request)
    if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev ||
        before.mtimeMs !== after.mtimeMs || before.size !== after.size) return 'failed'
    await renameAtomic(temporary, path.join(dir, `${pendingId}.answer`))
    return 'sent'
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'gone' : 'failed'
  } finally {
    if (temporary) await fs.promises.unlink(temporary).catch(() => {})
  }
}

/**
 * Answer a held permission hook: check its request file still exists, then write the one-line answer
 * file atomically (tmp + rename, mode 0600). The `decision` is written verbatim as the hook script
 * compares it against the literals `allow` / `deny`. Never throws.
 *
 * The existence check is what stops a late answer (the phone's usual case: the hold is 45 s) from
 * being reported — and optimistically broadcast — as delivered. A hook that times out between the
 * check and the write leaves an orphan `.answer`, which the sweep removes; closing that window fully
 * would need the hook to announce its timeout.
 */
export async function answerPendingLocal(
  pendingId: string,
  decision: 'allow' | 'deny',
  homeDir: string = os.homedir()
): Promise<PendingAnswerResult> {
  if (!isValidPendingId(pendingId)) return 'failed'
  if (decision !== 'allow' && decision !== 'deny') return 'failed'
  const dir = pendingDir(homeDir)
  try {
    await fs.promises.access(path.join(dir, `${pendingId}.json`))
  } catch (e) {
    // Only a definite ENOENT is evidence the hold ended; anything else is a failed read.
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'gone' : 'failed'
  }
  const file = path.join(dir, `${pendingId}.answer`)
  try {
    // writeFileAtomic: unique tmp + retrying rename (core/fs-atomic.ts); removes its temp on failure.
    await writeFileAtomic(file, decision, { mode: 0o600 })
    return 'sent'
  } catch {
    return 'failed'
  }
}

/**
 * Write legacy words or an upstream structured decision for a hold that still exists.
 * Content must satisfy the managed script's bound; an expired hold is never reported as sent.
 */
export async function writePendingAnswerLocal(
  pendingId: string,
  content: string,
  homeDir: string = os.homedir()
): Promise<boolean> {
  if (!isValidPendingId(pendingId)) return false
  if (typeof content !== 'string' || !isBoundedAnswerContent(content)) return false
  const dir = pendingDir(homeDir)
  const file = path.join(dir, `${pendingId}.answer`)
  try {
    await fs.promises.access(path.join(dir, `${pendingId}.json`))
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
export function localHeldPermissionIo(pendingId: string, homeDir: string = os.homedir()): HeldPermissionIo {
  return {
    readPending: () => readPendingRequestLocal(pendingId, homeDir),
    write: (content) => writePendingAnswerLocal(pendingId, content, homeDir)
  }
}
