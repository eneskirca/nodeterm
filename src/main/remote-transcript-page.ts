// The desktop's remote leg of a PAGED ⌘M transcript read, pulled out of `src/main/index.ts` so its
// one load-bearing rule is testable without booting the shell: on a failed read, forget a ref WE
// located (so Retry locates it again instead of replaying a dead path), but KEEP a hook-fed one
// (an empty read there is usually a ControlMaster blip, and dropping it would send the next read
// down the LOCAL resolver — the wrong machine).
import type { RemoteTranscriptPage, TranscriptQuery } from '../core/transcript-ipc'
import type { ChatTranscriptPage } from '../shared/chat-page'
import type { TranscriptPage } from '../core/remote-ssh/transcript-window'
import type { RemoteFileRef } from './remote-ssh/remote-file'
import { parseLocatedTranscript } from '../core/remote-transcript-locate'
import { claudeSubagentTranscriptPath } from '../shared/agents/claude-subagents'
import { SESSION_ID_RE } from '../core/transcript-reader'
import type { TranscriptPresence } from '../shared/types'

/** Remote transcript refs by sessionId, and which of them we located ourselves (vs hook-fed). */
export interface RemoteTranscriptRefCache {
  bySession: Map<string, RemoteFileRef>
  located: Set<string>
}

/** Forget `sessionId`'s ref only if WE located it. True when something was dropped. */
export function forgetLocatedRef(cache: RemoteTranscriptRefCache, sessionId: string): boolean {
  if (!cache.located.delete(sessionId)) return false
  cache.bySession.delete(sessionId)
  return true
}

/** A hook event named this session's transcript: the ref is now hook-fed. Clearing the `located`
 *  mark matters — left in place, a later failed read would drop the authoritative hook-fed ref. */
export function rememberHookRef(cache: RemoteTranscriptRefCache, sessionId: string, ref: RemoteFileRef): void {
  cache.bySession.set(sessionId, ref)
  cache.located.delete(sessionId)
}

/**
 * What a host-side locate answered. A ref; `'absent'` = the node IS remote and the host LOOKED and
 * has no such transcript (or there is no session id to look for) — a clean miss; `'unreadable'` =
 * the node IS remote and we could not ask (no master, no resolved home, a failed ssh, a path outside
 * the jail); `undefined` = not a remote session at all (take the local path).
 */
export type RemoteRefLookup = RemoteFileRef | 'absent' | 'unreadable' | undefined

/**
 * Locate a session's transcript ON the host, keeping "the host said no" apart from "we could not
 * ask". The two used to collapse into one `undefined` — correct for a reader that falls back, and
 * wrong for the ⌘M panel and the phone, which must say "no transcript" for the first and "couldn't
 * read" (a retry heals it) for the second. `locateRemoteTranscriptCommand` exits 0 on a clean miss
 * precisely so that "no transcript" is an ANSWER; this is the reader of that property.
 *
 * A hit is cached under the sessionId and marked as located by us (see `forgetLocatedRef`).
 */
export async function locateRemoteTranscriptRef<T extends { conn: RemoteFileRef['conn']; controlPath: string }>(
  q: Pick<TranscriptQuery, 'sessionId' | 'cwd' | 'accountId' | 'nodeId'>,
  deps: {
    cache: RemoteTranscriptRefCache
    /** The shell's own records say this node is remote (SSH project or live remote pty). */
    isRemote(nodeId: string): boolean
    /** The master to ask over, or undefined when there is none right now. */
    target(nodeId: string): T | undefined
    remoteHome(controlPath: string): string | undefined
    /** The locate shell line, or null when no transcript can exist for the id (malformed). */
    command(remoteHome: string, q: Pick<TranscriptQuery, 'sessionId' | 'cwd' | 'accountId'> & { sessionId: string }): string | null
    run(target: T, cmd: string): Promise<{ code: number; stdout: string }>
    isSafePath(path: string, remoteHome: string): boolean
  }
): Promise<RemoteRefLookup> {
  const remote = !!q.nodeId && deps.isRemote(q.nodeId)
  if (!q.sessionId) return remote ? 'absent' : undefined
  const cached = deps.cache.bySession.get(q.sessionId)
  if (cached) return cached
  if (!q.nodeId) return undefined
  const rt = deps.target(q.nodeId)
  // A live remote target makes the node remote whatever the records say.
  if (!rt) return remote ? 'unreadable' : undefined
  const home = deps.remoteHome(rt.controlPath)
  if (!home) return 'unreadable'
  const cmd = deps.command(home, { ...q, sessionId: q.sessionId })
  // No command = an id no transcript file can carry: nothing to find, not a failure to look.
  if (!cmd) return 'absent'
  let stdout: string
  try {
    const r = await deps.run(rt, cmd)
    if (r.code !== 0) return 'unreadable'
    stdout = r.stdout
  } catch {
    return 'unreadable'
  }
  const located = parseLocatedTranscript(stdout)
  if (!located) return 'absent'
  // Jailed exactly like a hook-supplied path: the answer crossed a machine boundary.
  if (!deps.isSafePath(located, home)) return 'unreadable'
  const ref: RemoteFileRef = { conn: rt.conn, controlPath: rt.controlPath, path: located }
  deps.cache.bySession.set(q.sessionId, ref)
  deps.cache.located.add(q.sessionId)
  return ref
}

/**
 * Does a remote node's transcript still exist ON THE HOST — from the same tri-state locate the
 * readers use, so it works for a node with no live pty too (its SSH project's master). `null` =
 * not a remote session (take the local path).
 *
 * Every lookup that cannot decide is `unknown`, never `absent`: the one caller drops a
 * `--resume <id>` on `absent`, and a dead master must not look like a deleted conversation. A
 * malformed id is `unknown` as well — the locate calls it a clean miss (no file can carry it), but
 * the local probe answers `unknown` for one, and the two legs must not disagree on what drops a
 * resume.
 */
export async function remotePresenceFromLocate(
  sessionId: string,
  locate: () => Promise<RemoteRefLookup>
): Promise<TranscriptPresence | null> {
  const r = await locate()
  if (r === undefined) return null
  if (typeof r === 'object') return 'present'
  return r === 'absent' && SESSION_ID_RE.test(sessionId) ? 'absent' : 'unknown'
}

/**
 * The desktop's remote leg of a paged chat read. With `q.subagent` it reads that Claude subagent's
 * file instead of the session's: derived from the HOST's parent path (the cached or located ref —
 * the locate is strictly by session id, never a cwd's newest) with `claudeSubagentTranscriptPath`,
 * and jailed with the same host jail the parent passed before anything is read. A child that cannot
 * be derived or is refused is a failed read (`{ok:false}`), never the parent and never this
 * machine's disk.
 */
export function createReadRemotePage(deps: {
  cache: RemoteTranscriptRefCache
  /** The session's remote ref (cached, or located on the host), or why there is none — see
   *  `RemoteRefLookup`; undefined = not a remote session. */
  refFor(q: TranscriptQuery): Promise<RemoteRefLookup>
  /** Strict ranged read (`RemoteFile.readTranscriptPage`): throws on any failure. */
  readPage(ref: RemoteFileRef, before: number | null, maxBytes: number): Promise<TranscriptPage>
  /** The host jail (`isSafeRemoteTranscriptPath` against `ref`'s remote home) for a path DERIVED
   *  from `ref` — a subagent's file. Required: a shell that forgot it must not read subagents. */
  isSafePath(path: string, ref: RemoteFileRef): boolean
}): (q: TranscriptQuery, page: ChatTranscriptPage) => Promise<RemoteTranscriptPage | null> {
  return async (q, page) => {
    const ref = await deps.refFor(q)
    if (ref === undefined) return null
    if (ref === 'absent') return { ok: false, absent: true }
    if (ref === 'unreadable') return { ok: false }
    let target = ref
    if (q.subagent) {
      const child = claudeSubagentTranscriptPath(ref.path, q.subagent.agentId)
      if (!child || !deps.isSafePath(child, ref)) return { ok: false }
      target = { ...ref, path: child }
    }
    try {
      const w = await deps.readPage(target, page.before, page.maxBytes)
      return { ok: true, data: w.data, start: w.start }
    } catch {
      if (q.sessionId) forgetLocatedRef(deps.cache, q.sessionId)
      return { ok: false }
    }
  }
}

/** Which ControlMaster a remote transcript read for `nodeId` goes over: the node's LIVE pty session
 *  when there is one (the exact master it spawned over), else its SSH PROJECT's master — an idle
 *  tab, or any node after a desktop restart, has no attached pty, and resolving only through the pty
 *  made such a node read as "not remote". `undefined` = a local node, or a project with no master. */
export function remoteTargetForNode<T extends { conn: unknown; controlPath: string }>(
  nodeId: string,
  deps: {
    live(nodeId: string): T | undefined
    projectIdFor(nodeId: string): string | undefined
    refForProject(projectId: string): T | undefined
  }
): T | undefined {
  const live = deps.live(nodeId)
  if (live) return live
  const projectId = deps.projectIdFor(nodeId)
  return projectId ? deps.refForProject(projectId) : undefined
}
