import { create } from 'zustand'
import type { LicenseDetail, LicenseStatus } from '@shared/types'
import { isReleaseRefusal } from '@renderer/lib/licenseCopy'

interface EntitlementState {
  status: LicenseStatus
  /** True when an active Pro entitlement is present — features gate on this. */
  isPremium: boolean
  /** True once a real license status has arrived (the first `hydrate()` or main's broadcast).
   *  Until then `isPremium` is only the default `false`, not an answer — wait on this before
   *  deciding something a Pro user must never see. */
  known: boolean
  /** Team seat cap (premium → max(3, N), premium-no-field → 3 = Pro's free seats, free/inactive
   *  → 0). Mirrors `status.seats` so the Team seats section can select it directly. */
  seats: number
  /**
   * The license key + device usage, or null before the first read.
   *
   * **`detail.error` here means ONE thing: the last DETAIL READ, or a release refusal about the
   * license itself.** Only two kinds of code can be in it:
   * - **The read failed** — `unauthorized` | `inactive` | `offline` | `disabled` | `network`.
   *   Everything beside it is a placeholder: the zeros are NOT a device count and the null key is
   *   not "no key". Render the failure, never the numbers.
   * - **The read was fine; the RELEASE was refused** — `too_soon` (with `retryAfterDays`) |
   *   `not_applicable`. These ride on top of the last good read (see `releaseOthers`), so `key`,
   *   `source` and the counts are real and worth showing — say the action was refused, not that
   *   the license could not be read. (The counts are the last good read's; if nothing was ever
   *   read successfully they are still EMPTY_DETAIL's zeros, so call `loadDetail` first.)
   *
   * A release that failed for any OTHER reason never lands here — `releaseOthers` hands that code
   * back to its caller instead. It said nothing about the license, and merging it made the panel
   * replace a real key and real counts with "could not read this license", while saying nothing
   * about the action the user had just pressed.
   */
  detail: LicenseDetail | null
  hydrate(): Promise<void>
  /** Open Stripe checkout for this device; Pro arrives via onChange when the purchase lands.
   * `target: 'seats'` opens the add-seats (quantity) link instead of base Pro. */
  upgrade(target?: 'pro' | 'seats'): Promise<void>
  activate(key: string): Promise<void>
  deactivate(): Promise<void>
  /** Read the key + device usage (token-authorized). Replaces `detail` wholesale — it is the one
   *  call that states every field.
   *  **REJECTS on the Server Edition** (`E_UNSUPPORTED` from the bridge stub — there is no license
   *  layer in `src/server`), and neither this nor `releaseOthers` catches it. A caller that fires
   *  this on mount must `.catch(…)`, or it is an unhandled rejection on every browser session. */
  loadDetail(): Promise<void>
  /**
   * Deactivate every other device on this license, then fold the new counts into `detail`.
   *
   * Resolves to `null` when the release landed, or when the server refused it on terms `detail`
   * can carry (`too_soon` / `not_applicable` — merged onto the last good read, where
   * `licenseSentence` speaks for them). Any OTHER reason code is resolved AS the value and
   * `detail` is left exactly as it was: that code is about the call, not the license, so only the
   * caller — which knows a release was attempted — can say anything true about it.
   *
   * Rejects on the Server Edition exactly like `loadDetail` — see there.
   */
  releaseOthers(): Promise<string | null>
}

const EMPTY: LicenseStatus = {
  tier: null,
  active: false,
  expiresAt: null,
  termEndsAt: null,
  seats: 0,
  error: null
}

const EMPTY_DETAIL: LicenseDetail = {
  key: null,
  used: 0,
  seats: 0,
  source: null,
  error: null
}

export const useEntitlement = create<EntitlementState>((set, get) => {
  const apply = (status: LicenseStatus) =>
    set({ status, isPremium: status.active, seats: status.seats, known: true })
  // Live updates from the main process (launch refresh, offline grace).
  window.nodeTerminal.license.onChange(apply)
  return {
    status: EMPTY,
    isPremium: false,
    known: false,
    seats: 0,
    detail: null,
    async hydrate() {
      apply(await window.nodeTerminal.license.getStatus())
    },
    async upgrade(target) {
      apply(await window.nodeTerminal.license.upgrade(target))
    },
    async activate(key) {
      apply(await window.nodeTerminal.license.activate(key))
    },
    async deactivate() {
      apply(await window.nodeTerminal.license.deactivate())
    },
    async loadDetail() {
      set({ detail: await window.nodeTerminal.license.detail() })
    },
    async releaseOthers() {
      const r = await window.nodeTerminal.license.releaseOthers()
      const prev = get().detail ?? EMPTY_DETAIL
      // A release that did not land tells us nothing about the license, and for `offline`/`network`
      // it does not even tell us the server did nothing — the request may have arrived and only
      // the reply been lost. So `detail` keeps the last good read untouched (its key and counts are
      // still the best thing we know) and the code goes back to the caller, which is the only
      // place that knows a RELEASE was pressed and can say so.
      if (r.error && !isReleaseRefusal(r.error)) return r.error
      // The release route answers with COUNTS ONLY — no key, no source. Replacing `detail`
      // wholesale would blank the key the user came to this screen to copy, and drop the source
      // that decides whether this action is offered at all. A refusal carries no counts either
      // (its zeros are placeholders), so only its reason code rides.
      set({
        detail: r.error
          ? { ...prev, error: r.error, retryAfterDays: r.retryAfterDays }
          : { ...prev, used: r.used, seats: r.seats, error: null, retryAfterDays: undefined }
      })
      return null
    }
  }
})
