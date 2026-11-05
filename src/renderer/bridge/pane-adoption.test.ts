import { afterEach, expect, it, vi } from 'vitest'
import { buildRelayApi } from './relay-api'
import { buildStubApi } from './stubs'
import type { NodeTerminalApi } from '../../shared/types'
import type { FrameTransport } from './frame-transport'
afterEach(() => vi.unstubAllGlobals())
it.each([false, true])('relay cannot inherit local human adoption or forward it (hosted=%s)', hosted => {
  const adopt = vi.fn(), send = vi.fn()
  const local = { pty: { onData: vi.fn() }, claude: { cliCaps: vi.fn() }, relayClient: { disconnect: vi.fn() }, paneOwnership: { adopt } } as unknown as NodeTerminalApi
  vi.stubGlobal('window', { nodeTerminal: local })
  const transport: FrameTransport = { send, onMessage: () => {}, onClose: () => {}, ready: async () => {} }
  const relay = buildRelayApi('synthetic-relay', transport, { hosted })
  expect(relay.api.paneOwnership).toBeUndefined()
  expect(adopt).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
})
it('browser/server stub exposes no local human ownership action', () => {
  expect(buildStubApi().paneOwnership).toBeUndefined()
})
