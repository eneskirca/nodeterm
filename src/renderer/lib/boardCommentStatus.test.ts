import { describe, it, expect } from 'vitest'
import type { BoardLogEntry } from '@shared/types'
import { BOARD_COMMENT_QUEUE_STALE_MS, boardCommentSourceId, mentionToken } from '@shared/board-comment'
import { boardCommentTraces, isBoardCommentTrace, mentionStatuses } from './boardCommentStatus'

const comment = (id: string, text: string, ts = 100): BoardLogEntry => ({
  id,
  ts,
  author: { name: 'Enes', color: '#fff' },
  kind: 'comment',
  nodeId: 'card-a',
  text
})

const trace = (commentId: string, to: string, title: string, ts: number, reason?: string): BoardLogEntry => ({
  id: `t-${commentId}-${to}-${ts}`,
  ts,
  author: { name: 'nodeterm', color: '#8b8b8b' },
  kind: 'event',
  nodeId: to,
  event: { type: 'agent-message', from: boardCommentSourceId(commentId), to, title, ...(reason ? { reason } : {}) }
})

const text = `${mentionToken('b1', 'Beta')} and ${mentionToken('b2', 'Two')} go`
/** A comment THIS machine sent, looked at shortly after. */
const own = { own: true, now: 1_000 }

describe('mentionStatuses', () => {
  it('reads each mention\'s LATEST recorded outcome from the log, in mention order', () => {
    const entries = [
      trace('c1', 'b1', 'delivered', 300),
      trace('c1', 'b2', 'notPermitted', 250, 'switch-off'),
      trace('c1', 'b1', 'queued', 200),
      comment('c1', text)
    ]
    const s = mentionStatuses(comment('c1', text), boardCommentTraces(entries), undefined, own)
    expect(s.map((m) => m.nodeId)).toEqual(['b1', 'b2'])
    expect(s[0].view).toEqual({ tone: 'ok', text: 'delivered' })
    expect(s[1].view.text).toMatch(/agent messaging is off for this project/)
  })

  it('a newer reply from THIS app run wins over an older log line, and "sending" shows until one lands', () => {
    const traces = boardCommentTraces([trace('c1', 'b1', 'queued', 200)])
    const s = mentionStatuses(comment('c1', text), traces, {
      b1: { at: 250, state: 'done', kind: 'rateLimited' },
      b2: { at: 150, state: 'sending' }
    }, own)
    expect(s[0].view.text).toMatch(/moments ago/)
    expect(s[1].view).toEqual({ tone: 'pending', text: 'sending…' })
  })

  it('a failure with no typed outcome still says it was not delivered', () => {
    const s = mentionStatuses(comment('c1', `${mentionToken('b1', 'Beta')} go`), new Map(), {
      b1: { at: 1, state: 'done', kind: 'error', error: 'Message not sent: resolve the conflict.' }
    }, own)
    expect(s).toEqual([
      { nodeId: 'b1', view: { tone: 'error', text: 'not delivered — Message not sent: resolve the conflict.' } }
    ])
  })

  it('a comment this machine did NOT send shows no status — even when the log holds outcomes for it', () => {
    // A teammate's comment arrives by git pull WITH their machine's trace lines. Those describe a
    // delivery on their machine; on this row they would read as "delivered here".
    const entries = [trace('c9', 'b1', 'delivered', 300)]
    expect(mentionStatuses(comment('c9', text), boardCommentTraces(entries), undefined, { own: false, now: 1_000 })).toEqual([])
  })

  it('one of OUR comments with no outcome recorded says so, rather than showing nothing', () => {
    const s = mentionStatuses(comment('c1', `${mentionToken('b1', 'Beta')} go`), new Map(), undefined, own)
    expect(s).toEqual([{ nodeId: 'b1', view: { tone: 'warn', text: 'no delivery outcome was recorded' } }])
  })

  it('"queued" older than the queue can hold a message is not left looking live', () => {
    const entries = [trace('c1', 'b1', 'queued', 100)]
    const later = { own: true, now: 100 + BOARD_COMMENT_QUEUE_STALE_MS + 1 }
    const s = mentionStatuses(comment('c1', `${mentionToken('b1', 'Beta')} go`), boardCommentTraces(entries), undefined, later)
    expect(s[0].view.tone).toBe('warn')
    expect(s[0].view.text).toMatch(/no outcome was recorded/)
  })

  it('a future-dated log line cannot override what this app run saw', () => {
    const entries = [trace('c1', 'b1', 'delivered', 9_999_999)]
    const s = mentionStatuses(comment('c1', `${mentionToken('b1', 'Beta')} go`), boardCommentTraces(entries), {
      b1: { at: 900, state: 'done', kind: 'notPermitted', reason: 'switch-off' }
    }, own)
    expect(s[0].view.text).toMatch(/off for this project/)
  })

  it('another comment\'s lines never attach, and a forged `from` that is not a comment id is ignored', () => {
    const entries = [
      trace('c2', 'b1', 'delivered', 300),
      { ...trace('c1', 'b1', 'delivered', 300), event: { type: 'agent-message' as const, from: 'a1', to: 'b1', title: 'delivered' } }
    ]
    expect(mentionStatuses(comment('c1', text), boardCommentTraces(entries), undefined, own)).toEqual([
      { nodeId: 'b1', view: { tone: 'warn', text: 'no delivery outcome was recorded' } },
      { nodeId: 'b2', view: { tone: 'warn', text: 'no delivery outcome was recorded' } }
    ])
  })
})

describe('isBoardCommentTrace', () => {
  it('names only the delivery lines a board comment produced', () => {
    expect(isBoardCommentTrace(trace('c1', 'b1', 'delivered', 1))).toBe(true)
    expect(
      isBoardCommentTrace({
        ...trace('c1', 'b1', 'delivered', 1),
        event: { type: 'agent-message', from: 'a1', to: 'b1', title: 'delivered' }
      })
    ).toBe(false)
    expect(isBoardCommentTrace(comment('c1', text))).toBe(false)
  })
})
