import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// #1173: the cross-viewer launch claim is optional at every hop (an older core, a test double), so
// a dropped hop compiles and ships the fix inert. Pin each hop at source level.
const read = (p: string) => readFileSync(join(__dirname, '../../..', p), 'utf8').replace(/\r\n/g, '\n')

it('core registers the claim channel, keyed by the asking client', () => {
  expect(read('src/core/workspace-store.ts')).toMatch(
    /handleWithSender\(IPC\.workspaceClaimLaunch,[\s\S]{0,200}this\.launchClaims\.claim\([^)]*senderId\)/)
})

it('both shells reach it: desktop preload and the Server Edition bridge', () => {
  expect(read('src/preload/index.ts')).toMatch(/claimLaunch:[\s\S]{0,120}IPC\.workspaceClaimLaunch/)
  expect(read('src/renderer/bridge/ws-bridge.ts')).toMatch(/claimLaunch:[\s\S]{0,120}IPC\.workspaceClaimLaunch/)
})

it('the canvas launch claim asks the core before it marks anything', () => {
  const canvas = read('src/renderer/canvas/Canvas.tsx')
  expect(canvas).toMatch(/claim: api\.workspace\.claimLaunch[\s\S]{0,80}api\.workspace\.claimLaunch!\(nodeId, command, manual\)/)
  expect(canvas).toMatch(/if \(outcome === 'elsewhere'\)/)
})

it('a relay peer can never claim (or block) a host launch', () => {
  expect(read('src/shared/host-control.ts')).toMatch(/IPC\.workspaceClaimLaunch/)
})
