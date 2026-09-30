import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * SOURCE-LEVEL pins for the plain `--after` hand-over rule (src/core/station-handover.ts). Every
 * piece is well-typed whether or not it is wired — an optional `handedOver` dep left out, a tracker
 * never fed agent events, a `launchesToFire` call without its trailing argument — so the rule could
 * be plumbed end to end and ship INERT on one shell. The behaviour is proven against real code in
 * `core/station-handover.test.ts`, `test/acceptance/after-handover.test.ts` and
 * `server/headless-node-factory.test.ts`.
 */
const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const main = read('./index.ts')
const serverControl = read('../server/canvas-control.ts')
const serverIndex = read('../server/index.ts')
const canvas = read('../renderer/canvas/Canvas.tsx')

describe('desktop main', () => {
  it('feeds the messaging layer\'s hand-over events to the tracker', () => {
    expect(main).toMatch(/messagingDeps\.onHandover = \(ev\) => \{[^}]*stationHandovers\.onHandover\(ev\)/)
  })

  it('feeds every agent event to the tracker BEFORE the messaging queue can flush on it', () => {
    const emit = main.slice(main.indexOf('const emitAgentStatus = ('))
    const tracker = emit.indexOf('stationHandovers.onAgentEvent(enriched)')
    expect(tracker).toBeGreaterThan(-1)
    expect(tracker).toBeLessThan(emit.indexOf('onMessagingAgentEvent(enriched)'))
  })

  it('marks write / run in the finishing step both answers take, from when the request arrived', () => {
    const handler = main.slice(main.indexOf('hookServer.setControlHandler('))
    expect(handler.slice(0, 400)).toContain('const requestAt = Date.now()')
    const finish = handler.slice(handler.indexOf('const finishAnswer = ('))
    const body = finish.slice(0, finish.indexOf('\n    }\n'))
    expect(body).toContain('stationHandovers.noteControlAnswer(verb, args, answer, nodeId, requestAt)')
  })

  it('registers the read channel and pushes every change to the window', () => {
    expect(main).toContain('registerStationHandoverIpc(corePlatform, () => stationHandovers)')
    expect(main).toMatch(/new StationHandoverTracker\(\s*\(records\) =>\s*sendToMain\(IPC\.stationHandoverChanged, records\)/)
  })
})

describe('Server Edition', () => {
  it('gives the headless factory the tracker and feeds it the same events', () => {
    expect(serverControl).toContain('handedOver: (nodeId) => stationHandovers.isHandedOver(nodeId)')
    expect(serverControl).toMatch(/onHandover: \(ev\) => \{[^}]*stationHandovers\.onHandover\(ev\)/)
    const on = serverControl.slice(serverControl.indexOf('onAgentEvent: (event) => {'))
    const tracker = on.indexOf('stationHandovers.onAgentEvent(event)')
    expect(tracker).toBeGreaterThan(-1)
    expect(tracker).toBeLessThan(on.indexOf('onMessagingAgentEvent(event, queue)'))
    expect(tracker).toBeLessThan(on.indexOf('factory.onAgentEvent(event)'))
    expect(serverControl).toContain(
      'stationHandovers.noteControlAnswer(req.verb, req.args, reply, req.nodeId, requestAt)'
    )
    expect(serverIndex).toContain('registerStationHandoverIpc(platform, () => canvasControl?.stationHandovers ?? null)')
  })

  it('re-evaluates the factory\'s arms on EVERY tracker change (a SessionEnd clears a hold too)', () => {
    const at = serverControl.indexOf('const stationHandovers = new StationHandoverTracker(')
    const publish = serverControl.slice(at, serverControl.indexOf('})', at))
    expect(publish).toContain('void factoryRef?.refreshArmed()')
    expect(serverControl).toContain('factoryRef = factory')
  })
})

describe('renderer', () => {
  it('installs the mirror and passes it to the launch loop and to list', () => {
    expect(canvas).toContain('installStationHandoverWiring(window.nodeTerminal)')
    const call = canvas.slice(canvas.indexOf('const ready = launchesToFire('))
    expect(call.slice(0, call.indexOf('.filter('))).toContain('useStationHandovers.getState().byId')
    expect(canvas).toContain('armedHandoverSig')
    // A `write` is stamped when the renderer STARTED TYPING, after the human's confirm.
    const write = canvas.slice(canvas.indexOf('const runWrite = async (): Promise<void> => {'))
    const body = write.slice(0, write.indexOf('\n            }\n'))
    expect(body.indexOf('typedAt = Date.now()')).toBeGreaterThan(-1)
    expect(body.indexOf('typedAt = Date.now()')).toBeLessThan(body.indexOf('api.pty.sendText('))
    expect(body).toContain('result: { typedAt }')
    expect(canvas.match(/useStationOutcomes\.getState\(\)\.byId, useStationHandovers\.getState\(\)\.byId\)/g)).toHaveLength(2)
  })
})
