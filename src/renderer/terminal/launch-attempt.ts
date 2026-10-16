import type { PendingLaunch } from '@shared/types'

/** `'elsewhere'`: the core says another viewer of this project already claimed this launch
 *  (issue #1173) — type nothing, change nothing, and do not report a failure. */
export type LaunchClaim = boolean | 'deferred' | 'elsewhere'
type Commit = (id: string, command: string, manual: boolean) => Promise<LaunchClaim>
const commits = new WeakMap<object, Commit>()
export function registerLaunchCommit(scope: object, commit: Commit): () => void {
  commits.set(scope, commit)
  return () => { if (commits.get(scope) === commit) commits.delete(scope) }
}
export function commitLaunch(scope: object, id: string, command: string, manual: boolean): Promise<LaunchClaim> {
  return commits.get(scope)?.(id, command, manual) ?? Promise.resolve(false)
}

/** Write-ahead barrier: an absent legacy marker is uncertain, never proof of no previous input. */
export async function commitLaunchAttempt(opts: {
  pending: PendingLaunch | undefined
  command: string
  manual: boolean
  update(pending: PendingLaunch): void
  save(): Promise<void>
  /**
   * The core's exactly-once claim across every viewer of the project (#1173,
   * `WorkspaceApi.claimLaunch`). Asked after the local check passes and before anything is
   * marked: a viewer told `'elsewhere'` leaves its copy exactly as it was — the owner's
   * `attempted`/cleared state reaches it over the canvas sync. A claim that cannot be asked (an
   * older core, a dropped socket) falls back to the per-viewer barrier, which is the old behaviour.
   */
  claim?(): Promise<'claimed' | 'elsewhere'>
  /** The launch as it stands NOW, re-read after the claim's round trip. Defaults to `pending`. */
  current?(): PendingLaunch | undefined
}): Promise<boolean | 'elsewhere'> {
  const fits = (p: PendingLaunch | undefined): p is PendingLaunch =>
    !!p && p.command === opts.command && (opts.manual || p.attempted === false)
  if (!fits(opts.pending)) return false
  let pending: PendingLaunch | undefined = opts.pending
  if (opts.claim) {
    let verdict: 'claimed' | 'elsewhere' = 'claimed'
    try { verdict = await opts.claim() } catch { /* fail open to the local barrier */ }
    if (verdict === 'elsewhere') return 'elsewhere'
    pending = opts.current ? opts.current() : opts.pending
    if (!fits(pending)) return false
  }
  opts.update({ ...pending, attempted: true, manualOnly: true })
  try {
    await opts.save()
    return true
  } catch {
    // Keep the in-memory hold too: a failed save is not permission to type or retry silently.
    return false
  }
}

/** A relay load may contain only one shared project; saving it would replace the host index.
 * Canvas mutation broadcasts have no durable acknowledgment. Refuse until a scoped durable
 * operation exists; this applies to explicit retry as well as automatic launch. */
export function commitOwnedLaunchAttempt(owner: object, local: object,
  opts: Parameters<typeof commitLaunchAttempt>[0]): Promise<boolean | 'elsewhere'> {
  return owner === local ? commitLaunchAttempt(opts) : Promise.resolve(false)
}
