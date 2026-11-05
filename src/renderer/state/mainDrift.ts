import { useEffect } from 'react'
import { createStore, useStore } from 'zustand'
import type { GitApi, MainDrift } from '@shared/types'
import { isWindowBackgrounded, subscribeWindowBackgrounded } from '../terminal/window-backgrounded'

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

/** Polls `cwd` every MAIN_DRIFT_POLL_MS while the window is focused and shown; undefined `cwd` = off.
 *  Each poll is a `git fetch`, so an unfocused or hidden window pauses it and reads once on return. */
export function useMainDrift(git: GitApi, cwd: string | undefined): MainDrift | undefined {
  useEffect(() => {
    // ponytail: test fakes of GitApi do not carry mainDrift, so no test ever starts this poll.
    if (!cwd || typeof git.mainDrift !== 'function') return
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = (): void => {
      clearInterval(timer)
      timer = undefined
    }
    const sync = (): void => {
      stop()
      if (document.visibilityState === 'hidden' || !document.hasFocus() || isWindowBackgrounded()) return
      void refreshMainDrift(git, cwd)
      timer = setInterval(() => void refreshMainDrift(git, cwd), MAIN_DRIFT_POLL_MS)
    }
    sync()
    window.addEventListener('focus', sync)
    window.addEventListener('blur', stop)
    document.addEventListener('visibilitychange', sync)
    const unsubscribe = subscribeWindowBackgrounded(sync)
    return () => {
      stop()
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', stop)
      document.removeEventListener('visibilitychange', sync)
      unsubscribe()
    }
  }, [git, cwd])
  return useStore(storeFor(git), (s) => (cwd ? s.byCwd[cwd] : undefined))
}
