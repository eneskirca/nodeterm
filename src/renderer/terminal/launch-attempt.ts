import type { PendingLaunch } from '@shared/types'

export type LaunchClaim = boolean | 'deferred'
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
}): Promise<boolean> {
  if (!opts.pending || opts.pending.command !== opts.command) return false
  if (!opts.manual && opts.pending.attempted !== false) return false
  opts.update({ ...opts.pending, attempted: true, manualOnly: true })
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
  opts: Parameters<typeof commitLaunchAttempt>[0]): Promise<boolean> {
  return owner === local ? commitLaunchAttempt(opts) : Promise.resolve(false)
}
