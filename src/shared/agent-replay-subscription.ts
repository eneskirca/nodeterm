import type { NormalizedAgentEvent } from './agents/normalize'

/** Subscribe first, then replay the snapshot before live events received during the request.
 * Buffer ONLY lifecycle events: alerts/input requests still arrive immediately. A failed or
 * old host must not disable live delivery. Disposal cancels the outstanding replay. */
export function subscribeAgentReplay(
  subscribe: (cb: (e: NormalizedAgentEvent) => void) => () => void,
  snapshot: () => Promise<NormalizedAgentEvent[]>,
  listener: (e: NormalizedAgentEvent) => void
): () => void {
  let waiting = true
  let disposed = false
  const pending: NormalizedAgentEvent[] = []
  const flush = (): void => {
    waiting = false
    if (!disposed) for (const e of pending) listener(e)
    pending.length = 0
  }
  const unsub = subscribe((e) => {
    if (pending.length >= 512) flush()
    if (waiting && (e.kind === 'subagent-start' || e.kind === 'subagent-end' || e.kind === 'session')) pending.push(e)
    else listener(e)
  })
  // Bound both the wait and retained queue on an unresponsive/older host.
  const timer = setTimeout(flush, 3000)
  void Promise.resolve().then(snapshot).then((events) => {
    if (disposed || !waiting) return
    if (Array.isArray(events)) for (const e of events) {
      if (e.kind === 'subagent-start') listener(e)
    }
  }).catch(() => {}).finally(() => { clearTimeout(timer); flush() })
  return () => { disposed = true; pending.length = 0; clearTimeout(timer); unsub() }
}
