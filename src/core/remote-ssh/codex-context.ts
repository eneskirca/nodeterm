import path from 'path'
import type { ContextWindowUsage } from '../../shared/types'
import type { SshConnection } from '../../shared/ssh'
import { posixQuote } from '../../shared/ssh'
import { SESSION_ID_RE } from '../transcript-reader'
import { isSafeRemoteHome } from '../remote-safety'
import type { ContextEnsureQuery, RemoteEnsureOutcome } from '../context-ensure'
import { remoteCodexHomeExpression, remoteCodexLoginCommand } from './codex-home'

export interface RemoteCodexContextTarget {
  conn: SshConnection
  controlPath: string
  connectionKey?: string
  remoteHome?: string
  accountId?: string
}
export interface CodexContextRef {
  conn: SshConnection
  controlPath: string
  path: string
}

/** Locate only this thread in this account. Canonicalize directories on the owning host before
 * reading; a symlinked date directory must not redirect a forged hook outside sessions. */
export function remoteCodexTranscriptCommand(
  target: RemoteCodexContextTarget, sessionId: string, hookPath?: string
): string | undefined {
  if (!SESSION_ID_RE.test(sessionId) || (hookPath !== undefined &&
      (!isSafeRemoteHome(hookPath) || path.posix.normalize(hookPath) !== hookPath))) return
  const home = remoteCodexHomeExpression(target.remoteHome, target.accountId)
  const candidate = hookPath ? posixQuote(hookPath) : `"$root"/*/*/*/rollout-*-${sessionId}.jsonl`
  return remoteCodexLoginCommand(`codex_home=${home}
root=$(cd "$codex_home/sessions" 2>/dev/null && pwd -P) || exit 1
for f in ${candidate}; do
  [ -f "$f" ] && [ ! -L "$f" ] || continue
  leaf=${'${f##*/}'}
  case "$leaf" in rollout-*-${sessionId}.jsonl) ;; *) continue ;; esac
  dir=$(cd "${'${f%/*}'}" 2>/dev/null && pwd -P) || continue
  case "$dir/" in "$root/"*) printf '%s\\n%s\\n' "$root" "$dir/$leaf"; break ;; esac
done`)
}

export function parseRemoteCodexTranscript(stdout: string, sessionId: string): string | undefined {
  const lines = stdout.trimEnd().split('\n')
  if (lines.length !== 2) return
  const [root, file] = lines
  if (!isSafeRemoteHome(root) || !isSafeRemoteHome(file) ||
      path.posix.normalize(root) !== root || path.posix.normalize(file) !== file ||
      !file.startsWith(`${root}/`) || !SESSION_ID_RE.test(sessionId) ||
      !path.posix.basename(file).startsWith('rollout-') || !file.endsWith(`-${sessionId}.jsonl`)) return
  return file
}

interface RemoteCodexContextDeps {
  /** undefined = local; null = known SSH node whose connection/home is unavailable. */
  targetFor(nodeId: string): RemoteCodexContextTarget | null | undefined
  knownAccount(accountId: string, target: RemoteCodexContextTarget): boolean
  run(target: RemoteCodexContextTarget, command: string): Promise<{ code: number; stdout: string }>
  tail: {
    track(sessionId: string, ref: CodexContextRef): void
    replay(sessionId: string): void
    untrack(sessionId: string): void
  }
  onTrack?(nodeId: string, sessionId: string, ref: CodexContextRef): void
  onClear?(nodeId: string, sessionId: string): void
}
interface Binding { key: string; sessionId: string; tailId: string; ref?: CodexContextRef; revision: number; generation: number }

/** Shared, dependency-injected SSH routing. No local reader is reachable from a remote miss.
 * Private tail keys and published node ids keep equal thread UUIDs on different hosts separate. */
export function createRemoteCodexContext(deps: RemoteCodexContextDeps) {
  const bindings = new Map<string, Binding>()
  const pending = new Map<string, Promise<RemoteEnsureOutcome>>()
  let generation = 0
  const keyFor = (target: RemoteCodexContextTarget): string => JSON.stringify(target)
  function release(nodeId: string): void {
    const old = bindings.get(nodeId)
    if (!old) return
    deps.tail.untrack(old.tailId)
    deps.onClear?.(nodeId, old.sessionId)
    bindings.delete(nodeId)
  }
  async function track(nodeId: string, sessionId: string, hookPath?: string): Promise<RemoteEnsureOutcome | null> {
    const target = deps.targetFor(nodeId)
    if (target === undefined) return null
    if (!target || !SESSION_ID_RE.test(sessionId) ||
        (target.accountId && !deps.knownAccount(target.accountId, target))) {
      release(nodeId)
      return 'unresolved'
    }
    const key = keyFor(target)
    let binding = bindings.get(nodeId)
    if (binding && (binding.key !== key || binding.sessionId !== sessionId)) {
      release(nodeId)
      binding = undefined
    }
    if (!binding) {
      binding = { key, sessionId, tailId: JSON.stringify([nodeId, sessionId]), revision: 0, generation: ++generation }
      bindings.set(nodeId, binding)
      deps.onClear?.(nodeId, sessionId)
    }
    if (hookPath && binding.ref?.path === hookPath) return 'tracked'
    const current = binding
    const pendingKey = JSON.stringify([nodeId, key, sessionId, hookPath, current.generation])
    const existing = pending.get(pendingKey)
    if (existing) return existing
    const revision = ++current.revision
    const request = Promise.resolve().then(async (): Promise<RemoteEnsureOutcome> => {
      try {
        const command = remoteCodexTranscriptCommand(target, sessionId, hookPath)
        if (!command) return 'unresolved'
        const result = await deps.run(target, command)
        const file = result.code === 0 ? parseRemoteCodexTranscript(result.stdout, sessionId) : undefined
        if (!file && !hookPath && bindings.get(nodeId) === current && current.revision === revision) release(nodeId)
        const liveTarget = deps.targetFor(nodeId)
        if (!file || bindings.get(nodeId) !== current || current.revision !== revision || !liveTarget ||
            keyFor(liveTarget) !== key || (target.accountId && !deps.knownAccount(target.accountId, target))) return 'unresolved'
        const ref = { conn: target.conn, controlPath: target.controlPath, path: file }
        if (current.ref && current.ref.path !== file) {
          deps.tail.untrack(current.tailId)
          deps.onClear?.(nodeId, sessionId)
        }
        current.ref = ref
        deps.tail.track(current.tailId, ref)
        if (!hookPath) deps.tail.replay(current.tailId)
        deps.onTrack?.(nodeId, sessionId, ref)
        return 'tracked'
      } catch {
        if (!hookPath && bindings.get(nodeId) === current && current.revision === revision) release(nodeId)
        return 'unresolved'
      } finally {
        pending.delete(pendingKey)
      }
    })
    pending.set(pendingKey, request)
    return request
  }
  return {
    publish(usage: ContextWindowUsage): ContextWindowUsage | undefined {
      for (const [nodeId, binding] of bindings) {
        if (binding.tailId !== usage.sessionId) continue
        const target = deps.targetFor(nodeId)
        if (!target || keyFor(target) !== binding.key ||
            (target.accountId && !deps.knownAccount(target.accountId, target))) { release(nodeId); return }
        return { ...usage, sessionId: binding.sessionId, nodeId }
      }
      return undefined
    },
    scopeKey(nodeId: string): string { return JSON.stringify([nodeId, deps.targetFor(nodeId)]) },
    ensure(q: ContextEnsureQuery): Promise<RemoteEnsureOutcome | null> {
      return q.nodeId ? track(q.nodeId, q.sessionId) : Promise.resolve(null)
    },
    async hook(nodeId: string, p: { session_id?: string; transcript_path?: string; agent_id?: string; hook_event_name?: string }): Promise<void> {
      // Child rollout paths belong to the child, despite carrying the parent's session id.
      if (p.agent_id) return
      if (p.hook_event_name === 'SessionEnd') { release(nodeId); return }
      if (p.session_id && p.transcript_path) await track(nodeId, p.session_id, p.transcript_path)
    },
    release
  }
}
