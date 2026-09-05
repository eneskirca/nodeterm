/** Subscribe before requesting a snapshot, then drain live events AFTER it. A
 * late snapshot must never undo a newer finish/new-turn. Older servers without
 * the snapshot channel simply fall back to the existing live stream. */
export function subscribeWithSnapshot<T>(
  subscribe: (listener: (event: T) => void) => () => void,
  snapshot: () => Promise<T[]>,
  listener: (event: T) => void
): () => void {
  let active = true
  let pending = true
  const queue: T[] = []
  const off = subscribe((e) => {
    if (!active) return
    if (pending) queue.push(e)
    else listener(e)
  })
  const finish = (events: T[]) => {
    if (!active || !pending) return
    pending = false
    clearTimeout(timer)
    for (const event of [...events, ...queue]) {
      if (!active) break
      listener(event)
    }
    queue.length = 0
  }
  const timer = setTimeout(() => finish([]), 5000)
  void snapshot().then((events) => finish(Array.isArray(events) ? events : []), () => finish([]))
  return () => { active = false; clearTimeout(timer); queue.length = 0; off() }
}
