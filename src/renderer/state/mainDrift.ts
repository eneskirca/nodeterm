import { useEffect } from 'react'
import { createStore, useStore } from 'zustand'
import type { GitApi, MainDrift } from '@shared/types'

/** The badge's poll. The core fetches at most once per this window per repository and backs off
 *  after a failure, so several badges on one repository (project + worktrees) cost one fetch. */
export const MAIN_DRIFT_POLL_MS = 2 * 60_000

// Observations only, keyed per api (two cores can hold the same path), like gitBranches.ts.
const stores = new WeakMap<GitApi, ReturnType<typeof createDrifts>>()
const inFlight = new WeakMap<GitApi, Set<string>>()
function createDrifts() {
  return createStore(() => ({ byCwd: {} as Record<string, MainDrift> }))
}
function storeFor(git: GitApi) {
  let store = stores.get(git)
  if (!store) {
    store = createDrifts()
    stores.set(git, store)
  }
  return store
}

export async function refreshMainDrift(git: GitApi, cwd: string): Promise<void> {
  let busy = inFlight.get(git)
  if (!busy) inFlight.set(git, (busy = new Set()))
  if (busy.has(cwd)) return
  busy.add(cwd)
  try {
    const drift = await git.mainDrift(cwd)
    storeFor(git).setState((s) => ({ byCwd: { ...s.byCwd, [cwd]: drift } }))
  } catch {
    /* a failed read keeps the last answer */
  } finally {
    busy.delete(cwd)
  }
}

/** Polls `cwd` every MAIN_DRIFT_POLL_MS while the window is visible; undefined `cwd` = off. */
export function useMainDrift(git: GitApi, cwd: string | undefined): MainDrift | undefined {
  useEffect(() => {
    // ponytail: test fakes of GitApi do not carry mainDrift, so no test ever starts this poll.
    if (!cwd || typeof git.mainDrift !== 'function') return
    const poke = (): void => {
      if (document.visibilityState !== 'hidden') void refreshMainDrift(git, cwd)
    }
    poke()
    const t = setInterval(poke, MAIN_DRIFT_POLL_MS)
    document.addEventListener('visibilitychange', poke)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', poke)
    }
  }, [git, cwd])
  return useStore(storeFor(git), (s) => (cwd ? s.byCwd[cwd] : undefined))
}
