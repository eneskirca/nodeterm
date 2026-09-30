// The station-failure notice is only as wired as its SHELLS make it, and no type can say so.
//
// The monitor (src/core/agents/station-notice.ts) is fed by `onAgentEvent`, the renderer's DROPPED
// reports arrive over `registerStationNoticeIpc`, and a recipient can only ever be resolved for a
// node whose `openedBy` the open verbs STAMPED. Every one of those is a call that is perfectly
// well-typed to leave out: a shell that forgets to feed the monitor compiles, passes the monitor's
// own suite (which drives it directly), and ships a feature that never fires. That is the class of
// hole `hook-verified-parity` guards, with the same remedy — pin the wiring at source level.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string): string =>
  readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

/** The body of `const <name> = (…) => { … }` up to its closing line at the declaration's indent. */
function arrowBody(source: string, decl: string, indent = '  '): string {
  const start = source.indexOf(decl)
  expect(start, `${decl} not found — this guard is looking at the wrong file`).toBeGreaterThan(-1)
  const end = source.indexOf(`\n${indent}}`, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('both shells feed the station-failure monitor', () => {
  it('desktop: the hook stream reaches it, and its IPC is registered', () => {
    const src = read('main/index.ts')
    expect(arrowBody(src, 'const emitAgentStatus = ')).toContain('stationNotices.onAgentEvent(enriched)')
    expect(src).toContain('registerStationNoticeIpc(corePlatform, () => stationNotices)')
    expect(src).toContain('stationNotices.start()')
    // The recipient comes from MAIN's persisted canvases — never from the renderer.
    expect(src).toContain('stationRecipient(workspaceStore.persistedCanvases(), id)')
    // …and the pane leg is the messaging service with every gate, not a raw write.
    expect(src).toContain('deliverStationNotice(notice, messagingDeps)')
    // The question row's one fact, and the queued notice's final outcome — both optional-looking
    // hookups a shell can drop and still compile.
    expect(src).toContain('pendingQuestionOf: (id) => mirrorEntry(id)?.pendingQuestion?.toolUseId')
    expect(src).toContain(
      'messagingDeps.onQueuedResult = (req, outcome) => stationNotices.onQueuedResult(req, outcome)'
    )
  })

  it('Server Edition: the canvas-control runtime feeds it and asks its creator ledger', () => {
    const cc = read('server/canvas-control.ts')
    expect(arrowBody(cc, 'onAgentEvent: (event) => {', '    ')).toContain(
      'stationNotices.onAgentEvent(event)'
    )
    expect(cc).toContain('factory.openerOf(stationNodeId)')
    expect(cc).toContain('deliverStationNotice(notice, messaging)')
    expect(cc).toContain('pendingQuestionOf: (nodeId) => mirrorEntry(nodeId)?.pendingQuestion?.toolUseId')
    expect(cc).toContain(
      'messaging.onQueuedResult = (req, outcome) => stationNotices.onQueuedResult(req, outcome)'
    )
    const idx = read('server/index.ts')
    expect(idx).toContain('registerStationNoticeIpc(platform, () => canvasControl?.stationNotices ?? null)')
  })
})

describe('every canvas-control open path records the opener beside its rope', () => {
  const canvas = read('renderer/canvas/Canvas.tsx')

  it('the live `connect` (addAndConnect, verify, spawn-team) stamps as it ropes', () => {
    const body = arrowBody(canvas, 'const connect = (newId: string) => {', '      ')
    expect(body).toContain('stampOpenedBy(ns, newId, sourceNodeId)')
    expect(body).toContain('ropeEdge(`ctrl-${sourceNodeId}-${newId}`')
  })

  it('the off-canvas and cold-open writes stamp the node they rope', () => {
    expect(canvas).toContain('node: flowToNodeStates([withOpenedBy(placed, sourceNodeId)])[0]')
    // The cold open stamps the node as it is built, right where `--after` (and any `--after-pr`
    // / `--after-success` hold, via withPrHold / withSuccessHold) is folded into its hold.
    expect(canvas).toMatch(/const node = withOpenedBy\(\s*(?:withSuccessHold\(\s*)?(?:withPrHold\(\s*)?held && coldAfterIds\.length[\s\S]{0,500}?sourceNodeId\s*\)/)
  })

  it('the renderer mirrors the list and reports DROPPED on the app api', () => {
    expect(canvas).toContain('installStationNoticeWiring(window.nodeTerminal)')
  })
})
