import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * SOURCE-LEVEL pins for `report-outcome` / `--after-success` wiring — the same remedy
 * `hook-verified-parity.test.ts` uses for the same class of hole: every piece below is well-typed
 * whether or not it is wired (an optional dep left out, a store never registered, a handler that
 * forgets to clear), so a feature can be plumbed end to end, pass `npm run typecheck` and every
 * unit test, and ship INERT on one shell. The behaviour itself is proven against real code in
 * `shared/station-outcome.test.ts`, `core/station-outcome-store.test.ts`,
 * `renderer/lib/pendingLaunch.test.ts` and `server/headless-node-factory.test.ts`.
 */
const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const main = read('./index.ts')
const serverControl = read('../server/canvas-control.ts')
const serverIndex = read('../server/index.ts')
const canvas = read('../renderer/canvas/Canvas.tsx')

describe('desktop main', () => {
  const handler = main.slice(main.indexOf('hookServer.setControlHandler('))

  it('runs the --after-success shape gate before anything is forwarded', () => {
    const gate = handler.indexOf('afterSuccessFlagRefusal(verb, args)')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(handler.indexOf("'window unavailable'"))
  })

  it('answers report-outcome in MAIN, never forwarding it to the renderer', () => {
    const at = handler.indexOf("if (verb === 'report-outcome') {")
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(handler.indexOf('controlForwarder.forward('))
    const block = handler.slice(at, at + 600)
    expect(block).toContain('handleReportOutcome(')
    expect(block).toContain('store: stationOutcomes')
    expect(block).toContain('{ nodeId, args, verified }')
  })

  it('withdraws a station\'s report after new work lands — in the finishing step both answers take', () => {
    // `finishAnswer` runs on the prompt answer AND on a late one (#1033), so a send whose answer
    // arrives after main's timeout still withdraws the report.
    const finish = handler.slice(handler.indexOf('const finishAnswer = ('))
    const body = finish.slice(0, finish.indexOf('\n    }\n'))
    expect(body).toContain('clearOutcomesAfterControl(stationOutcomes, verb, args, answer, nodeId)')
    expect(handler).toMatch(/finish: finishAnswer/)
  })

  it('wires the messaging layer\'s hand-over events — send / reply are decided by when they LAND', () => {
    expect(main).toMatch(/messagingDeps\.onHandover = \(ev\) => \{\s*stationOutcomes\.onHandover\(ev\)/)
  })

  it('registers the read channel and pushes every change to the window', () => {
    expect(main).toContain('registerStationOutcomeIpc(corePlatform, () => stationOutcomes)')
    expect(main).toMatch(/new StationOutcomeStore\(\s*\(records\) =>\s*sendToMain\(IPC\.stationOutcomeChanged, records\)/)
  })

  it('persists the store and the delivery queue, and loads them after the status mirror (durable state)', () => {
    expect(main).toMatch(/const stationOutcomesFile = new DurableFactFile\(OUTCOME_FACT/)
    expect(main).toContain("durable: stationOutcomesFile")
    expect(main).toMatch(/createDeliveryQueue\(messagingDeps, \{ durable: deliveryQueueFile \}\)/)
    const mirror = main.indexOf('initAgentStatusMirror()\n')
    const load = main.indexOf('stationOutcomes.loadFromDisk()')
    const holds = main.indexOf('stationHandovers.loadFromDisk()')
    const queue = main.indexOf('restoreDeliveryQueue(messagingDeps.queue, deliveryQueueFile, {')
    expect(mirror).toBeGreaterThan(-1)
    expect(load).toBeGreaterThan(mirror)
    expect(holds).toBeGreaterThan(load)
    expect(queue).toBeGreaterThan(holds)
    expect(main).toMatch(/const stationHandoversFile = new DurableFactFile\(HANDOVER_FACT/)
    // A station's new session withdraws its report BEFORE the renderer hears the event.
    const withdraw = main.indexOf('stationOutcomes.onAgentEvent(enriched)')
    expect(withdraw).toBeGreaterThan(-1)
    expect(withdraw).toBeLessThan(main.indexOf('sendToMain(IPC.agentStatus, enriched)'))
    expect(main).toContain('flushAllDurableFactsSync()')
    // The restore waits for the workspace index, or a restore-time expiry reaches no sender.
    expect(main.slice(queue, queue + 200)).toContain('ready: workspaceStore.load({ sideline: false })')
    // A second instance that lost the hook endpoint stands every durable file down.
    const gate = main.indexOf('const hookStartupWarning = await hookServer.startForApp()')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(load)
    expect(main.slice(gate, gate + 900)).toMatch(
      /if \(hookStartupWarning\) \{\s*for \(const f of \[deliveryQueueFile, stationOutcomesFile, stationHandoversFile\]\) f\.standDown\(\)/
    )
  })
})

describe('Server Edition', () => {
  it('routes report-outcome through the SAME core handler and re-evaluates its arms', () => {
    const at = serverControl.indexOf('reportOutcome: (sourceNodeId, args, verified) =>')
    expect(at).toBeGreaterThan(-1)
    const block = serverControl.slice(at, at + 900)
    expect(block).toContain('handleReportOutcome(')
    expect(block).toContain('onRecorded: () => void factory.refreshArmed()')
  })

  it('wires the same hand-over events into its messaging deps', () => {
    expect(serverControl).toMatch(/onHandover: \(ev\) => \{\s*stationOutcomes\.onHandover\(ev\)/)
  })

  it('hands the factory the outcome store, so --after-success is honoured headlessly', () => {
    expect(serverControl).toContain('outcomeOf: (nodeId) => stationOutcomes.get(nodeId)')
  })

  it('wraps its control handler with the same "new work withdraws a report" rule', () => {
    expect(serverControl).toContain(
      'clearOutcomesAfterControl(stationOutcomes, req.verb, req.args, reply, req.nodeId)'
    )
  })

  it('persists the store and the queue, and loads them before anything reads them', () => {
    expect(serverControl).toMatch(/durable: outcomesFile/)
    expect(serverControl).toContain('stationOutcomes.loadFromDisk()')
    expect(serverControl).toContain('createDeliveryQueue(messaging, { durable: queueFile })')
    const restore = serverControl.indexOf('await restoreDeliveryQueue(queue, queueFile)')
    expect(restore).toBeGreaterThan(serverControl.indexOf('messaging.onQueuedResult ='))
    const ev = serverControl.indexOf('onAgentEvent: (event) => {')
    expect(serverControl.indexOf('stationOutcomes.onAgentEvent(event)', ev)).toBeLessThan(
      serverControl.indexOf('onMessagingAgentEvent(event, queue)', ev)
    )
    expect(serverControl).toContain('queueFile.dispose()')
    expect(serverControl).toContain('outcomesFile.dispose()')
    expect(serverControl).toContain('handoversFile.dispose()')
    expect(serverControl).toContain('if (deps.ownsDurableState === false) queueFile.standDown()')
    expect(serverIndex).toContain('ownsDurableState: hookStartupWarning === null')
    expect(serverControl.indexOf('stationHandovers.loadFromDisk()')).toBeLessThan(
      serverControl.indexOf('await restoreDeliveryQueue(queue, queueFile)')
    )
  })

  it('registers the read channel whether or not canvas control comes up', () => {
    expect(serverIndex).toContain(
      'registerStationOutcomeIpc(platform, () => canvasControl?.stationOutcomes ?? null)'
    )
  })
})

describe('the desktop renderer', () => {
  it('mirrors core\'s store', () => {
    expect(canvas).toContain('useEffect(() => installStationOutcomeWiring(window.nodeTerminal), [])')
  })

  it('folds --after-success into --after once, before any open path resolves --after', () => {
    const fold = canvas.indexOf('args = { ...args, after: [...new Set([...plainAfter, ...successIdsPre])].join(\',\') }')
    expect(fold).toBeGreaterThan(-1)
    // Before every consumer of `args.after`: the live resolver, the cold resolver, the run-now belt.
    expect(fold).toBeLessThan(canvas.indexOf('const resolveAfter = (): string[] | null | undefined => {'))
    expect(fold).toBeLessThan(canvas.indexOf('const coldAfter = coldResolveAfter('))
    expect(fold).toBeLessThan(canvas.indexOf('reply({ ok: false, error: RUN_NOW_AFTER_REFUSAL })'))
    expect(fold).toBeLessThan(canvas.indexOf('routeControlSource(projects, activeId, sourceNodeId)'))
  })

  it('checks that a success station can REPORT, on the live and the cold path', () => {
    expect(canvas).toMatch(/successIdsPre\.includes\(depId\) && !sourceIsControlCapable\(depAgent\)/)
    expect(canvas).toMatch(/const coldCannotReport = successIdsPre\.find\(/)
  })

  it('attaches the hold on the live path (armAfter) and the cold path', () => {
    const armAfter = canvas.slice(canvas.indexOf('const armAfter = ('), canvas.indexOf('const addGrouped = ('))
    expect(armAfter).toContain('withSuccessHold(')
    expect(armAfter).toContain('successHoldPre')
    const cold = canvas.slice(
      canvas.indexOf('if (canColdOpen(verb)) {'),
      canvas.indexOf('if (answersOffCanvas(verb) || answersFromStoredNodes(verb)) {')
    )
    expect(cold).toMatch(/withSuccessHold\(/)
  })

  it('judges the gate with the outcome store, and re-runs off a PRIMITIVE signature', () => {
    const effect = canvas.slice(canvas.indexOf('const ready = launchesToFire('), canvas.indexOf('}, [nodes, armedDepSig'))
    expect(effect).toContain('{ outcomes: useStationOutcomes.getState().byId, now: Date.now() }')
    const sig = canvas.slice(canvas.indexOf('const armedSuccessSig = useStationOutcomes((s) => {'))
    expect(sig.slice(0, 900)).toContain('sig +=')
  })

  it('list reads the outcomes on both the live and the stored path', () => {
    const hits = canvas.split('useStationOutcomes.getState().byId, useStationHandovers.getState().byId)').length - 1
    expect(hits).toBeGreaterThanOrEqual(2)
  })
})
