import { expect, it, vi } from 'vitest'
import { deliverRelayInitialLaunch } from './relay-initial-launch'
import { flowToNodeStates, createTerminalNode } from '../state/workspace'
import type { PendingLaunch } from '@shared/types'

async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve() }
function fixture() {
  const scope = { workspace: { load: vi.fn(), save: vi.fn() } }
  const node = createTerminalNode(0)
  node.data.initialCommand = 'claude brief'
  const cleanups: Array<() => void> = []
  let ready!: () => void, echo!: (text: string) => void
  const input = vi.fn(), failure = vi.fn(), shellReady = vi.fn(async () => true)
  const launch = (fresh = true, pending?: PendingLaunch) => deliverRelayInitialLaunch({
    scope, id: node.id, command: 'claude brief', fresh, pending,
    consume: () => { node.data.initialCommand = undefined },
    whenReady: (run) => { ready = run }, onFailure: failure,
    writer: { shellReady, killLine: '\x15', cleanup: (fn) => { cleanups.push(fn) },
      io: { write: input, onData: (cb) => { echo = cb; return () => {} } } }
  })
  return { scope, node, launch, input, failure, shellReady,
    ready: () => ready?.(), echo: (s: string) => echo?.(s), dispose: () => cleanups.forEach((fn) => fn()) }
}
it('new relay UI initial command uses verified delivery once without durable intent or workspace calls', async () => {
  const f = fixture()
  // A pre-mount peer publication must not manufacture a pending launch on the host.
  expect(flowToNodeStates([f.node], false)[0].pendingLaunch).toBeUndefined()
  f.launch()
  expect(f.node.data.initialCommand).toBeUndefined()
  expect(f.node.data.pendingLaunch).toBeUndefined()
  f.ready()
  await tick()
  expect(f.input.mock.calls).toEqual([['claude brief']])
  f.echo('claude brief')
  await tick()
  f.ready()
  f.launch() // stale alias/remount cannot obtain another transient attempt
  f.ready()
  await tick()
  expect(f.input.mock.calls).toEqual([['claude brief'], ['\r']])
  expect(f.scope.workspace.load).not.toHaveBeenCalled()
  expect(f.scope.workspace.save).not.toHaveBeenCalled()
  expect(flowToNodeStates([f.node], false)[0].pendingLaunch).toBeUndefined()
})
it('a failed shell check cannot be retried or replayed on remount', async () => {
  const f = fixture()
  f.shellReady.mockResolvedValueOnce(false)
  f.launch(); f.ready(); await tick()
  f.ready(); f.launch(); f.ready(); await tick()
  expect(f.input).not.toHaveBeenCalled()
  expect(f.failure).toHaveBeenCalledTimes(1)
})
it('teardown before settle consumes the attempt without replaying after remount', async () => {
  const f = fixture()
  f.launch(); f.dispose(); f.ready(); await tick()
  f.launch(); f.ready(); await tick()
  expect(f.input).not.toHaveBeenCalled()
})
it.each([undefined, { after: [], command: 'claude brief', attempted: false },
  { after: [], command: 'claude brief', attempted: true }])('never grants a warm/restored initial command a transient attempt (%j)', async (pending) => {
  const f = fixture()
  f.launch(false, pending); f.ready(); await tick()
  f.launch(true); f.ready(); await tick()
  expect(f.input).not.toHaveBeenCalled()
  expect(f.scope.workspace.save).not.toHaveBeenCalled()
})
it('a fresh PTY does not bypass a restored or queued durable launch', async () => {
  const f = fixture()
  f.launch(true, { after: [], command: 'claude brief', attempted: false })
  f.ready(); await tick()
  expect(f.input).not.toHaveBeenCalled()
})
it('local serialization keeps durable UI intent while relay serialization preserves only existing queued intent', () => {
  const f = fixture()
  expect(flowToNodeStates([f.node])[0].pendingLaunch).toEqual({ after: [], command: 'claude brief', attempted: false })
  f.node.data.pendingLaunch = { after: ['upstream'], command: 'other', attempted: false }
  expect(flowToNodeStates([f.node], false)[0].pendingLaunch).toEqual(f.node.data.pendingLaunch)
})

it('uncertain delivery after input never pastes again on remount', async () => {
  const f = fixture()
  f.launch(); f.ready(); await tick()
  expect(f.input.mock.calls).toEqual([['claude brief']])
  f.dispose(); await tick()
  f.launch(); f.ready(); await tick()
  expect(f.input.mock.calls).toEqual([['claude brief']])
  expect(f.failure).toHaveBeenCalledWith('cancelled')
  expect(f.scope.workspace.save).not.toHaveBeenCalled()
})
