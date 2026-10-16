import { afterEach, expect, it } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import { IPC } from '../shared/ipc'

// #1173 through the REAL store's IPC: two clients of one core (two Server Edition tabs) asking to
// claim the same held launch — the second is told another viewer owns it.
afterEach(() => resetPlatformForTests())

it('the workspace:claim-launch handler answers per client', async () => {
  const fake = fakePlatform()
  initPlatform(fake)
  new WorkspaceStore().registerIpc()
  const claim = fake.handlers[IPC.workspaceClaimLaunch]
  expect(await claim(11, 'node-1', 'claude --session-id s', false)).toBe('claimed')
  expect(await claim(12, 'node-1', 'claude --session-id s', false)).toBe('elsewhere')
  expect(await claim(11, 'node-1', 'claude --session-id s', false)).toBe('claimed')
  expect(await claim(12, 'node-1', 'claude --session-id s', true)).toBe('claimed')
})
