import { describe, it, expect } from 'vitest'
import { buildAgentApi } from './ws-bridge'
import { IPC } from '../../shared/ipc'

function fakeClient() {
  const subs: Array<{ channel: string }> = []
  const requests: Array<{ channel: string; arg: unknown }> = []
  return {
    subs,
    requests,
    subscribe: (channel: string, _fn: (...a: unknown[]) => void) => {
      subs.push({ channel })
      return () => {}
    },
    request: (channel: string, arg?: unknown) => {
      requests.push({ channel, arg })
      return Promise.resolve()
    }
  }
}

describe('buildAgentApi', () => {
  it('onAgentStatus / onSubagentActivity subscribe to the right channels and return an unsub', () => {
    const c = fakeClient()
    const api = buildAgentApi(c as never)
    const un1 = api.onAgentStatus(() => {})
    const un2 = api.onSubagentActivity(() => {})
    expect(c.subs).toEqual([
      { channel: IPC.agentStatus },
      { channel: IPC.agentSubagentActivity }
    ])
    expect(typeof un1).toBe('function')
    expect(typeof un2).toBe('function')
  })

  it('ackDone fires a fire-and-forget request on the ack-done channel', () => {
    const c = fakeClient()
    const api = buildAgentApi(c as never)
    api.ackDone('nt-x')
    expect(c.requests).toEqual([{ channel: IPC.agentAckDone, arg: 'nt-x' }])
  })

  it('requests the restart-safe status snapshot from the connected core', async () => {
    const c = fakeClient()
    const api = buildAgentApi(c as never)
    await api.agentStatusSnapshot()
    expect(c.requests).toEqual([{ channel: IPC.agentStatusSnapshot, arg: undefined }])
  })
})
