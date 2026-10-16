// The hidden-window reclaim is three files of wiring around one pure module, and every link is a
// way it could compile and do nothing: main never sends, Canvas never sets the flag, or the node's
// observer never re-states its verdict on the edge. Neither main/index.ts nor Canvas/TerminalNode
// can be mounted here, so the wiring is pinned at source level; the decisions are behaviour-tested
// in window-backgrounded.test.ts and main/window-visibility.test.ts.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string): string =>
  readFileSync(join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')

describe('hidden-window reclaim wiring', () => {
  it('main sends the signal for every window visibility event', () => {
    const main = read('../../main/index.ts')
    expect(main).toMatch(/for \(const ev of WINDOW_VISIBILITY_EVENTS\)/)
    expect(main).toContain('windowVisibilitySignal(ev, { hiddenByApp: windowHiddenByApp })')
    expect(main).toContain('win.webContents.send(IPC.appWindowVisibility, signal)')
    // Only the app's OWN hide counts (macOS emits `hide` on mere occlusion): every `win.hide()` in
    // main is the close branch's, and each one is preceded by the flag.
    const hides = (main.match(/^\s*win\.hide\(\)\s*$/gm) ?? []).length
    const flagged = main.split('windowHiddenByApp = true\n').length - 1
    expect(hides).toBeGreaterThan(0)
    expect(flagged).toBe(hides)
  })

  it('the preload forwards it and the Server Edition declares it a no-op', () => {
    expect(read('../../preload/index.ts')).toContain('ipcRenderer.on(IPC.appWindowVisibility, handler)')
    expect(read('../bridge/stubs.ts')).toMatch(/onWindowVisibility: noopUnsub/)
  })

  it('Canvas sets the flag and runs the shared reclaim pair after the dwell', () => {
    const canvas = read('../canvas/Canvas.tsx')
    const at = canvas.indexOf('const onSignal = (state:')
    expect(at).toBeGreaterThan(-1)
    const effect = canvas.slice(at, canvas.indexOf('}, [])', at))
    expect(effect).toContain('setWindowBackgrounded(hidden)')
    expect(effect).toContain('BACKGROUND_RELEASE_DWELL_MS')
    expect(effect).toContain('runReclaimLevers()')
    // A focused document is being looked at: it clears a missed 'shown'.
    expect(effect).toContain("window.addEventListener('focus', onFocus)")
    // Memory pressure shares the same pair rather than a second copy of it.
    expect(canvas).toContain('onMemoryPressure?.(() => runReclaimLevers())')
  })

  it('the node re-states its effective verdict on the backgrounded edge, through the one path', () => {
    const node = read('../nodes/TerminalNode.tsx')
    expect(node).toContain('onVerdict(effectiveVisible(intersecting, isWindowBackgrounded()))')
    expect(node).toContain('if (observed) onVerdict(effectiveVisible(intersecting, bg))')
    expect(node).toMatch(/backgroundReleaseMs\(\s*offscreenDisposeMs\(/)
  })
})
