// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PopupAnnouncement } from '@shared/types'
import { AnnouncementPopup } from './AnnouncementPopup'
import { popDialog, pushDialog, resetDialogStack } from './dialog-stack'
import { useEntitlement } from '../state/entitlement'
import { KEY_QUIET_MS, loadSeenPopups } from '../lib/announcementPopup'

// The real store subscribes to the license bridge when it is created; the popup reads the bit and
// calls the checkout.
vi.mock('../state/entitlement', async () => {
  const { create } = await import('zustand')
  return { useEntitlement: create(() => ({ isPremium: false, upgrade: async () => {} })) }
})

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

async function mount(): Promise<void> {
  const el = document.createElement('div')
  root = createRoot(el)
  await act(async () => root!.render(<AnnouncementPopup />))
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount())
  root = null
}

const dialog = () => document.body.querySelector('.announce-popup')
const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined

beforeEach(() => {
  vi.useFakeTimers()
  resetDialogStack()
})

afterEach(async () => {
  await unmount()
  vi.useRealTimers()
  useEntitlement.setState({ isPremium: false, upgrade: async () => {} })
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
  const SIX_HOURS = 6 * 60 * 60 * 1000
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

it('waits for another modal to close before taking the screen', async () => {
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

it('waits for the keyboard to go quiet', async () => {
  setFeed([])
  await mount()
  // The user is typing when the popup arrives (a plan change re-reads the feed).
  popups.mockResolvedValue([pop('a')])
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
    useEntitlement.setState({ isPremium: true })
  })
  await act(async () => useEntitlement.setState({ isPremium: false }))
  expect(dialog()).toBeNull()
  await act(async () => vi.advanceTimersByTime(KEY_QUIET_MS - 1000))
  expect(dialog()).toBeNull()
  await act(async () => vi.advanceTimersByTime(1000))
  expect(dialog()?.textContent).toContain('Title a')
})

it('closes on Escape and takes no focus from the user', async () => {
  const input = document.createElement('input')
  document.body.appendChild(input)
  input.focus()
  setFeed([pop('a')])
  await mount()
  expect(dialog()).not.toBeNull()
  expect(document.activeElement).toBe(input)
  // Enter answers nothing.
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })))
  expect(dialog()).not.toBeNull()
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(dialog()).toBeNull()
  input.remove()
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
