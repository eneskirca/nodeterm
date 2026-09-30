import { describe, it, expect, vi } from 'vitest'
import type { HostedPending, HostedPendingClosedReason, HostedSessionApi } from '@shared/types'
import { attachHostedOwner, answerHostedRequest } from './hostedOwner'
import type { QueuedRequest } from './hostedPendingQueue'

function fakeHosted(pulled: HostedPending[] | Error = []) {
  const calls: string[] = []
  let onPending: ((p: HostedPending) => void) | null = null
  let onClosed: ((c: { pendingId: string; reason: HostedPendingClosedReason }) => void) | null = null
  const unPending = vi.fn()
  const unClosed = vi.fn()
  const hosted = {
    self: vi.fn(),
    inviteCode: vi.fn(),
    approve: vi.fn(async () => true),
    deny: vi.fn(async () => true),
    pending: vi.fn(async () => {
      calls.push('pull')
      if (pulled instanceof Error) throw pulled
      return pulled
    }),
    onPeerPending: vi.fn((l) => {
      calls.push('sub:pending')
      onPending = l
      return unPending
    }),
    onPendingClosed: vi.fn((l) => {
      calls.push('sub:closed')
      onClosed = l
      return unClosed
    })
  } as unknown as HostedSessionApi
  return { hosted, calls, unPending, unClosed, push: (p: HostedPending) => onPending?.(p), close: (id: string, reason: HostedPendingClosedReason) => onClosed?.({ pendingId: id, reason }) }
}

const sink = () => {
  const added: QueuedRequest[] = []
  const closed: Array<[string, string]> = []
  const dropped: string[] = []
  const attached: string[] = []
  return { added, closed, dropped, attached, attach: (p: string) => attached.push(p), add: (i: QueuedRequest) => added.push(i), close: (id: string, r: HostedPendingClosedReason) => closed.push([id, r]), drop: (p: string) => dropped.push(p) }
}
const P = (id: string, since = 1): HostedPending => ({ pendingId: id, sas: '1 2', peerKeyB64: 'K', since })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('attachHostedOwner (R25)', () => {
  it('subscribes FIRST, then pulls once, and feeds both into the queue', async () => {
    const f = fakeHosted([P('pulled')])
    const s = sink()
    attachHostedOwner(f.hosted, { projectId: 'p1', teamLabel: 'box' }, s)
    expect(s.attached).toEqual(['p1']) // its failed answers may go back on screen while attached (R41)
    expect(f.calls).toEqual(['sub:pending', 'sub:closed', 'pull'])
    f.push(P('pushed'))
    await flush()
    expect(s.added.map((i) => i.pending.pendingId).sort()).toEqual(['pulled', 'pushed'])
    expect(s.added[0]).toMatchObject({ projectId: 'p1', teamLabel: 'box', answerer: f.hosted })
    f.close('pushed', 'expired')
    expect(s.closed).toEqual([['pushed', 'expired']])
  })

  it('a failed pull is not fatal: the push deltas still arrive', async () => {
    const f = fakeHosted(new Error('E_DISCONNECTED'))
    const s = sink()
    attachHostedOwner(f.hosted, { projectId: 'p1', teamLabel: 'box' }, s)
    await flush()
    f.push(P('a'))
    expect(s.added).toHaveLength(1)
  })

  it('detaching unsubscribes, drops the tab\'s requests, and ignores a pull that lands afterwards', async () => {
    let resolvePull!: (v: HostedPending[]) => void
    const f = fakeHosted()
    ;(f.hosted.pending as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((r) => { resolvePull = r }))
    const s = sink()
    const detach = attachHostedOwner(f.hosted, { projectId: 'p1', teamLabel: 'box' }, s)
    detach()
    expect(f.unPending).toHaveBeenCalled()
    expect(f.unClosed).toHaveBeenCalled()
    expect(s.dropped).toEqual(['p1'])
    resolvePull([P('late')])
    await flush()
    f.push(P('also-late'))
    expect(s.added).toEqual([])
  })
})

describe('answerHostedRequest', () => {
  const item = (hosted: HostedSessionApi): QueuedRequest => ({ projectId: 'p1', teamLabel: 'box', pending: P('x'), answerer: hosted })
  const ledger = () => {
    const log: string[] = []
    return {
      log,
      begin: (id: string) => log.push(`begin:${id}`),
      finish: (item: QueuedRequest, landed: boolean) => log.push(`finish:${item.pending.pendingId}:${landed}`)
    }
  }

  it('R40: settles only once the host ANSWERED (true or false); a rejection leaves the request answerable', async () => {
    const f = fakeHosted()
    const ok = ledger()
    await answerHostedRequest(item(f.hosted), { kind: 'approve', role: 'viewer' }, ok)
    expect(ok.log).toEqual(['begin:x', 'finish:x:true'])
    ;(f.hosted.deny as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    const gone = ledger()
    await answerHostedRequest(item(f.hosted), { kind: 'deny' }, gone)
    expect(gone.log).toEqual(['begin:x', 'finish:x:true'])
    ;(f.hosted.approve as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('The connection to the server was lost.'), { code: 'E_DISCONNECTED' }))
    const dropped = ledger()
    const line = await answerHostedRequest(item(f.hosted), { kind: 'approve', role: 'viewer' }, dropped)
    expect(dropped.log).toEqual(['begin:x', 'finish:x:false'])
    expect(line?.kind).toBe('error')
  })

  it('approves with the chosen role and says nothing when it landed', async () => {
    const f = fakeHosted()
    expect(await answerHostedRequest(item(f.hosted), { kind: 'approve', role: 'commenter' }, ledger())).toBeNull()
    expect(f.hosted.approve).toHaveBeenCalledWith('x', 'commenter')
  })

  it('a false answer means another owner (or the device leaving) got there first', async () => {
    const f = fakeHosted()
    ;(f.hosted.deny as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    expect(await answerHostedRequest(item(f.hosted), { kind: 'deny' }, ledger())).toEqual({ kind: 'info', text: 'That request was already answered or has gone.' })
  })

  it('a refused answer says so, in the host\'s words', async () => {
    const f = fakeHosted()
    ;(f.hosted.approve as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Only an owner can approve.'))
    expect(await answerHostedRequest(item(f.hosted), { kind: 'approve', role: 'viewer' }, ledger())).toEqual({ kind: 'error', text: 'Could not answer the request: Only an owner can approve.' })
  })
})
