import { afterEach, expect, it, vi } from 'vitest'
import { buildRelayApi } from './relay-api'
import { buildStubApi } from './stubs'
import type { NodeTerminalApi } from '../../shared/types'
import type { FrameTransport } from './frame-transport'
afterEach(() => vi.unstubAllGlobals())

it.each([false, true])('relay cannot inherit local recovery or forward it over transport (hosted=%s)', async hosted => {
  const localRead = vi.fn(), send = vi.fn()
  const local = { pty: { onData: vi.fn() }, claude: { cliCaps: vi.fn() }, relayClient: { disconnect: vi.fn() },
    agentMailbox: { legacyView: localRead } } as unknown as NodeTerminalApi
  vi.stubGlobal('window', { nodeTerminal: local })
  const transport: FrameTransport = { send, onMessage: () => {}, onClose: () => {}, ready: async () => {} }
  const relay = buildRelayApi('synthetic-relay', transport, { hosted })
  expect(await relay.api.agentMailbox.legacyView({ kind: 'list' })).toMatchObject({ ok: false, code: 'unsupported-edition' })
  expect(localRead).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
})
it('browser/server bridge stub has no local recovery capability', async () => {
  expect(await buildStubApi().agentMailbox.legacyView({ kind: 'list' })).toMatchObject({ ok: false, code: 'unsupported-edition' })
})
