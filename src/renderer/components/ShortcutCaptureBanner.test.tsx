// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandId } from '@shared/keybindings'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from '../state/settings'
import { ShortcutCaptureBanner } from './ShortcutCaptureBanner'

/**
 * The banner is the only surface that ever SHOWS a capture notice, and until now nothing pressed
 * it — `keybindingOverrides.test.ts` runs in the node environment and can assert only the settings
 * half (the once-ever ledger, the terminal-first silence). Everything below is the other half: the
 * `window` event → visible strip → dismissal path, which is where a queue-less design, a restarted
 * clock and two `null` copy cases all live.
 *
 * FAKE TIMERS, and the coupling documented in `terminalFocusMirror.test.ts` applies here too:
 * `vi.useFakeTimers()` does NOT fake microtasks in this repo's configuration, so React's own
 * flushing still happens naturally inside `act` — advance the CLOCK with
 * `vi.advanceTimersByTime` and let `act` settle the render. Never try to "advance" a microtask.
 * The 12s auto-dismiss is a `setTimeout` in an effect, so every advance has to be wrapped in
 * `act` or the resulting `setCurrent(null)` never reaches the DOM being asserted on.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom reports a non-mac platform, and the body quotes a PLATFORM-FORMATTED chord ('⌘K' vs
// 'Ctrl+K'). Pin macOS so the assertions name one spelling — `isMacPlatform()` is read at call
// time, never captured at module load.
Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })

/** Must be a FRESH `keybindings` object every time: `activeKeybindingOverrides` memoizes on that
 *  object's identity, so mutating one in place would serve the previous sanitize. */
const setKb = (kb: Record<string, readonly string[]> | undefined): void =>
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keybindings: kb as never } })

const onOpenShortcuts = vi.fn()
let host: HTMLDivElement
let root: Root | null = null

function render(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<ShortcutCaptureBanner onOpenShortcuts={onOpenShortcuts} />))
}

/** What `noteTerminalCapture` dispatches. Raised directly here: the DECISION to raise it is
 *  already pinned in `keybindingOverrides.test.ts`, and this file is about what happens after. */
function capture(commandId: string): void {
  act(() =>
    window.dispatchEvent(
      new CustomEvent('nodeterm:shortcut-captured', { detail: { commandId: commandId as CommandId } })
    )
  )
}

const tick = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

const banner = (): HTMLElement | null => host.querySelector<HTMLElement>('.announce-banner')
const title = (): string | undefined =>
  host.querySelector<HTMLElement>('.announce-banner__title')?.textContent ?? undefined
const body = (): string | undefined =>
  host.querySelector<HTMLElement>('.announce-banner__body')?.textContent ?? undefined
const btn = (label: string): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement
/** The dismiss button carries an icon, not a label, so it is addressed by its title. */
const btnByTitle = (title: string): HTMLButtonElement =>
  host.querySelector(`button[title="${title}"]`) as HTMLButtonElement
const click = (el: HTMLElement): void => {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

beforeEach(() => {
  vi.useFakeTimers()
  onOpenShortcuts.mockClear()
  setKb(undefined)
})

afterEach(() => {
  if (root) {
    const r = root
    root = null
    act(() => r.unmount())
    host.remove()
  }
  vi.useRealTimers()
})

describe('ShortcutCaptureBanner', () => {
  it('renders nothing until a capture arrives', () => {
    render()
    expect(banner()).toBeNull()
  })

  it('a bound command renders its title and a body quoting the chord in force', () => {
    render()
    capture('app.commandPalette')
    expect(banner()).not.toBeNull()
    expect(title()).toBe('Command palette')
    // The chord is read through `chipFor`, so this is the EFFECTIVE binding, not the registry
    // default — the remap case below is the same assertion with an override in place.
    expect(body()).toContain('⌘K')
    expect(body()).toContain('Command palette')
    expect(body()).toContain('terminal-first')
  })

  it('quotes the user’s own chord after a remap, never the registry default', () => {
    setKb({ 'app.commandPalette': ['Cmd+Alt+P'] })
    render()
    capture('app.commandPalette')
    expect(body()).toContain('⌘⌥P')
    expect(body()).not.toContain('⌘K')
  })

  it('a second capture REPLACES the first and restarts the 12s clock', () => {
    render()
    capture('app.commandPalette')
    tick(8_000)
    expect(title()).toBe('Command palette')

    capture('app.settings')
    // Replaced, not queued: the first notice is gone the instant the second arrives.
    expect(title()).toBe('Open settings')
    expect(body()).toContain('⌘,')

    // 8s past the FIRST capture's deadline (16s in) — a clock that had been inherited rather than
    // restarted would have dismissed the strip here.
    tick(8_000)
    expect(title()).toBe('Open settings')
    // …and the second one's own 12s still lands.
    tick(4_000)
    expect(banner()).toBeNull()
  })

  it('auto-dismisses at 12s, and not a tick before', () => {
    render()
    capture('app.commandPalette')
    tick(11_999)
    expect(banner()).not.toBeNull()
    tick(1)
    expect(banner()).toBeNull()
  })

  it('Open Shortcuts calls the prop AND clears the strip', () => {
    render()
    capture('app.commandPalette')
    click(btn('Open Shortcuts'))
    expect(onOpenShortcuts).toHaveBeenCalledTimes(1)
    // Both halves matter: opening the settings page behind a strip that stays up would leave the
    // user reading a notice about the very screen they are now looking at.
    expect(banner()).toBeNull()
  })

  it('the dismiss button dismisses without opening Settings', () => {
    render()
    capture('app.commandPalette')
    click(btnByTitle('Dismiss'))
    expect(banner()).toBeNull()
    expect(onOpenShortcuts).not.toHaveBeenCalled()
  })

  it('an id the registry does not know renders nothing', () => {
    render()
    // The id arrives inside a `CustomEvent.detail` off `window`, so its `CommandId` type is a
    // compile-time claim and nothing more — a stale or forged one must be silence, not a hole.
    capture('app.notACommand')
    expect(banner()).toBeNull()
  })

  it('a DISABLED (unbound) command renders nothing — the sentence is built around its chord', () => {
    setKb({ 'app.commandPalette': [] })
    render()
    capture('app.commandPalette')
    expect(banner()).toBeNull()
  })

  it('a malformed event with no commandId renders nothing', () => {
    render()
    act(() => window.dispatchEvent(new CustomEvent('nodeterm:shortcut-captured')))
    expect(banner()).toBeNull()
  })

  it('stops listening once unmounted', () => {
    render()
    const r = root!
    root = null
    act(() => r.unmount())
    // No throw, no state update on a dead root — the subscription is torn down in the effect's
    // cleanup, and a leaked one would surface here as a React warning about an unmounted update.
    capture('app.commandPalette')
    expect(host.querySelector('.announce-banner')).toBeNull()
    host.remove()
  })
})
