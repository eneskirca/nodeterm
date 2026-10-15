import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { normalizeUnread, trayIconPath, trayMenuModel, trayStateKey, trayTooltip } from './tray-model'

describe('trayMenuModel', () => {
  it('has Open first and Quit last, both enabled with their actions', () => {
    const m = trayMenuModel({ unread: 0, phoneAccess: true })
    expect(m[0]).toEqual({ type: 'normal', label: 'Open nodeterm', enabled: true, action: 'open' })
    expect(m[m.length - 1]).toEqual({ type: 'normal', label: 'Quit nodeterm', enabled: true, action: 'quit' })
  })
  it('shows the phone-access status as a disabled row', () => {
    const labels = (s: boolean) =>
      trayMenuModel({ unread: 0, phoneAccess: s }).filter((i) => i.type === 'normal' && !i.enabled)
    expect(labels(true)).toEqual([{ type: 'normal', label: 'Phone access: on', enabled: false }])
    expect(labels(false)).toEqual([{ type: 'normal', label: 'Phone access: off', enabled: false }])
  })
  it('adds an unread row only when there is something unread', () => {
    const has = (n: number) =>
      trayMenuModel({ unread: n, phoneAccess: true }).some((i) => i.type === 'normal' && /unread/.test(i.label))
    expect(has(0)).toBe(false)
    expect(trayMenuModel({ unread: 1, phoneAccess: true })).toContainEqual({
      type: 'normal',
      label: '1 unread session',
      enabled: false
    })
    expect(trayMenuModel({ unread: 3, phoneAccess: true })).toContainEqual({
      type: 'normal',
      label: '3 unread sessions',
      enabled: false
    })
  })
})

describe('trayTooltip / trayStateKey / normalizeUnread', () => {
  it('tooltips the unread count', () => {
    expect(trayTooltip({ unread: 0, phoneAccess: true })).toBe('nodeterm')
    expect(trayTooltip({ unread: 2, phoneAccess: true })).toBe('nodeterm — 2 unread sessions')
  })
  it('keys identical states identically so a resend rebuilds nothing', () => {
    expect(trayStateKey({ unread: 2, phoneAccess: true })).toBe(trayStateKey({ unread: 2, phoneAccess: true }))
    expect(trayStateKey({ unread: 2, phoneAccess: true })).not.toBe(trayStateKey({ unread: 2, phoneAccess: false }))
    expect(trayStateKey({ unread: 2, phoneAccess: true })).not.toBe(trayStateKey({ unread: 3, phoneAccess: true }))
  })
  it('clamps junk IPC counts to 0', () => {
    expect(normalizeUnread(-1)).toBe(0)
    expect(normalizeUnread(NaN)).toBe(0)
    expect(normalizeUnread('3')).toBe(0)
    expect(normalizeUnread(4.7)).toBe(4)
  })
})

describe('trayIconPath', () => {
  it('reads resources/icon.png when packaged and build/icon.png in dev', () => {
    const base = { resourcesPath: '/r', devBuildDir: '/b', join }
    expect(trayIconPath({ ...base, isPackaged: true })).toBe(join('/r', 'icon.png'))
    expect(trayIconPath({ ...base, isPackaged: false })).toBe(join('/b', 'icon.png'))
  })
})

describe('the restart-to-update item', () => {
  it('appears only while an update is ready, above Quit, with its version', () => {
    expect(trayMenuModel({ unread: 0, phoneAccess: false }).some((i) => i.type === 'normal' && i.action === 'restart-update')).toBe(false)
    expect(trayMenuModel({ unread: 0, phoneAccess: false, updateReady: null }).some((i) => i.type === 'normal' && i.action === 'restart-update')).toBe(false)
    const items = trayMenuModel({ unread: 0, phoneAccess: false, updateReady: '0.5.0' })
    const idx = items.findIndex((i) => i.type === 'normal' && i.action === 'restart-update')
    expect(items[idx]).toEqual({ type: 'normal', label: 'Restart to update v0.5.0', enabled: true, action: 'restart-update' })
    expect(items.findIndex((i) => i.type === 'normal' && i.action === 'quit')).toBeGreaterThan(idx)
  })

  it('changes the rebuild key, so the menu picks it up', () => {
    expect(trayStateKey({ unread: 0, phoneAccess: false, updateReady: '0.5.0' })).not.toBe(
      trayStateKey({ unread: 0, phoneAccess: false })
    )
  })
})
