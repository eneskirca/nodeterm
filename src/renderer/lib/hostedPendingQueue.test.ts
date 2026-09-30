import { describe, it, expect, vi } from 'vitest'
import {
  EMPTY_PENDING_QUEUE,
  addRequest,
  closeRequest,
  settleRequest,
  dropProjectRequests,
  headRequest,
  beginAnswer,
  finishAnswer,
  attachProject,
  SETTLED_MEMORY,
  type QueuedRequest
} from './hostedPendingQueue'

const answerer = { approve: vi.fn(async () => true), deny: vi.fn(async () => true) }
const req = (pendingId: string, since: number, projectId = 'p1'): QueuedRequest => ({
  projectId,
  teamLabel: 'box',
  pending: { pendingId, sas: '111 222', peerKeyB64: `K${pendingId}`, since },
  answerer
})

describe('hosted pending queue (R37)', () => {
  it('keeps EVERY open request, oldest first — a second knock is never dropped', () => {
    let q = addRequest(EMPTY_PENDING_QUEUE, req('b', 20))
    q = addRequest(q, req('a', 10))
    q = addRequest(q, req('c', 30))
    expect(q.items.map((i) => i.pending.pendingId)).toEqual(['a', 'b', 'c'])
    expect(headRequest(q)?.pending.pendingId).toBe('a')
  })

  it('de-dupes by pendingId: a pull that repeats a pushed request, or a replay, adds nothing', () => {
    let q = addRequest(EMPTY_PENDING_QUEUE, req('a', 10))
    const again = addRequest(q, req('a', 10))
    expect(again).toBe(q)
    q = addRequest(q, req('b', 5))
    expect(q.items.map((i) => i.pending.pendingId)).toEqual(['b', 'a'])
  })

  it('a request closed by another owner is dropped, and only the one on screen earns a line', () => {
    let q = addRequest(addRequest(EMPTY_PENDING_QUEUE, req('a', 10)), req('b', 20))
    const behind = closeRequest(q, 'b', 'approved')
    expect(behind.notice).toBeNull()
    expect(behind.queue.items.map((i) => i.pending.pendingId)).toEqual(['a'])
    const onScreen = closeRequest(q, 'a', 'denied')
    expect(onScreen.notice).toBe('Another owner answered this request.')
    expect(headRequest(onScreen.queue)?.pending.pendingId).toBe('b')
  })

  it('expired, gone and replaced close silently (a replaced request\'s successor arrives on its own)', () => {
    for (const reason of ['expired', 'gone', 'replaced'] as const) {
      const r = closeRequest(addRequest(EMPTY_PENDING_QUEUE, req('a', 10)), 'a', reason)
      expect(r.notice, reason).toBeNull()
      expect(r.queue.items).toEqual([])
    }
  })

  it('a closed or answered request never comes back from a late replay or pull', () => {
    let q = addRequest(EMPTY_PENDING_QUEUE, req('a', 10))
    q = settleRequest(q, 'a') // this owner answered it
    expect(q.items).toEqual([])
    expect(addRequest(q, req('a', 10)).items).toEqual([])
    // A close for a request this owner never saw is remembered too.
    q = closeRequest(q, 'z', 'expired').queue
    expect(addRequest(q, req('z', 1)).items).toEqual([])
  })

  it('the closed-id memory is bounded', () => {
    let q = EMPTY_PENDING_QUEUE
    for (let i = 0; i < SETTLED_MEMORY + 10; i++) q = settleRequest(q, `s${i}`)
    expect(q.settled.length).toBe(SETTLED_MEMORY)
    expect(q.settled).not.toContain('s0')
    expect(q.settled).toContain(`s${SETTLED_MEMORY + 9}`)
  })

  it('a tab that goes away takes only its own requests, and does not mark them answered', () => {
    let q = addRequest(addRequest(EMPTY_PENDING_QUEUE, req('a', 10, 'p1')), req('b', 20, 'p2'))
    q = dropProjectRequests(q, 'p1')
    expect(q.items.map((i) => i.pending.pendingId)).toEqual(['b'])
    // Its reconnect pulls them again.
    expect(addRequest(q, req('a', 10, 'p1')).items.map((i) => i.pending.pendingId)).toEqual(['a', 'b'])
  })

  it('ignores what is not a request (the events come off the wire)', () => {
    for (const bad of [
      { pendingId: '', sas: 'x', peerKeyB64: 'k', since: 1 },
      { pendingId: 'a', sas: 1, peerKeyB64: 'k', since: 1 },
      { pendingId: 'a', sas: 'x', peerKeyB64: 'k', since: Number.NaN },
      null
    ]) {
      expect(addRequest(EMPTY_PENDING_QUEUE, { ...req('a', 1), pending: bad as never }).items).toEqual([])
    }
  })

  it('R40: an answer in flight leaves the screen and cannot be re-added; one that LANDED is settled for good', () => {
    let q = addRequest(addRequest(EMPTY_PENDING_QUEUE, req('a', 10)), req('b', 20))
    q = beginAnswer(q, 'a')
    expect(headRequest(q)?.pending.pendingId).toBe('b')
    expect(addRequest(q, req('a', 10)).items.map((i) => i.pending.pendingId)).toEqual(['b']) // a replay mid-flight
    q = finishAnswer(q, req('a', 10), true)
    expect(addRequest(q, req('a', 10)).items.map((i) => i.pending.pendingId)).toEqual(['b'])
  })

  it('R40: an answer that never landed (the tab dropped) stays answerable — the reconnect\'s pull brings it back', () => {
    let q = addRequest(EMPTY_PENDING_QUEUE, req('a', 10))
    q = beginAnswer(q, 'a')
    q = finishAnswer(q, req('a', 10), false) // its tab is not attached here: nothing to put back
    expect(q.settled).not.toContain('a')
    expect(q.items).toEqual([])
    expect(addRequest(q, req('a', 10)).items.map((i) => i.pending.pendingId)).toEqual(['a'])
  })

  it('R41: a failed answer on a tab that is still attached goes back on screen, to be answered again', () => {
    let q = attachProject(EMPTY_PENDING_QUEUE, 'p1')
    q = addRequest(addRequest(q, req('a', 10)), req('b', 20))
    q = beginAnswer(q, 'a')
    q = finishAnswer(q, req('a', 10), false)
    expect(q.items.map((i) => i.pending.pendingId)).toEqual(['a', 'b'])
    expect(q.settled).not.toContain('a')
  })

  it('R41: …once: a second failure leaves it off the screen (a host that keeps refusing must not trap the owner)', () => {
    let q = addRequest(attachProject(EMPTY_PENDING_QUEUE, 'p1'), req('a', 10))
    q = finishAnswer(beginAnswer(q, 'a'), req('a', 10), false)
    q = finishAnswer(beginAnswer(q, 'a'), req('a', 10), false)
    expect(q.items).toEqual([])
    expect(q.settled).not.toContain('a') // still answerable if the host offers it again
  })

  it('R41: a failed answer on a tab that dropped meanwhile is NOT put back (the reconnect\'s pull will)', () => {
    let q = addRequest(attachProject(EMPTY_PENDING_QUEUE, 'p1'), req('a', 10))
    q = beginAnswer(q, 'a')
    q = dropProjectRequests(q, 'p1') // the drop's teardown ran before the rejection landed
    q = finishAnswer(q, req('a', 10), false)
    expect(q.items).toEqual([])
    expect(addRequest(q, req('a', 10)).items).toHaveLength(1)
  })
})
