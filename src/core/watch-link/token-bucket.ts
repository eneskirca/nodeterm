// A per-viewer byte budget: a live link must not turn a flooding terminal into unbounded relay
// traffic. Past it, the viewer gets at most one keyframe per second instead of the stream.
export interface TokenBucket {
  take(n: number): boolean
}

export function createTokenBucket(o: { ratePerSec: number; burst: number; now: () => number }): TokenBucket {
  let tokens = o.burst
  let last = o.now()
  return {
    take(n) {
      const t = o.now()
      // `now` may be a wall clock (Date.now), which can step back: a negative interval would drain
      // the bucket for as long as the step, so it counts as none and the refill resumes from `t`.
      tokens = Math.min(o.burst, tokens + (Math.max(0, t - last) / 1000) * o.ratePerSec)
      last = t
      if (n > tokens) return false
      tokens -= n
      return true
    }
  }
}
