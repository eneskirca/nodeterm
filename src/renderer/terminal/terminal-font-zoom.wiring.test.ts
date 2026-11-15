import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { flowToNodeStates, nodeStatesToFlow, type CanvasNode } from '../state/workspace'
import { toKanbanSessionState } from '../canvas/toKanbanSessionState'
import { toKanbanSession } from '../canvas/toKanbanSession'
import { DEFAULT_SETTINGS, type CanvasNodeState } from '@shared/types'
import { buildShortcutSections, type ShortcutSectionsOptions } from '../components/ShortcutsPanel'

// Issue #915 — per-terminal font size on ⌘+ / ⌘− / ⌘0. The pure decisions are pinned in
// `terminal-font-zoom.test.ts`; this file pins that each surface actually ASKS them, and that the
// override survives persistence. Source pins for the component wiring (the house style for
// TerminalNode / Canvas, which cannot be mounted in a unit test).

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')
const TERMINAL_NODE = read('../nodes/TerminalNode.tsx')
const MODAL = read('../components/kanban/ModalTerminal.tsx')
const PREVIEW = read('../components/settings/TerminalPreview.tsx')
const HOOK = read('./useXtermVisualSettings.ts')
const CANVAS = read('../canvas/Canvas.tsx')
const TERMINAL_SECTION = read('../components/settings/sections/TerminalSection.tsx')

const term = (data: Record<string, unknown> = {}): CanvasNode =>
  ({
    id: 't1',
    type: 'terminal',
    position: { x: 0, y: 0 },
    width: 320,
    height: 240,
    style: { width: 320, height: 240 },
    data: { title: 't1', color: '#fff', group: null, ...data }
  }) as unknown as CanvasNode

describe('terminal font zoom — settings', () => {
  it('ships OFF, so ⌘+/⌘−/⌘0 keep today’s behaviour until the user opts in', () => {
    expect(DEFAULT_SETTINGS.terminalFontZoomKeys).toBe(false)
  })
  it('is a Switch in Settings → Terminal, and the size field uses the shared bounds', () => {
    expect(TERMINAL_SECTION).toContain('terminalFontZoomKeys')
    expect(TERMINAL_SECTION).toContain('min={TERMINAL_FONT_SIZE_MIN}')
    expect(TERMINAL_SECTION).toContain('max={TERMINAL_FONT_SIZE_MAX}')
  })
})

describe('terminal font zoom — persistence', () => {
  it('survives the flow → state → flow round trip', () => {
    const states = flowToNodeStates([term({ terminalFontSize: 17 })])
    expect(states[0].terminalFontSize).toBe(17)
    expect(nodeStatesToFlow(states)[0].data.terminalFontSize).toBe(17)
  })
  it('drops a garbage hand-edited value on the way in and on the way out', () => {
    const inState = { ...flowToNodeStates([term()])[0], terminalFontSize: 400 } as CanvasNodeState
    expect(nodeStatesToFlow([inState])[0].data.terminalFontSize).toBeUndefined()
    expect(flowToNodeStates([term({ terminalFontSize: 'big' })])[0].terminalFontSize).toBeUndefined()
  })
  it('an unset override stays absent (no key churn in project.json)', () => {
    expect(flowToNodeStates([term()])[0].terminalFontSize).toBeUndefined()
  })
})

describe('terminal font zoom — the card modal follows the node', () => {
  it('carries the override in the modal spawn from live nodes and from persisted state', () => {
    expect(toKanbanSession(term({ terminalFontSize: 15 }))?.spawn.terminalFontSize).toBe(15)
    const state = flowToNodeStates([term({ terminalFontSize: 15 })])[0]
    expect(toKanbanSessionState(state)?.spawn.terminalFontSize).toBe(15)
  })
})

describe('terminal font zoom — one options path', () => {
  it('the visual-settings hook layers the override through withTerminalFontSize', () => {
    expect(HOOK).toContain('withTerminalFontSize(')
    expect(HOOK).toMatch(/useXtermVisualSettings\(\s*projectId\?: string,\s*fontSizeOverride\?: unknown/)
  })
  it('the canvas node and the modal pass the node override; the settings preview does not', () => {
    expect(TERMINAL_NODE).toContain('useXtermVisualSettings(owningProjectId(), data.terminalFontSize)')
    expect(MODAL).toContain('useXtermVisualSettings(owningProjectId(), spawn.terminalFontSize)')
    expect(PREVIEW).toContain('useXtermVisualSettings()')
  })
})

describe('terminal font zoom — every new xterm is built from the EFFECTIVE visual (review round 2)', () => {
  // A refresh (respawnNonce) or an offscreen-release revive recreates the xterm inside the same
  // mount, where the [visual, glass] live-options effect does NOT re-run — so the instance must be
  // born with the node's override (and the project's theme/font), never the bare global settings.
  for (const [name, src] of [
    ['TerminalNode', TERMINAL_NODE],
    ['ModalTerminal', MODAL]
  ] as const) {
    it(`${name}: new Terminal(...) reads visualRef.current, mirrored every render`, () => {
      const ctor = src.slice(src.indexOf('new Terminal(xtermOptionsFromSettings('))
      expect(ctor.slice(0, ctor.indexOf('\n'))).toContain('xtermOptionsFromSettings(visualRef.current,')
      expect(src).toContain('visualRef.current = visual')
    })
  }
})

describe('terminal font zoom — key wiring', () => {
  for (const [name, src] of [
    ['TerminalNode', TERMINAL_NODE],
    ['ModalTerminal', MODAL]
  ] as const) {
    it(`${name}: its xterm key handler asks the decision and hands the step to Canvas`, () => {
      const start = src.indexOf('term.attachCustomKeyEventHandler(')
      const handler = src.slice(start, src.indexOf('\n    })', start))
      expect(handler).toContain('terminalFontZoomAction(e,')
      expect(handler).toContain('requestTerminalFontZoom(')
      // Swallowed: xterm must not also write ^_ for Ctrl+− off-mac.
      expect(handler).toMatch(/requestTerminalFontZoom\([^)]*\)[\s\S]{0,80}return false/)
    })
    it(`${name}: stamps the xterm host with the node id for the desktop ⌘0 route`, () => {
      expect(src).toContain('[FONT_ZOOM_NODE_ATTR]:')
    })
  }

  it('Canvas is the single writer: event → nextTerminalFontSizeOverride → markDirty', () => {
    const start = CANVAS.indexOf('TERMINAL_FONT_ZOOM_EVENT, onFontZoom')
    expect(start).toBeGreaterThan(-1)
    const body = CANVAS.slice(CANVAS.lastIndexOf('useEffect(', start), start)
    expect(body).toContain('nextTerminalFontSizeOverride(')
    expect(body).toContain('markDirty()')
  })

  it('mirrors the step into the projects store so the Omni board (which reads it) updates live', () => {
    const start = CANVAS.indexOf('TERMINAL_FONT_ZOOM_EVENT, onFontZoom')
    const body = CANVAS.slice(CANVAS.lastIndexOf('useEffect(', start), start)
    expect(body).toContain('patchProjectFontSize(')
    // Same epoch guard commitActiveToStore uses: never patch another project's stored nodes.
    expect(body).toContain('canCommitCanvas(nodesProjectIdRef.current,')
  })

  it('the forwarded desktop ⌘0 resets a focused terminal BEFORE falling back to canvas zoom', () => {
    const start = CANVAS.indexOf('window.nodeTerminal.onZoomActualSize(')
    const body = CANVAS.slice(start, CANVAS.indexOf('})', start))
    const reset = body.indexOf("requestTerminalFontZoom(target, 'reset')")
    expect(reset).toBeGreaterThan(-1)
    expect(reset).toBeLessThan(body.indexOf('zoomTo100()'))
    expect(body).toContain('fontZoomTargetNodeId(')
    // Review of #915: the reset asks the platform predicate over the FORWARDED modifiers, so a mac
    // Ctrl+0 keeps its old meaning (canvas zoom when allowed) instead of clearing the override.
    expect(body).toContain('forwardedResetMatches(mods,')
  })

  it('a node whose font leaves the shared glyph atlas paints its own pixels (glyphOff)', () => {
    const line = TERMINAL_NODE.slice(TERMINAL_NODE.indexOf('const glyphOff ='))
    const decl = line.slice(0, line.indexOf('\n'))
    expect(decl).toContain('fontLeavesAtlas')
    expect(TERMINAL_NODE).toMatch(/const fontLeavesAtlas = leavesSharedGlyphAtlas\(visual\.fontSize,/)
  })
})

describe('terminal font zoom — shortcuts panel', () => {
  const BASE: ShortcutSectionsOptions = {
    isMac: true,
    browser: false,
    panHoverDelay: 500,
    dragMode: 'select',
    doubleClickFocus: false,
    focusFollowsPointer: true,
    wheelZoom: false,
    bindingsFor: () => []
  }
  const labels = (o: Partial<ShortcutSectionsOptions>): string[] =>
    buildShortcutSections({ ...BASE, ...o }).flatMap((s) => s.rows.map((r) => r.label))
  it('advertises the terminal font rows only when the setting is on', () => {
    expect(labels({})).not.toContain('Terminal font size bigger / smaller')
    expect(labels({ terminalFontZoomKeys: true })).toContain('Terminal font size bigger / smaller')
    expect(labels({ terminalFontZoomKeys: true })).toContain('Terminal font size back to the global size')
  })
})

describe('terminal font zoom — cards of another project (Omni board) and notices', () => {
  const writer = CANVAS.slice(CANVAS.indexOf('const onFontZoom = (e: Event)'))
  const body = writer.slice(0, writer.indexOf('window.addEventListener(TERMINAL_FONT_ZOOM_EVENT'))
  it('a node that is not on the live canvas is written through the store and persisted, never dropped', () => {
    expect(body).toContain('nodeOwner(st.projects, d.nodeId)')
    expect(body).toContain('applyOwnNodeMutation(owner.id')
    expect(body).toContain('void persist()')
  })
  it('a relay tab keeps its host-owned nodes untouched', () => {
    expect(body).toContain('owner.remote')
  })
  it('both paths raise the info notice from the one pure text', () => {
    expect(body.match(/fontZoomNoticeText\(/g)).toHaveLength(2)
    expect(body).toContain("setNotice({ kind: 'info'")
  })
})
