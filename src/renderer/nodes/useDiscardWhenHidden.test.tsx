// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useRef } from 'react'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from '../state/settings'
import { BROWSER_DISCARD_MS, shouldDiscard } from './browser-discard-policy'
import {
  DISCARD_RETRY_MS,
  DISCARD_SLACK_MS,
  useDiscardWhenHidden,
  webviewAudible,
  type DiscardWhenHiddenOptions
} from './useDiscardWhenHidden'

// Standalone harness — react-dom + the real zustand settings store, no testing-library
// dependency (the same shape as CustomAgentsSection.test.tsx).

/** The single observer the harness creates, so a test can drive visibility by hand. */
let observed: ((visible: boolean) => void) | null = null

class FakeIntersectionObserver {
  constructor(private cb: (entries: { isIntersecting: boolean }[]) => void) {
    observed = (visible: boolean) => this.cb([{ isIntersecting: visible }])
  }
  observe(): void {}
  disconnect(): void {
    observed = null
  }
}

/** Geometry the hook re-measures at fire time. jsdom's own rect is all-zero = off-screen. */
function stubRect(el: HTMLElement, onScreen: boolean): void {
  el.getBoundingClientRect = () =>
    (onScreen
      ? { top: 10, left: 10, bottom: 110, right: 110, width: 100, height: 100 }
      : { top: -500, left: -500, bottom: -400, right: -400, width: 100, height: 100 }) as DOMRect
}

function Harness(props: Partial<DiscardWhenHiddenOptions> & { onEl?: (el: HTMLElement) => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useDiscardWhenHidden(ref, {
    isLoading: props.isLoading ?? (() => false),
    isAudible: props.isAudible,
    hasContent: props.hasContent ?? (() => true),
    onDiscard: props.onDiscard ?? (() => {}),
    onRestore: props.onRestore ?? (() => {})
  })
  return (
    <div
      ref={(el) => {
        ref.current = el
        if (el) props.onEl?.(el)
      }}
    />
  )
}

function mount(props: Parameters<typeof Harness>[0]): Root {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<Harness {...props} />)
  })
  return root
}

/** Hide the element (geometry + the observer's verdict). */
function hide(el: HTMLElement): void {
  stubRect(el, false)
  act(() => observed?.(false))
}
function show(el: HTMLElement): void {
  stubRect(el, true)
  act(() => observed?.(true))
}
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('useDiscardWhenHidden', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } })
    observed = null
  })
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('does not discard before the window has elapsed', () => {
    const onDiscard = vi.fn()
    let el!: HTMLElement
    root = mount({ onDiscard, onEl: (e) => (el = e) })
    hide(el)
    advance(BROWSER_DISCARD_MS)
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('discards once the element has been hidden past the window', () => {
    const onDiscard = vi.fn()
    let el!: HTMLElement
    root = mount({ onDiscard, onEl: (e) => (el = e) })
    hide(el)
    advance(BROWSER_DISCARD_MS + DISCARD_SLACK_MS)
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it('cancels the pending discard when the element is revealed', () => {
    const onDiscard = vi.fn()
    const onRestore = vi.fn()
    let el!: HTMLElement
    root = mount({ onDiscard, onRestore, onEl: (e) => (el = e) })
    hide(el)
    advance(BROWSER_DISCARD_MS - 1000)
    show(el)
    advance(BROWSER_DISCARD_MS * 2)
    expect(onDiscard).not.toHaveBeenCalled()
    // Nothing was discarded, so there is nothing to restore either.
    expect(onRestore).not.toHaveBeenCalled()
  })

  it('restores exactly once, and only after a discard', () => {
    const onDiscard = vi.fn()
    const onRestore = vi.fn()
    let el!: HTMLElement
    root = mount({ onDiscard, onRestore, onEl: (e) => (el = e) })
    hide(el)
    advance(BROWSER_DISCARD_MS + DISCARD_SLACK_MS)
    show(el)
    show(el)
    expect(onDiscard).toHaveBeenCalledTimes(1)
    expect(onRestore).toHaveBeenCalledTimes(1)
  })

  it('does not discard a surface that is still on screen when the timer fires', () => {
    // The timer task and the observer callback are separate tasks: a reveal a frame before the
    // timer would otherwise flash a plate + reload on a page the user is looking at.
    const onDiscard = vi.fn()
    let el!: HTMLElement
    root = mount({ onDiscard, onEl: (e) => (el = e) })
    hide(el)
    stubRect(el, true) // revealed, but the observer entry has not been delivered yet
    advance(BROWSER_DISCARD_MS + DISCARD_SLACK_MS)
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('never discards a surface with nothing loaded', () => {
    const onDiscard = vi.fn()
    let el!: HTMLElement
    root = mount({ onDiscard, hasContent: () => false, onEl: (e) => (el = e) })
    hide(el)
    advance(BROWSER_DISCARD_MS * 3)
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('blocks on a load in flight at fire time, then retries when it finishes', () => {
    const onDiscard = vi.fn()
    let loading = true
    let el!: HTMLElement
    root = mount({ onDiscard, isLoading: () => loading, onEl: (e) => (el = e) })
    hide(el)
    advance(BROWSER_DISCARD_MS + DISCARD_SLACK_MS)
    expect(onDiscard).not.toHaveBeenCalled()
    // The re-arm is what keeps a load from disarming the saver for the whole hidden stretch.
    loading = false
    advance(DISCARD_RETRY_MS)
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it('never discards a page making sound, and reclaims it once it goes quiet', () => {
    const onDiscard = vi.fn()
    let audible = true
    let el!: HTMLElement
    root = mount({ onDiscard, isAudible: () => audible, onEl: (e) => (el = e) })
    hide(el)
    advance(BROWSER_DISCARD_MS + DISCARD_SLACK_MS)
    expect(onDiscard).not.toHaveBeenCalled()
    // Still playing a minute later — still exempt, and still re-armed.
    advance(DISCARD_RETRY_MS)
    expect(onDiscard).not.toHaveBeenCalled()
    audible = false
    advance(DISCARD_RETRY_MS)
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it('reads audibility through a webview ref that can throw or be absent', () => {
    // A guest that has not attached yet throws on the call, and a discarded surface has no element
    // at all — neither is "audible", and neither may take the saver down with it.
    expect(webviewAudible(null)).toBe(false)
    expect(webviewAudible(undefined)).toBe(false)
    expect(webviewAudible({})).toBe(false)
    expect(
      webviewAudible({
        isCurrentlyAudible: () => {
          throw new Error('The WebView must be attached to the DOM')
        }
      })
    ).toBe(false)
    expect(webviewAudible({ isCurrentlyAudible: () => true })).toBe(true)
  })

  it('honours the setting at FIRE time, not at arm time', () => {
    const onDiscard = vi.fn()
    let el!: HTMLElement
    root = mount({ onDiscard, onEl: (e) => (el = e) })
    hide(el)
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, browserMemorySaver: false } })
    advance(BROWSER_DISCARD_MS + DISCARD_SLACK_MS)
    expect(onDiscard).not.toHaveBeenCalled()
    // …and a disabled saver does not leave a retry armed either (that branch is loading-only).
    advance(DISCARD_RETRY_MS * 2)
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('shares one decision with the pure policy', () => {
    // The hook must not grow its own copy of the threshold.
    expect(shouldDiscard({ hiddenMs: BROWSER_DISCARD_MS + DISCARD_SLACK_MS, loading: false, enabled: true })).toBe(true)
  })
})
