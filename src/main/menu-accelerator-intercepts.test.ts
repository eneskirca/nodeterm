import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// GUARD, not a unit test. `src/main/index.ts` imports `electron` at module scope, so its
// `before-input-event` handler cannot be loaded here — but that handler is the only thing standing
// between three chords and Electron's DEFAULT application menu, which we never replace
// (`Menu.setApplicationMenu` is not called anywhere) and which claims all three:
//
//   ⌘M → Window ▸ Minimize        ⌘W → Window ▸ Close        ⌘0 → View ▸ Actual Size (resetZoom)
//
// A menu accelerator is handled before the page sees the key, so deleting a branch here does not
// break a test or throw — the shortcut just quietly starts minimizing the window / closing it /
// resetting the WINDOW's page zoom instead of doing the app's thing. That is the failure this
// pins. (`before-input-event`'s preventDefault suppresses the menu item AND the page event, which
// is why each branch has to forward the intent to the renderer itself.)
const MAIN_SRC = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')

describe('the main window steals its chords back from the default menu', () => {
  it('still intercepts before the page and the menu', () => {
    expect(MAIN_SRC).toContain("win.webContents.on('before-input-event'")
  })

  it('forwards ⌘M and ⌘W to the renderer', () => {
    expect(MAIN_SRC).toContain('win.webContents.send(IPC.appToggleMarkdown)')
    expect(MAIN_SRC).toContain('win.webContents.send(IPC.appCloseNode)')
  })

  it('forwards ⌘0 to the renderer, and only on a FRESH press', () => {
    // Matched on the physical `code`, like the renderer's half of the chord: on a non-US layout
    // the zero key's `key` is not necessarily "0".
    expect(MAIN_SRC).toContain("input.code === 'Digit0' && !input.shift && !input.alt")
    // The repeat drop lives HERE because the forwarded signal carries no event: without it, a held
    // ⌘0 would restart the 200ms zoom tween on every OS repeat.
    expect(MAIN_SRC).toContain('if (!input.isAutoRepeat) win.webContents.send(IPC.appZoomActualSize)')
  })
})
