import { create } from 'zustand'
import { INACTIVE_PROJECT_LIMIT, type ProjectLimitState } from '@shared/project-limit'

/**
 * The renderer's copy of the free-tier open-project limit state (core/project-limit.ts computes it;
 * docs/superpowers/specs/2026-10-29-free-tier-project-limit-design.md). Core is the authority: this
 * store only mirrors it — the boot read (`hydrate`) and every `projectLimit:changed` push replace
 * `state` wholesale. It starts, and stays on any failed read, at `INACTIVE_PROJECT_LIMIT`: the
 * dormant answer, under which every open behaves exactly as before the limit existed.
 *
 * Desktop: the preload's `projectLimit`. Server Edition: the bridge stub answers inactive forever.
 * A relay tab keeps the LOCAL preload's api (the allowance is this machine's, never the host's).
 */
interface ProjectLimitStore {
  state: ProjectLimitState
  /** Read core's current state. Never rejects: a failed read keeps whatever is held (inactive until
   *  core has said otherwise). Called from the boot effect AFTER the projects store is hydrated —
   *  core records the first-launch open count on the first read it answers with the index loaded. */
  hydrate(): Promise<void>
}

export const useProjectLimit = create<ProjectLimitStore>((set) => {
  // Live updates from core: a server word, a license or settings change, time passing the deadline.
  // Subscribed at creation (the entitlement store's shape), so a push that lands before the first
  // read is not lost.
  window.nodeTerminal.projectLimit.onChange((state) => set({ state }))
  return {
    state: INACTIVE_PROJECT_LIMIT,
    async hydrate() {
      try {
        set({ state: await window.nodeTerminal.projectLimit.state() })
      } catch (err) {
        console.warn('[project-limit] state read failed', err instanceof Error ? err.message : String(err))
      }
    }
  }
})
