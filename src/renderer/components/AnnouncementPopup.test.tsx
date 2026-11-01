// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PopupAnnouncement } from '@shared/types'
import { AnnouncementPopup } from './AnnouncementPopup'
import { popDialog, pushDialog, resetDialogStack } from './dialog-stack'
import { useEntitlement } from '../state/entitlement'
import { useSettings } from '../state/settings'
import { useUpgradeGate } from '../state/upgradeGate'
import { KEY_QUIET_MS, PENDING_RECHECK_MS, loadSeenPopups } from '../lib/announcementPopup'

// The real store subscribes to the license bridge when it is created; the popup reads the bits and
// calls the checkout.
vi.mock('../state/entitlement', async () => {
  const { create } = await import('zustand')
  return { useEntitlement: create(() => ({ isPremium: false, known: true, upgrade: async () => {} })) }
})

const SIX_HOURS = 6 * 60 * 60 * 1000

const pop = (id: string, extra: Partial<PopupAnnouncement> = {}): PopupAnnouncement => ({
  id,
  title: `Title ${id}`,
  body: `Body ${id}`,
  level: 'info',
  ...extra
})

let root: Root | null = null
let popups: ReturnType<typeof vi.fn>

function setFeed(...reads: PopupAnnouncement[][]): void {
  popups = vi.fn()
  for (const r of reads) popups.mockResolvedValueOnce(r)
  popups.mockResolvedValue(reads[reads.length - 1] ?? [])
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { announcements: { popups } }
}

async function mount(blocked = false): Promise<void> {
  const el = document.createElement('div')
  root = createRoot(el)
  await act(async () => root!.render(<AnnouncementPopup blocked={blocked} />))
}

async function rerender(blocked: boolean): Promise<void> {
  await act(async () => root!.render(<AnnouncementPopup blocked={blocked} />))
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount())
  root = null
}

const dialog = () => document.body.querySelector<HTMLElement>('.announce-popup')
const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined

beforeEach(() => {
  vi.useFakeTimers()
  resetDialogStack()
  useSettings.setState({ hydrated: true })
})

afterEach(async () => {
  await unmount()
  vi.useRealTimers()
  useEntitlement.setState({ isPremium: false, known: true, upgrade: async () => {} })
  useSettings.setState({ hydrated: false })
  useUpgradeGate.setState({ open: false })
  localStorage.clear()
  vi.restoreAllMocks()
})

it('shows the newest popup once, and records it the moment it is shown', async () => {
  setFeed([pop('new'), pop('old')])
  await mount()
  expect(dialog()?.textContent).toContain('Title new')
  expect(dialog()?.textContent).toContain('Body new')
  expect(loadSeenPopups().has('new')).toBe(true)

  // A relaunch with it still on screen (never closed) does not bring it back.
  await unmount()
  setFeed([pop('new')])
  await mount()
  expect(dialog()).toBeNull()
})

it('closing one does not bring up the next until the next read of the feed', async () => {
  setFeed([pop('a'), pop('b')])
  await mount()
  expect(dialog()?.textContent).toContain('Title a')
  // A read while `a` is still up (the user is away) already knows `b` is next.
  await act(async () => vi.advanceTimersByTime(SIX_HOURS))
  expect(dialog()?.textContent).toContain('Title a')
  await act(async () => button('Close')!.click())
  expect(dialog()).toBeNull()
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(dialog()).toBeNull()

  // The next read.
  await act(async () => vi.advanceTimersByTime(SIX_HOURS))
  expect(dialog()?.textContent).toContain('Title b')
})

it('waits for another modal on the dialog stack to close', async () => {
  pushDialog('someone-else')
  setFeed([pop('a')])
  await mount()
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(dialog()).toBeNull()
  expect(loadSeenPopups().has('a')).toBe(false)

  popDialog('someone-else')
  await act(async () => vi.advanceTimersByTime(1000))
  expect(dialog()?.textContent).toContain('Title a')
})

// The setup tour, Settings, the palette… are not on the stack; Canvas says so through `blocked`.
it('waits while Canvas reports a surface of its own open', async () => {
  setFeed([pop('a')])
  await mount(true)
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(dialog()).toBeNull()
  await rerender(false)
  expect(dialog()?.textContent).toContain('Title a')
})

it('waits while the upgrade dialog is open', async () => {
  useUpgradeGate.setState({ open: true })
  setFeed([pop('a')])
  await mount()
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(dialog()).toBeNull()
  await act(async () => useUpgradeGate.setState({ open: false }))
  expect(dialog()?.textContent).toContain('Title a')
})

// First launch decides the setup tour from settings; a popup that beat it would sit on the tour.
it('waits for settings to load', async () => {
  useSettings.setState({ hydrated: false })
  setFeed([pop('a')])
  await mount()
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(dialog()).toBeNull()
  await act(async () => useSettings.setState({ hydrated: true }))
  expect(dialog()?.textContent).toContain('Title a')
})

// `isPremium` is `false` until the license is read, so a pick before then would show an upgrade
// popup to a Pro user — and record it.
it('does not read the feed until the license is known', async () => {
  useEntitlement.setState({ known: false })
  setFeed([pop('upsell', { action: 'upgrade' })])
  await mount()
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(popups).not.toHaveBeenCalled()
  await act(async () => useEntitlement.setState({ known: true, isPremium: true }))
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(popups).toHaveBeenCalled()
  expect(dialog()).toBeNull()
  expect(loadSeenPopups().has('upsell')).toBe(false)
})

it('drops a waiting popup the moment the plan changes, before the re-read answers', async () => {
  setFeed([pop('upsell', { action: 'upgrade' })])
  let answer: (items: PopupAnnouncement[]) => void = () => {}
  await mount(true)
  // The purchase lands while it waits, and the re-read for Pro is slow (a plan change misses
  // main's cache: a network read of up to 8 s). In that gap the old pick must already be gone.
  popups.mockReturnValueOnce(new Promise<PopupAnnouncement[]>((r) => (answer = r)))
  await act(async () => useEntitlement.setState({ isPremium: true }))
  await rerender(false)
  await act(async () => vi.advanceTimersByTime(10_000))
  // Not even for a frame: shown, it would be recorded (and closed by the Pro rule) — gone for good.
  expect(dialog()).toBeNull()
  expect(loadSeenPopups().has('upsell')).toBe(false)
  await act(async () => answer([pop('upsell', { action: 'upgrade' })]))
  expect(dialog()).toBeNull()
  expect(loadSeenPopups().has('upsell')).toBe(false)
})

it('drops a waiting popup the admin deactivated meanwhile', async () => {
  setFeed([pop('a')], [])
  await mount(true)
  await act(async () => vi.advanceTimersByTime(PENDING_RECHECK_MS))
  await rerender(false)
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(dialog()).toBeNull()
  expect(loadSeenPopups().has('a')).toBe(false)
})

it('waits for the keyboard to go quiet', async () => {
  setFeed([pop('a')])
  await mount(true)
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' })))
  await rerender(false)
  expect(dialog()).toBeNull()
  await act(async () => vi.advanceTimersByTime(KEY_QUIET_MS - 1000))
  expect(dialog()).toBeNull()
  await act(async () => vi.advanceTimersByTime(1000))
  expect(dialog()?.textContent).toContain('Title a')
})

it('takes focus into itself, not onto a button, and gives it back on close', async () => {
  const input = document.createElement('input')
  document.body.appendChild(input)
  input.focus()
  setFeed([pop('a', { url: 'https://x.dev' })])
  await mount()
  expect(document.activeElement).toBe(dialog())
  // Enter presses nothing.
  await act(async () => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(dialog()).not.toBeNull()
  await act(async () => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(dialog()).toBeNull()
  expect(document.activeElement).toBe(input)
  input.remove()
})

// xterm stops propagation of the keys it handles, Escape included: a bubble-phase listener never
// hears it, and the agent in the pane gets an ESC that interrupts its turn.
it('takes Escape before a terminal that still has focus can', async () => {
  const term = document.createElement('textarea')
  const seen = vi.fn((e: KeyboardEvent) => e.stopPropagation())
  term.addEventListener('keydown', seen)
  document.body.appendChild(term)
  setFeed([pop('a')])
  await mount()
  await act(async () => term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(dialog()).toBeNull()
  expect(seen).not.toHaveBeenCalled()
  term.remove()
})

it('opens its link and closes', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  setFeed([pop('a', { url: 'https://nodeterm.dev/news', ctaLabel: 'Read it' })])
  await mount()
  await act(async () => button('Read it')!.click())
  expect(open).toHaveBeenCalledWith('https://nodeterm.dev/news', '_blank', 'noopener')
  expect(dialog()).toBeNull()
})

it('has only Close without a link or an action', async () => {
  setFeed([pop('a', { ctaLabel: 'Orphan' })])
  await mount()
  expect([...dialog()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Close'])
})

it('starts the checkout from an upgrade popup, and closes once Pro arrives', async () => {
  const upgrade = vi.fn(async () => {})
  useEntitlement.setState({ upgrade })
  setFeed([pop('a', { action: 'upgrade' })])
  await mount()
  await act(async () => button('Upgrade to Pro')!.click())
  expect(upgrade).toHaveBeenCalledTimes(1)
  expect(dialog()).toBeNull()

  // Left open, it is closed by the purchase itself.
  await unmount()
  localStorage.clear()
  setFeed([pop('b', { action: 'upgrade' })])
  await mount()
  expect(dialog()).not.toBeNull()
  await act(async () => useEntitlement.setState({ isPremium: true }))
  expect(dialog()).toBeNull()
})

it('never shows a Pro user an upgrade popup, and keeps it for a lapse', async () => {
  useEntitlement.setState({ isPremium: true })
  setFeed([pop('upsell', { action: 'upgrade' })])
  await mount()
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(dialog()).toBeNull()
  expect(loadSeenPopups().has('upsell')).toBe(false)
})

it('shows nothing when the feed cannot be read', async () => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    announcements: { popups: vi.fn().mockRejectedValue(new Error('offline')) }
  }
  await mount()
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(dialog()).toBeNull()
})
