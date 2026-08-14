import { mkdirSync, chmodSync, existsSync, writeFileSync, renameSync, rmSync } from 'fs'
import path from 'path'
import { platform } from '../platform'
import { isSafeNodeId } from './node-auth-token'

/**
 * Distribution channel for the per-node capability: a FILE keyed by node id, read by the client at
 * hook time. Env injection (#167's channel) fails four ways here — it lands in world-readable argv
 * (the leak this series closes), it is clobbered by the endpoint-file source, it reaches a session
 * only at tmux CREATION so every running session stays unauthenticated until the node is destroyed,
 * and the phone injects env itself and cannot mint. A file fixes all four.
 *
 * It is exactly as strong as env against a same-uid sibling (nothing makes a token secret from a
 * determined sibling within one uid) and strictly stronger against everyone else.
 */
const materialised = new Set<string>()

export function nodeTokenDir(): string {
  return path.join(platform().userDataDir, 'node-tokens')
}

/**
 * tmp + rename, 0700 dir / 0600 file. Returns false (never throws) on any failure — a missing token
 * is an ordinary state (pre-upgrade session, failed remote write), never an attack, so the whole
 * series must fail OPEN here rather than crash a hook path.
 *
 * The nodeId is attacker-controlled (it comes from a shared `project.json`) AND becomes a path
 * segment, so `isSafeNodeId` — which refuses `.`/`..`/`/`/over-length — gates BEFORE any path join.
 */
export function writeNodeTokenFile(nodeId: string, token: string): boolean {
  if (!isSafeNodeId(nodeId) || !token) return false
  try {
    const dir = nodeTokenDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700) // an existing dir keeps its old mode otherwise
    const file = path.join(dir, nodeId)
    const tmp = path.join(dir, `.${nodeId}.${process.pid}.${Date.now()}.tmp`)
    try {
      writeFileSync(tmp, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(tmp, file)
      chmodSync(file, 0o600)
    } finally {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* already renamed into place */
      }
    }
    materialised.add(nodeId)
    return true
  } catch (e) {
    console.warn('[node-identity] could not materialise token for', nodeId, e)
    return false
  }
}

export function sweepNodeTokenFile(nodeId: string): void {
  materialised.delete(nodeId)
  if (!isSafeNodeId(nodeId)) return
  try {
    rmSync(path.join(nodeTokenDir(), nodeId), { force: true })
  } catch {
    /* fail open */
  }
}

/** Which nodes this run believes have a readable token. Read by the migration latch later. */
export function materialisedNodes(): ReadonlySet<string> {
  return materialised
}

/**
 * Is this node's token file BOTH written by us this run AND still on disk?
 *
 * The Set alone is a "we wrote it" cache that is never re-checked, and that is a stranding bug the
 * moment anything else touches the dir: remove `node-tokens/` while the app runs (a cleanup tool, a
 * user tidying their data dir, a sync client) and every later `refreshNodeTokens()` short-circuits,
 * writes nothing, and every live session presents an empty header — which for an already-PROVEN
 * node is a hard 403 for the rest of the run, with no path back short of a restart.
 *
 * One `existsSync` per node per persist closes it and keeps the short-circuit's whole point (which
 * was to stop a per-persist re-derive + tmp + rename + chmod storm, ~2000 syscalls on a 375-node
 * workspace). A stat is not a write.
 */
export function nodeTokenFilePresent(nodeId: string): boolean {
  if (!materialised.has(nodeId) || !isSafeNodeId(nodeId)) return false
  try {
    return existsSync(path.join(nodeTokenDir(), nodeId))
  } catch {
    return false // unreadable dir ⇒ re-assert, the fail-open direction everywhere else takes
  }
}

export function resetNodeTokenFilesForTests(): void {
  materialised.clear()
}
