import { describe, expect, it } from 'vitest'
import { retryInterruptedSessionRead } from './session-host-read-retry'
import type { SessionHostRequestBody } from '../session-host/protocol'

describe('session backend interrupted-read retry', () => {
  const lost = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  it.each<SessionHostRequestBody>([
    { cmd: 'hasSession', name: 'ours' }, { cmd: 'capture', name: 'ours', full: true },
    { cmd: 'historySearchV1', name: 'ours', generation: 'our-generation', query: 'literal' },
    { cmd: 'listSessions' }, { cmd: 'paneCommand', name: 'ours' }, { cmd: 'messageOwnerV1', name: 'ours' }, { cmd: 'messagePasteReadyV1', name: 'ours' }
  ])('allows bounded reads after EPIPE: $cmd', (request) => { expect(retryInterruptedSessionRead(request, lost)).toBe(true) })
  it('keeps writes, unknown failures, timeouts and host refusals non-retryable', () => {
    const writes: SessionHostRequestBody[] = [
      { cmd: 'write', name: 'ours', data: 'input' }, { cmd: 'resize', name: 'ours', cols: 80, rows: 24 },
      { cmd: 'sendKeysV2', name: 'ours', text: 'answer', enter: true }, { cmd: 'pause', name: 'ours' },
      { cmd: 'resume', name: 'ours' }, { cmd: 'detach', name: 'ours' }, { cmd: 'killSession', name: 'ours', operationId: 'our-operation', reserveReplacement: false }
    ]
    for (const request of writes) expect(retryInterruptedSessionRead(request, lost)).toBe(false)
    for (const error of [new Error('deadline'), new Error('host refused'), Object.assign(new Error('no access'), { code: 'EACCES' }), null]) {
      expect(retryInterruptedSessionRead({ cmd: 'hasSession', name: 'ours' }, error)).toBe(false)
    }
    expect(retryInterruptedSessionRead({ cmd: 'hasSession', name: 'ours' }, Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true)
  })
})
