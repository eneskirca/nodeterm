import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserControlLedger } from './browser-control-ledger'
import { claimOpenedBrowser } from './browser-open-claim'
import { createControlForwarder } from './control-forward'

const opened = { ok: true, message: 'opened browser b1', result: { id: 'b1', projectId: 'p1', partition: 'persist:nt-agent-browser-p1' } }
const call = { verb: 'open-browser', ownerNodeId: 'agent-1', verified: true }

describe('claimOpenedBrowser', () => {
  it('records the verified caller as the owner of the browser it opened', () => {
    const ledger = new BrowserControlLedger()
    expect(claimOpenedBrowser(ledger, call, opened, 1234)).toBe(true)
    expect(ledger.get('b1', 'agent-1')).toMatchObject({
      ownerNodeId: 'agent-1',
      projectId: 'p1',
      partition: 'persist:nt-agent-browser-p1',
      navGeneration: 0,
      leaseActiveUntil: 0,
      openedAt: 1234
    })
  })

  it('records nothing for an unverified caller, a failed open, another verb, or a reply missing its project', () => {
    const ledger = new BrowserControlLedger()
    expect(claimOpenedBrowser(ledger, { ...call, verified: false }, opened, 1)).toBe(false)
    expect(claimOpenedBrowser(ledger, call, { ...opened, ok: false }, 1)).toBe(false)
    expect(claimOpenedBrowser(ledger, { ...call, verb: 'show-web' }, opened, 1)).toBe(false)
    for (const drop of ['id', 'projectId', 'partition'] as const) {
      const result = { ...opened.result, [drop]: undefined }
      expect(claimOpenedBrowser(ledger, call, { ...opened, result }, 1), drop).toBe(false)
    }
    expect(ledger.get('b1', 'agent-1')).toBe(null)
  })
})

// Review follow-up to #1027. After desktop main gives up waiting (120 s), the renderer's answer can
// still arrive, and the request ledger replays it to the next retry. That answer skipped the
// ownership recording the on-time path does, so a retry heard "opened browser b1" about a browser
// its opener could never drive. The forwarder now runs the same finishing step on both answers.
describe('a LATE open-browser answer records ownership exactly like an on-time one', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the owner can drive the browser a late answer reports, and the replayed reply is the same answer', async () => {
    const ledger = new BrowserControlLedger()
    const sent: string[] = []
    const late = vi.fn()
    const fwd = createControlForwarder({ timeoutMs: 1000 })
    const p = fwd.forward('open-browser', (id) => sent.push(id), {
      onLate: late,
      finish: (reply) => {
        claimOpenedBrowser(ledger, call, reply, 1234)
        return reply
      }
    })
    vi.advanceTimersByTime(1000)
    expect((await p).indeterminate).toBe(true)
    expect(ledger.get('b1', 'agent-1')).toBe(null)
    fwd.answer({ requestId: sent[0], ...opened })
    expect(ledger.get('b1', 'agent-1')?.ownerNodeId).toBe('agent-1')
    expect(late).toHaveBeenCalledWith(opened)
  })
})
