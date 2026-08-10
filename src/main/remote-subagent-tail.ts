// Remote counterpart of subagent-tail.ts: tails a subagent's transcript .jsonl on a REMOTE
// host (read over the project's ControlMaster via an injected RemoteFile) and streams the
// formatted activity-log chunks over the IDENTICAL `agent:subagent-activity` IPC the local
// tail uses ({ toolUseId, chunk }) — the renderer can't tell remote from local. Reuses the
// pure formatter (formatSubagentChunk); differs only in being async (each read is an ssh
// round-trip), so it async-polls with a per-entry in-flight `reading` flag that skips a tick.
//
// Unlike the local tail, the remote transcript path is resolved by the caller (the hook raw-
// listener already learned it), so each entry is tracked directly by its RemoteFileRef.
//
// Each read is capped at SUBAGENT_READ_CAP (core's, shared with the local tail) so the first
// tick after track() can't pull a whole transcript over ssh into one string; the cap costs
// nothing, since the offset-based tail continues next tick. It goes through readFromCapped —
// a capped read lands mid-multibyte routinely, and only base64 keeps the byte accounting exact.
import { type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import { formatSubagentChunk, splitCompleteLines, SUBAGENT_READ_CAP } from '../core/subagent-tail'
import type { RemoteFile, RemoteFileRef } from './remote-ssh/remote-file'

const POLL_MS = 1000

interface Tracked {
  ref: RemoteFileRef
  offset: number
  reading: boolean
  /** Partial trailing line held back until the next read completes it (see subagent-tail.ts). */
  carry: Buffer | null
}

export interface RemoteSubagentTail {
  track(toolUseId: string, ref: RemoteFileRef | undefined): void
  untrack(toolUseId: string): void
}

export function createRemoteSubagentTail(win: BrowserWindow, remoteFile: RemoteFile): RemoteSubagentTail {
  const tracked = new Map<string, Tracked>()
  let timer: ReturnType<typeof setInterval> | null = null

  const send = (toolUseId: string, chunk: string): void => {
    if (chunk && !win.isDestroyed()) win.webContents.send(IPC.agentSubagentActivity, { toolUseId, chunk })
  }

  // One async read+stream pass. Fail-open: RemoteFile returns empty on error. The `reading`
  // flag skips overlapping ticks while a slow ssh read is in flight.
  const readOne = async (toolUseId: string, e: Tracked): Promise<void> => {
    if (e.reading) return
    e.reading = true
    try {
      const { data, newOffset } = await remoteFile.readFromCapped(e.ref, e.offset, SUBAGENT_READ_CAP)
      e.offset = newOffset
      if (data.length) {
        const read = data
        const { text: complete, carry } = splitCompleteLines(e.carry?.length ? Buffer.concat([e.carry, read]) : read)
        e.carry = carry
        const out = formatSubagentChunk(complete)
        if (out) send(toolUseId, out + '\n')
      }
    } finally {
      e.reading = false
    }
  }

  const tick = (): void => {
    for (const [toolUseId, e] of tracked) void readOne(toolUseId, e)
    if (!tracked.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    track(toolUseId, ref) {
      if (!ref || tracked.has(toolUseId)) return
      tracked.set(toolUseId, { ref, offset: 0, reading: false, carry: null })
      void readOne(toolUseId, tracked.get(toolUseId)!) // immediate first read
      if (!timer) timer = setInterval(tick, POLL_MS)
    },
    untrack(toolUseId) {
      const e = tracked.get(toolUseId)
      tracked.delete(toolUseId)
      // The transcript is complete on untrack — a held-back carry is a final line missing
      // only its trailing newline; flush instead of dropping it.
      if (e?.carry?.length) {
        const out = formatSubagentChunk(e.carry.toString('utf-8'))
        e.carry = null
        if (out) send(toolUseId, out + '\n')
      }
      if (!tracked.size && timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}
