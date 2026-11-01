// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { PopupAnnouncement } from '@shared/types'
import {
  KEY_QUIET_MS,
  SEEN_POPUPS_KEY,
  loadSeenPopups,
  markPopupSeen,
  pickPopup,
  popupCta,
  popupMayShow
} from './announcementPopup'

const pop = (id: string, extra: Partial<PopupAnnouncement> = {}): PopupAnnouncement => ({ id, title: id, ...extra })

afterEach(() => localStorage.clear())

describe('pickPopup', () => {
  it('takes the newest popup not shown before', () => {
    expect(pickPopup([pop('new'), pop('old')], new Set(), false)?.id).toBe('new')
    expect(pickPopup([pop('new'), pop('old')], new Set(['new']), false)?.id).toBe('old')
    expect(pickPopup([pop('new'), pop('old')], new Set(['new', 'old']), false)).toBeNull()
    expect(pickPopup([], new Set(), false)).toBeNull()
  })

  // Its button would be a checkout for what a Pro user already has. Skipped, not recorded: it is
  // still there for them if Pro lapses.
  it('skips an upgrade popup for a Pro user and takes the next one', () => {
    const items = [pop('upsell', { action: 'upgrade' }), pop('news')]
    expect(pickPopup(items, new Set(), true)?.id).toBe('news')
    expect(pickPopup(items, new Set(), false)?.id).toBe('upsell')
  })
})

describe('popupMayShow', () => {
  it('waits for a quiet keyboard and for no other modal', () => {
    expect(popupMayShow(10_000, 0, 0)).toBe(true)
    expect(popupMayShow(10_000, 10_000 - KEY_QUIET_MS, 0)).toBe(true)
    expect(popupMayShow(10_000, 10_000 - KEY_QUIET_MS + 1, 0)).toBe(false)
    expect(popupMayShow(10_000, 0, 1)).toBe(false)
  })
})

describe('popupCta', () => {
  it('is the checkout for an upgrade popup, whatever its link', () => {
    expect(popupCta(pop('a', { action: 'upgrade', url: 'https://x.dev' }))).toEqual({
      kind: 'upgrade',
      label: 'Upgrade to Pro'
    })
    expect(popupCta(pop('a', { action: 'upgrade', ctaLabel: 'Go Pro' }))?.label).toBe('Go Pro')
  })

  it('is the link otherwise, and nothing without one', () => {
    expect(popupCta(pop('a', { url: 'https://x.dev' }))).toEqual({ kind: 'url', label: 'Learn more', url: 'https://x.dev' })
    expect(popupCta(pop('a', { url: 'https://x.dev', ctaLabel: 'Read' }))?.label).toBe('Read')
    expect(popupCta(pop('a', { ctaLabel: 'Orphan label' }))).toBeNull()
  })
})

describe('seen record', () => {
  it('remembers every popup it was told about', () => {
    markPopupSeen('a')
    markPopupSeen('b')
    markPopupSeen('a')
    expect([...loadSeenPopups()].sort()).toEqual(['a', 'b'])
  })

  it('reads a damaged record as empty, never as a throw', () => {
    localStorage.setItem(SEEN_POPUPS_KEY, '{not json')
    expect(loadSeenPopups().size).toBe(0)
    localStorage.setItem(SEEN_POPUPS_KEY, JSON.stringify({ a: 1 }))
    expect(loadSeenPopups().size).toBe(0)
    localStorage.setItem(SEEN_POPUPS_KEY, JSON.stringify(['a', 3, null]))
    expect([...loadSeenPopups()]).toEqual(['a'])
  })
})
