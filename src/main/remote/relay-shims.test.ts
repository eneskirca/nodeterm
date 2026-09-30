// src/main/remote/relay-shims.test.ts
// The move must be invisible to the desktop: the old paths re-export the SAME objects, so a
// vi.mock of an old path still intercepts desktop callers and nothing is duplicated.
import { describe, it, expect } from 'vitest'
import * as coreE2ee from '../../core/relay/e2ee'
import * as mainE2ee from './e2ee'
import * as coreSocket from '../../core/relay/relay-socket'
import * as mainSocket from './relay-socket'
import * as coreScope from '../../core/relay/relay-project-scope'
import * as mainScope from './relay-project-scope'
import * as coreCore from '../../core/relay/approved-devices-core'
import * as mainCore from './approved-devices-core'

describe('relay module move', () => {
  it('old paths re-export the identical core functions', () => {
    expect(mainE2ee.deriveSharedKey).toBe(coreE2ee.deriveSharedKey)
    expect(mainSocket.connectRelay).toBe(coreSocket.connectRelay)
    expect(mainScope.outOfProjectScope).toBe(coreScope.outOfProjectScope)
    expect(mainCore.pinDevice).toBe(coreCore.pinDevice)
  })
})
