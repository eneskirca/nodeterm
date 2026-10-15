import type { GitResult } from '@shared/types'

/**
 * Source Control's "Publish to GitHub" fallback when no GitHub credential is usable.
 *
 * It used to type `gh auth login && gh repo create '<name>' … --push` into a new terminal — one
 * POSIX line: Windows PowerShell 5.1 rejects `&&`, cmd.exe does not treat `'` as quoting, and the
 * `'\''` escape is wrong in every Windows shell. So the fallback is split: the terminal runs ONLY
 * the bare `gh auth login` (which every shell parses identically), and the repo create + push is
 * retried in-process through `git.publish` — whose repo name stays an argv element inside
 * git-service and never passes through a shell at all.
 */

/** The only command the fallback types: no quoting, no chaining, no user input. */
export const GH_LOGIN_COMMAND = 'gh auth login'

export type PublishOutcome =
  | { kind: 'published' }
  | { kind: 'login'; terminalCmd: typeof GH_LOGIN_COMMAND }
  | { kind: 'error'; message: string }

/** What a `git.publish` answer means for the panel. */
export function publishOutcome(r: GitResult): PublishOutcome {
  if (r.ok) return { kind: 'published' }
  if (r.needsAuth) return { kind: 'login', terminalCmd: GH_LOGIN_COMMAND }
  return { kind: 'error', message: r.message }
}

export const PUBLISH_RETRY_INTERVAL_MS = 3_000
export const PUBLISH_RETRY_TIMEOUT_MS = 5 * 60_000

export type RetryPublishResult =
  | { kind: 'published' }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }

/**
 * Retry `publish` while the user signs in to gh in the terminal: every `intervalMs` until it
 * succeeds, fails for a reason other than auth, the window closes, or `signal` aborts (the panel
 * unmounted or the user cancelled). Never runs two attempts at once.
 */
export async function retryPublishAfterLogin(
  publish: () => Promise<GitResult>,
  opts: {
    signal: AbortSignal
    intervalMs?: number
    timeoutMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  }
): Promise<RetryPublishResult> {
  const intervalMs = opts.intervalMs ?? PUBLISH_RETRY_INTERVAL_MS
  const timeoutMs = opts.timeoutMs ?? PUBLISH_RETRY_TIMEOUT_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = now() + timeoutMs
  for (;;) {
    await sleep(intervalMs)
    if (opts.signal.aborted) return { kind: 'cancelled' }
    if (now() > deadline) return { kind: 'timeout' }
    let r: GitResult
    try {
      r = await publish()
    } catch (e) {
      return { kind: 'error', message: (e as Error)?.message || 'Publish failed.' }
    }
    if (opts.signal.aborted) return r.ok ? { kind: 'published' } : { kind: 'cancelled' }
    const o = publishOutcome(r)
    if (o.kind === 'published') return o
    if (o.kind === 'error') return o
  }
}

/**
 * One in-flight retry per repo folder, kept at module level on purpose: the user has to reach the
 * login terminal, which means closing the Source Control drawer — a retry owned by the panel would
 * die exactly when the user goes to do what it is waiting for. Bounded by the retry window.
 */
export interface PendingPublish {
  abort: () => void
  done: Promise<RetryPublishResult>
}

const pending = new Map<string, PendingPublish>()

/** The retry running for `key` (a repo folder), if any. */
export function pendingPublish(key: string): PendingPublish | undefined {
  return pending.get(key)
}

/** Start (replacing any previous one for `key`) a `retryPublishAfterLogin`, single-flight per key.
 *  `onDone` runs once with the result, after the entry is cleared. */
export function startPublishRetry(
  key: string,
  publish: () => Promise<GitResult>,
  onDone?: (r: RetryPublishResult) => void,
  opts?: Omit<Parameters<typeof retryPublishAfterLogin>[1], 'signal'>
): PendingPublish {
  pending.get(key)?.abort()
  const ctl = new AbortController()
  const done = retryPublishAfterLogin(publish, { ...opts, signal: ctl.signal }).then((r) => {
    if (pending.get(key)?.done === done) pending.delete(key)
    onDone?.(r)
    return r
  })
  const entry: PendingPublish = { abort: () => ctl.abort(), done }
  pending.set(key, entry)
  return entry
}
