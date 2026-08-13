// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { SHORTCUT_DEFS } from '@shared/shortcuts'
import { shortcutKeyParts } from '@shared/shortcut'
import { useSettings } from '../state/settings'
import { ShortcutsPanel } from './ShortcutsPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

/** ShortcutsPanel portals into document.body; read the rendered rows there. */
function renderedText(): string {
  return document.body.textContent ?? ''
}

describe('ShortcutsPanel', () => {
  let root: Root
  let host: HTMLElement

  beforeEach(async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    useSettings.setState({ settings: DEFAULT_SETTINGS, hydrated: true })
    root = createRoot(host)
    await act(async () => {
      root.render(<ShortcutsPanel onClose={() => {}} />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ''
  })

  it('renders a row for every configurable shortcut from the registry, grouped', () => {
    const text = renderedText()
    for (const d of SHORTCUT_DEFS) {
      expect(text, `row for ${d.label}`).toContain(d.label)
    }
    for (const title of ['General', 'Canvas', 'Terminal', 'Source Control']) {
      expect(text, `group ${title}`).toContain(title)
    }
  })

  it('shows the current combo from settings.shortcuts, so a rebind reflects immediately', async () => {
    // The kbd badges render each part as its own element (keyLabel), so the textContent is the
    // parts concatenated — e.g. Ctrl + K for the palette on a non-mac test host.
    const badgeFor = (combo: string): string => shortcutKeyParts(combo, isMac).join('')
    const defaultBadge = badgeFor(DEFAULT_SETTINGS.shortcuts.commandPalette)
    expect(renderedText()).toContain(defaultBadge)

    // Rebinding the palette shortcut re-renders the panel's badge on the next frame — no
    // reload, no re-open needed.
    await act(async () => {
      useSettings.getState().update({
        shortcuts: { ...useSettings.getState().settings.shortcuts, commandPalette: 'Cmd+Shift+P' }
      })
    })
    expect(renderedText()).toContain(badgeFor('Cmd+Shift+P'))
    expect(renderedText()).not.toContain(defaultBadge)
  })

  it('leads the General group with the dictation row from settings.speech.shortcut', () => {
    const text = renderedText()
    expect(text).toContain('Dictate')
    expect(text).toContain(shortcutKeyParts(DEFAULT_SETTINGS.speech.shortcut, isMac).join(''))
  })

  it('documents the fixed mouse-gesture reference rows under their groups', () => {
    const text = renderedText()
    expect(text).toContain('Right-click')
    expect(text).toContain('Box-select')
    expect(text).toContain('Pan the canvas')
    expect(text).toContain('Zoom in / out')
    expect(text).toContain('Actions menu (empty space or node)')
  })
})
