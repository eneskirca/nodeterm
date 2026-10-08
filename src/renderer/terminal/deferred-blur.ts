/**
 * Blur after the native mouse-leave sequence has finished. A synchronous xterm blur can repaint
 * and detach the mouseout target before the browser delivers mouseleave to its ancestors.
 *
 * Each lifecycle owner keeps its own controller and cancels it before parking or disposing a
 * terminal. Cancellation invalidates even an already-queued callback: a later owner may adopt
 * the same Terminal object. The controller stays reusable for React StrictMode effect replay.
 */
export function createDeferredBlur<T extends { blur(): void }>(current: () => T | null): {
  schedule(): void
  cancel(): void
} {
  let pending: ReturnType<typeof setTimeout> | null = null
  let generation = 0

  const cancel = () => {
    generation++
    if (pending !== null) clearTimeout(pending)
    pending = null
  }

  return {
    cancel,
    schedule() {
      cancel()
      const terminal = current()
      if (!terminal) return
      const scheduledGeneration = generation
      pending = setTimeout(() => {
        if (generation !== scheduledGeneration) return
        pending = null
        if (current() === terminal) terminal.blur()
      }, 0)
    }
  }
}
