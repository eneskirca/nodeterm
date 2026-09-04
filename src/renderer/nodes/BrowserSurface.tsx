import { useEffect, useRef, useState } from 'react'
import { IconArrowLeft, IconArrowRight } from '../components/icons'
import { searchOrUrl } from './browserUrl'
import { BrowserStartPage } from './BrowserStartPage'
import { useBrowserHistory } from '../state/browserHistory'
import { useDiscardWhenHidden, webviewAudible } from './useDiscardWhenHidden'
import { DiscardedPlate } from './DiscardedPlate'
import { reloadWebview, type ReloadableWebview } from './webviewReload'
import { describeLoadFailure, isReportableFailure, type WebviewLoadFailure } from './webviewError'
import { WebviewErrorPlate } from './WebviewErrorPlate'
import { WebviewLoadingBar } from './WebviewLoadingBar'

// Minimal typing for the Electron <webview> element methods/events we use.
type WebviewEl = HTMLElement & {
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): void
  canGoBack(): boolean
  canGoForward(): boolean
  getWebContentsId(): number
  /** Throws before the guest attaches — always go through `webviewAudible`. */
  isCurrentlyAudible?: () => boolean
}

interface BrowserSurfaceProps {
  /** The node id — registers the guest webContents so main can route its new-window requests. */
  nodeId: string
  /** Initial URL (seeded once at mount). */
  url: string
  /**
   * The Electron session partition. Set for an AGENT-opened node
   * (`persist:nt-agent-browser-<projectId>`), absent for a USER-opened node (default session).
   * Applied straight to `<webview partition>`, which is honoured only at attach — the discard/restore
   * remount re-applies the SAME value, so the guest rejoins its jar ([MEASURED, Electron 42.8.1],
   * Probe B). Threaded identically here and in the card modal so the two mounts share one jar
   * (`browser-partition-parity.test.tsx`); a mismatch reads to a user as "my login vanished".
   */
  partition?: string
  /** Persist the top-level URL after a navigation. */
  onUrlChange: (url: string) => void
  /** Persist the page title. */
  onTitleChange: (title: string) => void
  /**
   * The memory saver released this surface's guest process. Optional; today's one caller is a
   * background keep-alive GHOST (see lib/webviewKeepAlive.ts), which answers by dropping its pool
   * entry — a hidden husk with no guest has nothing left to keep alive. An ACTIVE node passes
   * nothing and keeps the plate-and-restore behavior unchanged.
   */
  onGuestDiscarded?: () => void
}

/**
 * The navigable Chromium surface (Electron <webview> + back/forward/reload + address bar), with
 * no node chrome. Shared by the canvas {@link BrowserNode} and the kanban card modal, so a browser
 * opens and navigates the same way on both. Navigation is driven by the `src` attribute (a src-less
 * webview never emits dom-ready, so imperative loadURL before then is a no-op); `did-navigate` only
 * updates the address, so in-page navigation can't loop.
 */
export function BrowserSurface({
  nodeId,
  url,
  partition,
  onUrlChange,
  onTitleChange,
  onGuestDiscarded
}: BrowserSurfaceProps) {
  const ref = useRef<WebviewEl | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const lastUrlRef = useRef('')
  const [startUrl] = useState(() => url ?? '')
  const [src, setSrc] = useState(startUrl)
  const [address, setAddress] = useState(startUrl)
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  /** A complaint about what was TYPED in the address bar, not about a page. Rendered as a strip
   *  under the toolbar, so it never covers a page that is still perfectly readable. */
  const [notice, setNotice] = useState('')
  /** A main-frame load failure, which DOES cover the guest — see {@link WebviewErrorPlate}. */
  const [failure, setFailure] = useState<WebviewLoadFailure | null>(null)
  // Memory saver (see `useDiscardWhenHidden`): the page is released while hidden and rebuilt on
  // reveal. `loadingRef` mirrors the `loading` state because the hook reads it at fire time, from
  // a callback that must not force the observer to be re-created.
  const [discarded, setDiscarded] = useState(false)
  const loadingRef = useRef(false)
  /** The URL a restore is replaying (null = no restore in flight); the first did-navigate carrying
   *  exactly it is that echo. Cleared by that navigation, by any user-initiated one, and by a
   *  failed load. */
  const restoringNavRef = useRef<string | null>(null)
  /** The last title we reported (null = the gate is open for the current page's first title). */
  const lastTitleRef = useRef<string | null>(null)
  /** The page a discard would rebuild from — the last location we actually LOADED, never the
   *  address input (which holds whatever the user typed, submitted or not). */
  const locationRef = useRef(startUrl)

  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const onStart = (): void => {
      loadingRef.current = true
      setLoading(true)
      // The one unambiguous "we are trying again" signal, and the ONLY place the plate clears.
      // `did-navigate` is not usable for it: Chromium navigates to its own error page under the
      // very URL that just failed, so clearing there would wipe the plate the instant it appears.
      setFailure(null)
    }
    const onStop = (): void => {
      loadingRef.current = false
      setLoading(false)
      setCanBack(wv.canGoBack())
      setCanFwd(wv.canGoForward())
    }
    const onNav = (e: Event): void => {
      const u = (e as unknown as { url: string }).url
      // A memory-saver restore replays the URL we were already on, and its did-navigate is
      // indistinguishable from a real one. Reporting it would make MERELY LOOKING at a node dirty
      // the project (updateNodeData → dirty + rev bump + SSH mirror write) and bump an unchanged
      // page to the top of Recent. One-shot and value-checked, so a user who navigates for real
      // immediately after a reveal is still recorded.
      // The ref holds the restore's URL rather than a boolean because `locationRef` moves with
      // every navigation INITIATOR: compared against it, a user's own same-URL navigation read as
      // an echo, and after a FAILED restore (no did-navigate ever arrives) the stuck flag swallowed
      // the next address-bar navigation to ANY url — leaving `data.url` stale and filing that
      // page's title under the previous one.
      const echo = restoringNavRef.current !== null && u === restoringNavRef.current
      restoringNavRef.current = null
      setAddress(u)
      locationRef.current = u
      setNotice('')
      if (echo) return
      // A genuine navigation re-opens the title gate below: the first title of the NEW page always
      // records, however it compares to the old page's.
      lastTitleRef.current = null
      onUrlChange(u)
      lastUrlRef.current = u
      useBrowserHistory.getState().record(u, u)
    }
    const onNavInPage = (e: Event): void => {
      const u = (e as unknown as { url: string }).url
      setAddress(u)
      locationRef.current = u
    }
    const onTitle = (e: Event): void => {
      const title = (e as unknown as { title: string }).title
      // The restored page re-announces the title it already had, which would re-dirty the project
      // and re-bump history through the other half of the same reveal. Suppressing it by VALUE
      // rather than by a restore flag means a title that genuinely changed still lands.
      if (title === lastTitleRef.current) return
      lastTitleRef.current = title
      onTitleChange(title)
      if (lastUrlRef.current) useBrowserHistory.getState().record(lastUrlRef.current, title)
    }
    const onFail = (e: Event): void => {
      const ev = e as unknown as {
        isMainFrame: boolean
        errorCode: number
        errorDescription: string
        validatedURL?: string
      }
      if (isReportableFailure(ev.isMainFrame, ev.errorCode)) {
        // A restore that never landed has no echo to swallow — disarm, or the next navigation pays.
        restoringNavRef.current = null
        setFailure(describeLoadFailure(ev.errorCode, ev.errorDescription, ev.validatedURL || locationRef.current))
      }
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNavInPage)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNavInPage)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('did-fail-load', onFail)
    }
    // `discarded` is a dep because a discard UNMOUNTS the <webview> element (dropping `src` alone
    // would leave the guest process alive): the restored element is a different node, so the
    // listeners have to be re-attached to it.
  }, [onUrlChange, onTitleChange, discarded])

  // Registers the guest so main can route its new-window requests. `discarded` is a dep for the
  // same reason as above — and it is what makes a discard UNREGISTER the dead wcId through this
  // cleanup, rather than leaking it until the node unmounts.
  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    let wcId = 0
    const onReady = (): void => {
      wcId = wv.getWebContentsId()
      window.nodeTerminal.browser.register(wcId, nodeId)
    }
    wv.addEventListener('dom-ready', onReady)
    return () => {
      wv.removeEventListener('dom-ready', onReady)
      if (wcId) window.nodeTerminal.browser.unregister(wcId)
    }
  }, [nodeId, discarded])

  // ── Memory saver ────────────────────────────────────────────────────────────────────────────
  // A browser node parked off-screen is a whole Chromium renderer process doing nothing, and the
  // canvas caps nothing. The state machine (observer, timer, fire-time re-checks) lives in the
  // shared hook; this surface contributes only what "loading"/"content" mean for it and how to
  // release and rebuild its page.
  useDiscardWhenHidden(rootRef, {
    isLoading: () => loadingRef.current,
    isAudible: () => webviewAudible(ref.current),
    hasContent: () => !!locationRef.current,
    onDiscard: () => {
      setDiscarded(true)
      setSrc('')
      // A failure belongs to the page we just released; the restore re-navigates and will raise
      // its own if the load fails again.
      setFailure(null)
      setNotice('')
      // The guest is gone, so no did-stop-loading is coming to end a navigation left in flight.
      loadingRef.current = false
      setLoading(false)
      onGuestDiscarded?.()
    },
    onRestore: () => {
      setDiscarded(false)
      // Restore from the descriptor. Setting `src` and `address` to the SAME value preserves the
      // `url !== address` guard of the sync effect below, so the restore can't start a reload loop.
      const back = locationRef.current
      // The restore's own did-navigate is an ECHO of this exact URL — see `onNav`.
      restoringNavRef.current = back
      setSrc(back)
      setAddress(back)
    }
  })

  // Keep the two webviews for one node (canvas + modal) in sync: when `url` changes from the
  // OUTSIDE (the other webview navigated → node.data.url updated) and differs from where we are,
  // follow it. Guarded on `!== address` so our own did-navigate (which sets address = url) is a
  // no-op — no reload loop.
  useEffect(() => {
    if (url && url !== address) {
      // A navigation with an initiator: whatever it navigates to is not a restore echo.
      restoringNavRef.current = null
      setSrc(url)
      setAddress(url)
      // Keep the discard descriptor current even while discarded: a node released off-screen must
      // come back at where the OTHER webview navigated to, not at where it was released.
      locationRef.current = url
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  const go = (): void => {
    const safe = searchOrUrl(address)
    if (!safe) {
      setNotice('Enter a URL or search term')
      return
    }
    setAddress(safe)
    setNotice('')
    // A navigation with an initiator: whatever it navigates to is not a restore echo.
    restoringNavRef.current = null
    locationRef.current = safe
    if (safe === src) reloadWebview(ref.current, false)
    else setSrc(safe)
  }

  return (
    <div className="browser-surface" ref={rootRef}>
      <div className="browser-node__toolbar nodrag">
        <button className="browser-node__btn" disabled={!canBack} onClick={() => ref.current?.goBack()} title="Back">
          <IconArrowLeft />
        </button>
        <button className="browser-node__btn" disabled={!canFwd} onClick={() => ref.current?.goForward()} title="Forward">
          <IconArrowRight />
        </button>
        <button
          className="browser-node__btn"
          onClick={(e) => (loading ? ref.current?.stop() : reloadWebview(ref.current, e.shiftKey))}
          title={loading ? 'Stop' : 'Reload (Shift to bypass the cache)'}
        >
          {loading ? '✕' : '⟳'}
        </button>
        <input
          className="browser-node__address"
          value={address}
          spellCheck={false}
          placeholder="Enter a URL and press Enter"
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
        />
      </div>
      <div className="browser-node__view nodrag nowheel">
        {/* The element is UNMOUNTED while discarded — that is what ends the guest process; an
            emptied `src` attribute does not (Electron ignores a src mutation to nothing). */}
        {!discarded && (
          // eslint-disable-next-line react/no-unknown-property
          <webview
            ref={ref as unknown as React.Ref<HTMLElement>}
            src={src || undefined}
            partition={partition || undefined}
            allowpopups={true}
            style={{ width: '100%', height: '100%' }}
          />
        )}
        {!src && !discarded && (
          <BrowserStartPage
            onNavigate={(u) => {
              // A navigation with an initiator: whatever it navigates to is not a restore echo.
              restoringNavRef.current = null
              setSrc(u)
              setAddress(u)
              locationRef.current = u
              setNotice('')
            }}
          />
        )}
        {discarded && <DiscardedPlate />}
        {failure && !discarded && (
          <WebviewErrorPlate failure={failure} onRetry={() => reloadWebview(ref.current, false)} />
        )}
        {loading && <WebviewLoadingBar />}
        {notice && <div className="browser-node__error">{notice}</div>}
      </div>
    </div>
  )
}
