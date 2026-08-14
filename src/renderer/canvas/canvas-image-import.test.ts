// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  canvasImagePasteArmedAfterKey,
  canvasImportRefusal,
  guardedCanvasImagePlacements,
  isCanvasImageDropTarget
} from './canvas-image-import'

describe('canvasImportRefusal', () => {
  it('refuses a relay tab, whose write and read land on different machines', () => {
    // The write is the LOCAL preload's, the node reads through the peer's core — so the node could
    // never render its own file. A message beats a broken node.
    expect(canvasImportRefusal(true)).toMatch(/remote tab/i)
    expect(canvasImportRefusal(false)).toBe(null)
  })
})

describe('isCanvasImageDropTarget', () => {
  it('accepts the real pane and rejects flow-wrap overlays and nodes', () => {
    const wrap = document.createElement('div')
    wrap.innerHTML = `
      <div class="react-flow__pane"><div class="react-flow__node"><span>node</span></div></div>
      <div class="welcome"><button>open</button></div>
      <div class="usage-indicator"><div class="usage-popover">usage</div></div>
    `
    const pane = wrap.querySelector('.react-flow__pane')!
    expect(isCanvasImageDropTarget(pane, wrap)).toBe(true)
    expect(isCanvasImageDropTarget(wrap.querySelector('.react-flow__node span'), wrap)).toBe(false)
    expect(isCanvasImageDropTarget(wrap.querySelector('.welcome'), wrap)).toBe(false)
    expect(isCanvasImageDropTarget(wrap.querySelector('.usage-popover'), wrap)).toBe(false)
  })

  it('rejects dialogs and sidebars outside the canvas wrapper', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="flow-wrap"><div class="react-flow__pane"></div></div>
      <div role="dialog">settings</div>
      <aside class="sessions-sidebar">sessions</aside>
    `
    const wrap = root.querySelector('.flow-wrap')!
    expect(isCanvasImageDropTarget(root.querySelector('[role="dialog"]'), wrap)).toBe(false)
    expect(isCanvasImageDropTarget(root.querySelector('.sessions-sidebar'), wrap)).toBe(false)
  })
})

describe('guardedCanvasImagePlacements', () => {
  it('places every resolved path while the originating project remains active', async () => {
    await expect(
      guardedCanvasImagePlacements(
        async () => ['/tmp/a.png', '/tmp/b.png'],
        'project-a',
        () => 'project-a',
        { x: 10, y: 20 }
      )
    ).resolves.toEqual([
      { filePath: '/tmp/a.png', center: { x: 10, y: 20 } },
      { filePath: '/tmp/b.png', center: { x: 46, y: 56 } }
    ])
  })

  it('abandons an async result after a project switch', async () => {
    let release!: (paths: string[]) => void
    const pending = new Promise<string[]>((resolve) => (release = resolve))
    let active = 'project-a'
    const placements = guardedCanvasImagePlacements(
      () => pending,
      'project-a',
      () => active,
      { x: 10, y: 20 }
    )
    active = 'project-b'
    release(['/tmp/a.png'])
    await expect(placements).resolves.toEqual([])
  })
})

describe('canvasImagePasteArmedAfterKey', () => {
  it('preserves a real Cmd+V sequence but revokes arming for a keyboard-opened overlay', () => {
    const meta = { key: 'Meta', metaKey: true, ctrlKey: false }
    const paste = { key: 'v', metaKey: true, ctrlKey: false }
    const openSettings = { key: ',', metaKey: true, ctrlKey: false }

    expect(canvasImagePasteArmedAfterKey(true, meta)).toBe(true)
    expect(canvasImagePasteArmedAfterKey(true, paste)).toBe(true)
    expect(canvasImagePasteArmedAfterKey(true, openSettings)).toBe(false)
    expect(canvasImagePasteArmedAfterKey(false, paste)).toBe(false)
  })
})
