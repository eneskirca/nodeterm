import { useEffect, useRef, type RefObject } from 'react'
import { useSettings } from '../state/settings'
import { BROWSER_DISCARD_MS, shouldDiscard } from './browser-discard-policy'

/** Slack past the window so the reading at fire time is strictly PAST it (`shouldDiscard` is `>`). */
export const DISCARD_SLACK_MS = 1000
/**
 * Re-check interval when the only thing blocking a discard was TRANSIENT — a load in flight, or a
 * page making sound. Both end by themselves, so treating either as a decision for the whole hidden
 * stretch would disarm the saver for a page that finished (or went quiet) a second later. Bounded
 * (a fixed re-arm, never a poll loop): each retry only runs while the element is still hidden, and
 * any reveal clears the timer.
 */
export const DISCARD_RETRY_MS = 60_000

/** The slice of Electron's `WebviewTag` the audible check needs. */
export type AudibleWebview = { isCurrentlyAudible?: () => boolean }

/**
 * Is this webview making sound right now?
 *
 * Asked by direct QUERY rather than by tracking `media-started-playing` / `media-paused` into a
 * flag, and the choice is about which way each is wrong. The query cannot drift: it is the guest's
 * own answer at the instant we ask. The event pair can — a missed or unpaired event leaves a flag
 * stuck, and stuck-audible means that node's saver is silently dead forever (the worst failure
 * here, because nothing surfaces it). The query's only weakness is that it throws before the guest
 * attaches, and a guest that does not exist yet cannot be playing anything — so `false` there is
 * the CORRECT answer, not merely a safe one.
 */
export function webviewAudible(el: AudibleWebview | null | undefined): boolean {
  try {
    return el?.isCurrentlyAudible?.() === true
  } catch {
    return false
  }
}

export interface DiscardWhenHiddenOptions {
  /** Is a load in flight right now? A discard mid-load would replay a half-finished navigation. */
  isLoading: () => boolean
  /** Is the page making sound right now? Omitted = this surface cannot tell (never treated as
   *  audible — a surface with no webview has nothing playing). */
  isAudible?: () => boolean
  /** Is there anything to release? (A start page / empty node has no guest process.) */
  hasContent: () => boolean
  /** Release the page: the caller unmounts its `<webview>` and shows its plate. */
  onDiscard: () => void
  /** Rebuild the page from the caller's own descriptor. Only ever called after `onDiscard`. */
  onRestore: () => void
}

/**
 * The hidden-webview memory saver, shared by every surface that hosts an Electron `<webview>`
 * ({@link BrowserSurface}, WebNode). Each webview is a whole Chromium renderer process and the
 * canvas caps nothing, so a page hidden past {@link BROWSER_DISCARD_MS} is released and rebuilt
 * from its URL on reveal.
 *
 * This lives in ONE place on purpose: the state machine (observer lifecycle, hidden-since stamp,
 * timer arm/clear, the fire-time re-checks) is the whole risk of the feature, and two copies of it
 * drift — the first pair already disagreed about guard ORDER and lost half the reasoning comments.
 * The component keeps only what is genuinely its own: what "loading"/"content" mean for it, and how
 * to tear down and rebuild its page.
 *
 * The observer is created ONCE (mount-stable). Re-creating it on every state flip would re-arm the
 * hidden timer each time — `observe()` re-reports immediately — so a page could sit hidden forever
 * without ever reaching the window. Every mutable input is therefore read through a ref at fire
 * time, including the SETTING: switching the saver off must disarm a timer armed minutes earlier.
 */
export function useDiscardWhenHidden(
  rootRef: RefObject<HTMLElement | null>,
  opts: DiscardWhenHiddenOptions
): void {
  // Re-read on every render so the mount-stable effect below always calls the CURRENT closures
  // (they capture component state and are re-created each render).
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    let hiddenSince: number | null = null
    let discarded = false

    const clear = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const arm = (ms: number): void => {
      if (!timer) timer = setTimeout(fire, ms)
    }
    /** Geometry, not the observer's verdict — see the M1 note in `fire`. */
    const onScreen = (): boolean => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return false
      return (
        r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth
      )
    }
    function fire(): void {
      timer = null
      const o = optsRef.current
      if (hiddenSince == null || discarded) return
      // The timer task and the IntersectionObserver callback are separate tasks: a node revealed a
      // frame before this fires has not delivered its "visible" entry yet, and discarding here
      // would flash a plate + reload on a page the user is looking at. Re-measure instead of
      // trusting the last verdict.
      if (onScreen()) return
      // Nothing loaded = no guest process to release, and the plate would replace the one useful
      // thing on screen (a start page). Checked BEFORE the policy so an empty node never even
      // consults the clock.
      if (!o.hasContent()) return
      const enabled = useSettings.getState().settings.browserMemorySaver
      const loading = o.isLoading()
      const audible = o.isAudible?.() ?? false
      if (!shouldDiscard({ hiddenMs: Date.now() - hiddenSince, loading, enabled, audible })) {
        // Both blockers END BY THEMSELVES, so they earn a retry rather than disarming the saver for
        // the whole hidden stretch. A disabled setting does not: see the policy's doc comment.
        if (enabled && (loading || audible)) arm(DISCARD_RETRY_MS)
        return
      }
      discarded = true
      o.onDiscard()
    }

    const obs = new IntersectionObserver((entries) => {
      const visible = entries[entries.length - 1]?.isIntersecting ?? true
      if (!visible) {
        if (hiddenSince == null) hiddenSince = Date.now()
        arm(BROWSER_DISCARD_MS + DISCARD_SLACK_MS)
        return
      }
      hiddenSince = null
      clear()
      if (!discarded) return
      discarded = false
      optsRef.current.onRestore()
    })
    obs.observe(el)
    return () => {
      obs.disconnect()
      clear()
    }
    // Mount-stable by design (see the doc comment). `rootRef` is a ref object; `opts` is read
    // through `optsRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
