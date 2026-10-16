// Codex's PermissionRequest, checked against the session rollout before it is shown as NEEDS YOU
// (issue #1171).
//
// WHY. `normalizeCodex` maps every `PermissionRequest` hook to `waiting`. With codex's automatic
// approval reviewer (`approvals_reviewer = "auto_review"` in config.toml) nobody is asked: codex
// fires the hook, hands the request to its own reviewer subagent, and runs (or refuses) the
// command. No hook fires again until the approved command's `PostToolUse`, so the node read NEEDS
// YOU for the review PLUS the command's whole run, with an inbox card, a push and a false alarm to
// any orchestrator watching it.
//
// MEASURED (2026-10-16, private CODEX_HOME, a local fake Responses model; codex-cli 0.156.1 under
// `codex exec` and 0.163.0 in the interactive TUI — fixture
// `src/shared/agents/__fixtures__/codex/auto-review-permission.json`):
//   - The PermissionRequest payload carries NO reviewer field (`permission_mode: "default"`), so
//     the hook alone cannot tell the two cases apart.
//   - The session rollout (the payload's `transcript_path`) has one `turn_context` record per turn,
//     written at turn start, carrying `approvals_reviewer` (`"user"` or `"auto_review"`) and a
//     `turn_id` EQUAL to the hook's own `turn_id`. It is on disk before the hook runs (the hook
//     script read it back from inside the PermissionRequest hook).
//   - `approvals_reviewer = "guardian_subagent"` in config.toml is accepted and recorded as
//     `"auto_review"`: the old name of the same reviewer, so both spellings mean the same thing.
//   - A reviewer that cannot finish (its answer was not valid JSON) REJECTS the command back to the
//     agent; it is never handed to the user. The reviewer runs in its own rollout
//     (`thread_source: "guardian_review"`), not in the main one.
//
// RULES (each a refusal; every "cannot tell" is today's behaviour, `waiting`):
//   - Closed match: only a `turn_context` whose `turn_id` equals the hook's `turn_id`, and only an
//     `approvals_reviewer` in `CODEX_AUTO_REVIEWERS`, suppresses the event. A hook with no
//     `turn_id`, a value we do not know, a path outside the codex sessions roots, a missing or
//     unreadable file, no matching record within `CODEX_ROLLOUT_SCAN_MAX_BYTES` of the end, or a
//     read slower than `confirmTimeoutMs`: the hook is published unchanged.
//   - Suppressed means NOT PUBLISHED: the node keeps the `working` its PreToolUse just set (codex
//     fires PreToolUse before PermissionRequest for the same call). Nothing is invented.
//   - The hook reply never waits: the hook server answers 204 before this gate reads anything.
//   - Per node, later hook events wait behind a confirm read (bounded by the timeout), so a
//     `waiting` published on the slow path can never land after a newer event.
//
// A REMOTE (SSH) codex node's rollout lives on its host: the local file is absent and the hook is
// published unchanged (the badge behaves as before). Lives in the hook server, so Desktop and the
// Server Edition get it from one place.
import path from 'path'
import os from 'os'
import { constants as fsc, promises as fsp } from 'fs'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import { systemCodexHome } from '../codex-accounts-core'

/** The `approvals_reviewer` values that mean "codex's own reviewer decides, no person is asked". */
export const CODEX_AUTO_REVIEWERS = ['auto_review', 'guardian_subagent'] as const

/** How far back from the end of a rollout the `turn_context` is looked for. The longest single
 *  turn across 62 real rollouts measured 5.9 MB from its `turn_context` to the next one. */
export const CODEX_ROLLOUT_SCAN_MAX_BYTES = 16 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024
const TURN_CONTEXT_MARK = Buffer.from('"type":"turn_context"')

/** True for the normalized event a codex PermissionRequest hook produces (never a child's: those
 *  normalize to null). */
export function isCodexPermissionRequest(payload: Record<string, unknown>, e: NormalizedAgentEvent | null): boolean {
  if (!e || e.kind !== 'state' || e.state !== 'waiting') return false
  const p = payload as { hook_event_name?: unknown; hookEventName?: unknown; agent_id?: unknown }
  if (p.agent_id) return false
  return (p.hook_event_name ?? p.hookEventName) === 'PermissionRequest'
}

/** The codex `sessions` roots on this machine: the system home (`$CODEX_HOME` honoured) and the
 *  managed accounts' short homes `~/.nodeterm/cx/<16 hex>`. */
export function codexSessionsRoots(): { fixed: string[]; managedRoot: string } {
  return {
    fixed: [path.join(systemCodexHome(), 'sessions')],
    managedRoot: path.join(os.homedir(), '.nodeterm', 'cx')
  }
}

/** Whether `file` is a codex rollout under one of the roots. Lexical, on a resolved path: the
 *  payload is untrusted (a forged hook POST must not aim a read anywhere else). */
export function isCodexRolloutPath(file: string, roots: { fixed: string[]; managedRoot: string }): boolean {
  if (!file || !path.isAbsolute(file)) return false
  const abs = path.resolve(file)
  if (!/^rollout-[^/\\]*\.jsonl$/.test(path.basename(abs))) return false
  for (const r of roots.fixed) if (abs.startsWith(r + path.sep)) return true
  const m = roots.managedRoot
  if (!abs.startsWith(m + path.sep)) return false
  const segs = path.relative(m, abs).split(path.sep)
  return segs.length >= 3 && /^[0-9a-f]{16}$/.test(segs[0]) && segs[1] === 'sessions'
}

/** `approvals_reviewer` of a `turn_context` line for `turnId`; `''` when that record has no string
 *  value; `null` for any other line. */
function reviewerOfLine(line: Buffer, turnId: string): string | null {
  if (line.indexOf(TURN_CONTEXT_MARK) < 0) return null
  let r: unknown
  try {
    r = JSON.parse(line.toString('utf8'))
  } catch {
    return null
  }
  const rec = r as { type?: unknown; payload?: { turn_id?: unknown; approvals_reviewer?: unknown } } | null
  if (!rec || rec.type !== 'turn_context' || !rec.payload || rec.payload.turn_id !== turnId) return null
  return typeof rec.payload.approvals_reviewer === 'string' ? rec.payload.approvals_reviewer : ''
}

/**
 * The `approvals_reviewer` of the newest `turn_context` for `turnId`, scanning the file BACKWARD
 * from its end in chunks, at most `maxBytes`. `null` when the file cannot be read or holds no such
 * record within the bound. The last component is opened with O_NOFOLLOW.
 */
export async function readRolloutReviewer(
  file: string,
  turnId: string,
  maxBytes = CODEX_ROLLOUT_SCAN_MAX_BYTES,
  chunkBytes = CHUNK_BYTES
): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    fh = await fsp.open(file, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0))
    const st = await fh.stat()
    if (!st.isFile()) return null
    let pos = st.size
    const floor = Math.max(0, st.size - maxBytes)
    // Bytes after the last newline seen so far that belong to a line not yet complete (its start
    // lies in an earlier chunk).
    let carry: Buffer = Buffer.alloc(0)
    while (pos > floor) {
      const len = Math.min(chunkBytes, pos - floor)
      pos -= len
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, pos)
      const data = carry.length ? Buffer.concat([buf, carry]) : buf
      // Complete lines are those that END inside `data` and START after a newline in `data`.
      let end = data.length
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue
        const v = reviewerOfLine(data.subarray(i + 1, end), turnId)
        if (v !== null) return v
        end = i
      }
      carry = Buffer.from(data.subarray(0, end))
      // The first line of the file has no newline before it.
      if (pos === 0) return reviewerOfLine(carry, turnId)
    }
    return null
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

export interface CodexPermissionGateDeps {
  roots: () => { fixed: string[]; managedRoot: string }
  readReviewer: (file: string, turnId: string) => Promise<string | null>
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
  /** A confirm read slower than this publishes the hook unchanged. */
  confirmTimeoutMs: number
}

export const defaultCodexPermissionGateDeps = (): CodexPermissionGateDeps => ({
  roots: codexSessionsRoots,
  readReviewer: (file, turnId) => readRolloutReviewer(file, turnId),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms)
    ;(t as { unref?: () => void }).unref?.()
    return t
  },
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  confirmTimeoutMs: 500
})

export interface CodexPermissionGate {
  /** Every codex hook event goes through here; `deliver` is the hook server's listener. */
  handle(nodeId: string, payload: Record<string, unknown>, e: NormalizedAgentEvent | null): void
  dispose(): void
}

/** Turns remembered per node: the reviewer of a turn never changes, so a second PermissionRequest
 *  in the same turn costs no read. */
const TURNS_PER_NODE = 4

export function createCodexPermissionGate(
  deliver: (e: NormalizedAgentEvent) => void,
  deps: CodexPermissionGateDeps = defaultCodexPermissionGateDeps()
): CodexPermissionGate {
  const chains = new Map<string, Promise<void>>()
  const known = new Map<string, Map<string, string>>() // nodeId → `${file}\0${turnId}` → reviewer
  let disposed = false

  let warned = false
  const safeDeliver = (e: NormalizedAgentEvent): void => {
    try {
      deliver(e)
    } catch (err) {
      if (!warned) {
        warned = true
        console.warn('[codex-permission-gate] listener threw; event dropped', err)
      }
    }
  }

  const enqueue = (nodeId: string, step: () => Promise<void> | void): void => {
    const next = (chains.get(nodeId) ?? Promise.resolve()).then(step).catch(() => {})
    chains.set(nodeId, next)
    void next.then(() => {
      if (chains.get(nodeId) === next) chains.delete(nodeId)
    })
  }

  /** The reviewer for this hook, or null when it cannot be told. */
  const reviewerFor = async (nodeId: string, payload: Record<string, unknown>): Promise<string | null> => {
    const p = payload as { transcript_path?: unknown; turn_id?: unknown }
    const file = typeof p.transcript_path === 'string' ? p.transcript_path : ''
    const turnId = typeof p.turn_id === 'string' ? p.turn_id : ''
    if (!turnId || !isCodexRolloutPath(file, deps.roots())) return null
    const key = `${path.resolve(file)}\0${turnId}`
    const cached = known.get(nodeId)?.get(key)
    if (cached !== undefined) return cached
    const v = await deps.readReviewer(path.resolve(file), turnId)
    if (v === null || disposed) return v
    let m = known.get(nodeId)
    if (!m) known.set(nodeId, (m = new Map()))
    m.delete(key)
    m.set(key, v)
    while (m.size > TURNS_PER_NODE) m.delete(m.keys().next().value as string)
    return v
  }

  return {
    handle(nodeId, payload, e) {
      if (disposed || !e || !isCodexPermissionRequest(payload, e)) {
        if (disposed) {
          if (e) safeDeliver(e)
          return
        }
        enqueue(nodeId, () => {
          if (e) safeDeliver(e)
        })
        return
      }
      enqueue(
        nodeId,
        () =>
          new Promise<void>((resolve) => {
            let settled = false
            const finish = (suppress: boolean): void => {
              if (settled) return
              settled = true
              if (!suppress) safeDeliver(e)
              resolve()
            }
            const t = deps.setTimer(() => finish(false), deps.confirmTimeoutMs)
            reviewerFor(nodeId, payload).then(
              (v) => {
                deps.clearTimer(t)
                finish(v !== null && (CODEX_AUTO_REVIEWERS as readonly string[]).includes(v))
              },
              () => {
                deps.clearTimer(t)
                finish(false)
              }
            )
          })
      )
    },
    dispose() {
      disposed = true
      known.clear()
    }
  }
}
