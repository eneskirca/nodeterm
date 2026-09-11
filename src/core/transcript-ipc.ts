// The two transcript READ channels — the ⌘M chat view (`chat:read-transcript`) and the find-bar's
// full-transcript index (`claude:read-transcript`) — registered through the CorePlatform seam so
// BOTH shells serve them.
//
// This lived inline in `src/main/index.ts`, which is exactly the failure mode the seam exists to
// prevent: the Server Edition had no handler at all, its bridge stub rejected, and the chat panel
// (which never caught the rejection) presented every browser session as an empty conversation.
//
// The remote (SSH-project) leg stays an injected dep: it needs a ControlMaster, which only the
// Electron shell has. Absent deps ⇒ local-only, which is the correct and complete answer on the
// server — it runs ON the host whose transcripts it is reading.
import fsp from 'node:fs/promises'
import { IPC } from '../shared/ipc'
import type { ChatTranscriptResult, TranscriptLine, TranscriptPresence } from '../shared/types'
import { platform } from './platform'
import { chatMessagesFromGrok } from './grok-chat'
import { locateGrok } from './handoff/locate'
import {
  parseChatMessages,
  parseTranscriptLines,
  readCappedTail,
  readChatMessages,
  readTranscriptLines,
  resolveTranscriptPath,
  transcriptPresence,
  transcriptPathForCwd,
  SESSION_ID_RE
} from './transcript-reader'

/** What a read is asked for. `nodeId` is only meaningful to the remote leg. */
export interface TranscriptQuery {
  sessionId: string | undefined
  cwd: string | undefined
  accountId: string | undefined
  nodeId: string | undefined
}

export interface TranscriptIpcDeps {
  /** Transcript path a live context tail already knows for this session (hook-fed — authoritative
   *  when present). Optional: the sessionId scan below finds any transcript in a standard root. */
  pathFor?(sessionId: string): string | undefined
  /**
   * Tail text of a REMOTE node's transcript, or null when this is not a remote session (or it
   * could not be resolved). Electron-only — the server has no SSH-project manager.
   */
  readRemote?(q: TranscriptQuery): Promise<string | null>
  /**
   * Does the transcript exist on the HOST — or `null` when this is not a remote session, which is
   * the signal to take the local path below. Same `null` convention as `readRemote`.
   *
   * It must return `'unknown'` (not `null`) for a remote session it failed to ask, or the local
   * resolver would run against THIS machine's disk for a session that only ever existed on the
   * host and report `absent` — the one answer that destroys a resume. Electron-only.
   */
  remoteExists?(q: TranscriptQuery): Promise<TranscriptPresence | null>
}

/**
 * Resolve a session's transcript path: the exact session file when a (valid) sessionId is known,
 * else the node's cwd — durable, and needing no live hook event. `accountId` scopes BOTH legs to
 * the same root: dropping it on the fallback sent a managed-account node to the system root, where
 * it found nothing or adopted an unrelated session's newest transcript.
 */
export async function resolveTranscript(
  q: Pick<TranscriptQuery, 'sessionId' | 'cwd' | 'accountId'>,
  pathFor?: (sessionId: string) => string | undefined
): Promise<string | undefined> {
  let p: string | undefined
  if (q.sessionId && SESSION_ID_RE.test(q.sessionId)) {
    p = pathFor?.(q.sessionId) ?? (await resolveTranscriptPath(q.sessionId, q.accountId))
  }
  if (!p && q.cwd) p = await transcriptPathForCwd(q.cwd, q.accountId)
  return p
}

export function registerTranscriptIpc(deps: TranscriptIpcDeps = {}): void {
  const remoteText = (q: TranscriptQuery): Promise<string | null> =>
    deps.readRemote ? deps.readRemote(q) : Promise.resolve(null)

  platform().handle(
    IPC.claudeReadTranscript,
    async (
      sessionId: string | undefined,
      cwd: string | undefined,
      accountId: string | undefined,
      nodeId: string | undefined
    ): Promise<TranscriptLine[]> => {
      const remote = await remoteText({ sessionId, cwd, accountId, nodeId })
      if (remote !== null) return parseTranscriptLines(remote)
      const p = await resolveTranscript({ sessionId, cwd, accountId }, deps.pathFor)
      return p ? readTranscriptLines(p) : []
    }
  )

  platform().handle(
    IPC.transcriptExists,
    async (
      sessionId: string | undefined,
      accountId: string | undefined,
      nodeId: string | undefined
    ): Promise<TranscriptPresence> => {
      if (!sessionId) return 'unknown'
      // Remote first, and its `'unknown'` is TERMINAL. Falling through to the local resolver for
      // a remote session whose host we could not reach would search this machine for a file that
      // only ever existed on the other one, and answer `absent` about it.
      const remote = deps.remoteExists ? await deps.remoteExists({ sessionId, cwd: undefined, accountId, nodeId }) : null
      if (remote !== null) return remote
      // A live context tail's own path is the authoritative hint — but it is a HINT, so it is
      // verified rather than trusted: the file it names can have been deleted since.
      const hinted = deps.pathFor?.(sessionId)
      if (hinted) {
        try {
          await fsp.access(hinted)
          return 'present'
        } catch {
          /* fall through to the scan */
        }
      }
      return transcriptPresence(sessionId, accountId)
    }
  )

  platform().handle(
    IPC.chatReadTranscript,
    async (
      sessionId: string | undefined,
      cwd: string | undefined,
      accountId: string | undefined,
      nodeId: string | undefined,
      agentId: string | undefined
    ): Promise<ChatTranscriptResult> => {
      // Routed by agent BEFORE anything claude-shaped runs. `resolveTranscript` below falls back to
      // the newest claude transcript for the cwd when its sessionId leg misses, and a grok id always
      // misses — so reaching that fallback with a grok node would answer with a stranger's
      // conversation. The remote leg is claude-only too (its reader tails claude's file), so a grok
      // node is served locally or not at all rather than being handed the wrong host's claude log.
      if (agentId === 'grok') {
        const gp = sessionId ? await locateGrok(sessionId) : undefined
        if (!gp) return { messages: [], found: false }
        const buf = await readCappedTail(gp)
        return buf === undefined
          ? { messages: [], found: false }
          : { messages: chatMessagesFromGrok(buf), found: true }
      }
      const remote = await remoteText({ sessionId, cwd, accountId, nodeId })
      // A resolved-but-unreadable remote file is NOT "no conversation yet" — the read failed
      // (master down, transcript gone), and the panel must be able to say so.
      if (remote !== null) return { messages: parseChatMessages(remote.split('\n')), found: !!remote }
      const p = await resolveTranscript({ sessionId, cwd, accountId }, deps.pathFor)
      return p
        ? { messages: await readChatMessages(p), found: true }
        : { messages: [], found: false }
    }
  )
}
