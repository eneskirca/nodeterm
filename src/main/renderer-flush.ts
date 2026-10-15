// Ask the renderer to write its pending canvas edits before the app goes away.
//
// Canvas saves are debounced (SAVE_DEBOUNCE_MS), and nothing flushed them on the way out, so a node
// move / resize / rename / camera change in the last moments before a quit or a restart-to-update was
// lost. Main sends a request id; the renderer persists (when dirty and no conflict bar is up) and
// answers with the same id. The wait is capped and this NEVER throws or rejects: a wedged or absent
// renderer must never be able to block a quit or an update install.
//
// On macOS `quitAndInstall()` closes every window BEFORE `before-quit` runs, so the restart path has
// to flush before it calls quitAndInstall — a flush only in before-quit would find no renderer.
import { IPC } from '../shared/ipc'

export type FlushOutcome = 'flushed' | 'timeout' | 'no-window'

/** The slice of WebContents this needs (`isDestroyed` optional: `getMainWindow()` already drops a
 *  destroyed window, and its structural webContents type does not carry the method). */
export interface FlushTarget {
  isDestroyed?(): boolean
  send(channel: string, ...args: unknown[]): void
}

/** The slice of ipcMain this needs. */
export interface FlushIpc {
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

export const RENDERER_FLUSH_TIMEOUT_MS = 1000

let seq = 0

export function requestRendererFlush(
  target: FlushTarget | null | undefined,
  ipc: FlushIpc,
  timeoutMs = RENDERER_FLUSH_TIMEOUT_MS
): Promise<FlushOutcome> {
  return new Promise<FlushOutcome>((resolve) => {
    let alive = false
    try {
      alive = !!target && !target.isDestroyed?.()
    } catch {
      alive = false
    }
    if (!target || !alive) {
      resolve('no-window')
      return
    }
    const id = `flush-${++seq}`
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (outcome: FlushOutcome): void => {
      if (timer) clearTimeout(timer)
      ipc.removeListener(IPC.appFlushDone, onDone)
      resolve(outcome)
    }
    // A reply for another (stale, timed-out) request is ignored — only ours settles this one.
    const onDone = (_e: unknown, replyId?: unknown): void => {
      if (replyId === id) finish('flushed')
    }
    ipc.on(IPC.appFlushDone, onDone)
    timer = setTimeout(() => finish('timeout'), timeoutMs)
    try {
      target.send(IPC.appFlushRequest, id)
    } catch {
      finish('no-window')
    }
  })
}
