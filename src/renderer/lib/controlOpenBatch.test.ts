import { expect, it } from 'vitest'
import { createControlOpenBatch } from './controlOpenBatch'
import { launchesToFire } from './pendingLaunch'

it.each(['open-terminal', 'open-agent', 'open-claude'])('%s on the visible Desktop reports queued before a terminal exists', (verb) => {
  const batch = createControlOpenBatch()
  const nodes = ['one', 'two'].map((id) => batch.add({ id, data: {
    initialCommand: verb === 'open-terminal' ? 'echo brief' : 'claude complete-brief'
  } }))
  expect(batch.result()).toEqual({ ids: ['one', 'two'], id: 'one', after: [], queued: true, queuedIds: ['one', 'two'] })
  expect(nodes.every((n) => !n.data.initialCommand)).toBe(true)
  expect(launchesToFire(nodes, {}, new Set(['one', 'two']))).toHaveLength(2)
})
it('keeps plain shells unqueued while accounting for every command-bearing node in a mixed batch', () => {
  const batch = createControlOpenBatch()
  batch.add({ id: 'shell', data: {} })
  batch.add({ id: 'agent', data: { initialCommand: 'codex brief' } })
  expect(batch.result(['upstream'])).toEqual({ ids: ['shell', 'agent'], id: 'shell', after: ['upstream'], queued: true, queuedIds: ['agent'] })
  const shell = createControlOpenBatch()
  shell.add({ id: 'plain', data: {} })
  expect(shell.result()).toMatchObject({ queued: false, queuedIds: [] })
})
