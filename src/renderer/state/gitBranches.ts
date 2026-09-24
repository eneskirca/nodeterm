import { createStore, useStore } from 'zustand'
import type { GitApi, GitStatus } from '@shared/types'

// Observations only: never persist these or use them to choose a node's cwd. API identity keeps
// two cores with the same filesystem paths separate; SSH routing also needs the project identity.
const stores = new WeakMap<GitApi, ReturnType<typeof createBranches>>()
function createBranches() {
  return createStore(() => ({ branches: {} as Record<string, string> }))
}
function storeFor(git: GitApi) {
  let store = stores.get(git)
  if (!store) {
    store = createBranches()
    stores.set(git, store)
  }
  return store
}
const keyFor = (cwd: string, sshProjectId?: string) => JSON.stringify([sshProjectId ?? null, cwd])
const pending = new WeakMap<GitApi, Map<string, symbol>>()

/** Share an EXISTING status read, without adding a poller. Latest-started read wins, so an old
 * sidebar/worktree request cannot undo the observation after a Source branch switch. */
export async function readBranchStatus(git: GitApi, cwd: string, sshProjectId?: string): Promise<GitStatus> {
  let requests = pending.get(git)
  if (!requests) {
    requests = new Map()
    pending.set(git, requests)
  }
  const key = keyFor(cwd, sshProjectId)
  const token = Symbol()
  requests.set(key, token)
  try {
    const status = await git.status(cwd)
    if (requests.get(key) === token) {
      const branch = status.hasRepo ? status.branch : ''
      storeFor(git).setState((s) => ({ branches: { ...s.branches, [key]: branch } }))
    }
    return status
  } finally {
    if (requests.get(key) === token) requests.delete(key)
  }
}

export function useGitBranch(git: GitApi, cwd?: string, sshProjectId?: string): string | undefined {
  return useStore(storeFor(git), (s) => cwd ? s.branches[keyFor(cwd, sshProjectId)] : undefined)
}
