// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { SHORTCUT_DEFS } from '@shared/shortcuts'
import { formatShortcut } from '@shared/shortcut'
import { useSettings } from '../../../state/settings'
import { ShortcutsSection } from './ShortcutsSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

describe('ShortcutsSection', () => {
  let root: Root
  let host: HTMLElement

  beforeEach(async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    useSettings.setState({ settings: DEFAULT_SETTINGS, hydrated: true })
    root = createRoot(host)
    await act(async () => {
      root.render(<ShortcutsSection isActive />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('renders a row for every configurable shortcut, grouped', () => {
    for (const d of SHORTCUT_DEFS) {
      expect(host.textContent).toContain(d.label)
    }
    for (const title of ['General', 'Canvas', 'Terminal', 'Source Control']) {
      expect(host.textContent).toContain(title)
    }
  })

  it('shows the current combo keyed off settings.shortcuts (rebind reflected)', async () => {
    // The default combo renders with the platform's primary modifier label (⌘ on mac,
    // Ctrl elsewhere) — formatShortcut is the same formatter the capture field uses.
    const defaultBadge = formatShortcut(DEFAULT_SETTINGS.shortcuts.commandPalette, isMac)
    expect(host.textContent).toContain(defaultBadge)

    // Rebinding the palette shortcut in the store re-renders the row's badge.
    await act(async () => {
      useSettings.getState().update({
        shortcuts: { ...useSettings.getState().settings.shortcuts, commandPalette: 'Cmd+Shift+P' }
      })
    })
    expect(host.textContent).toContain(formatShortcut('Cmd+Shift+P', isMac))
  })
})