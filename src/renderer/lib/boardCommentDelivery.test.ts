import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentMessageReply } from '@shared/agents/agent-messaging'
import { mentionToken, type BoardCommentDeliverRequest } from '@shared/board-comment'
import {
  canDeliverBoardComments,
  coalesce,
  deliverCommentMentions,
  mentionResultFromReply,
  registerBoardCommentDeliverer,
  runBoardCommentDelivery
} from './boardCommentDelivery'
import { useBoardCommentDelivery } from '../state/boardCommentDelivery'

const req: BoardCommentDeliverRequest = {
  projectId: 'p1',
  commentId: 'c1',
  author: 'Enes',
  text: `${mentionToken('b1', 'Beta')} go`,
  targetNodeId: 'b1'
}

beforeEach(() => useBoardCommentDelivery.getState().reset())

describe('runBoardCommentDelivery — the renderer half of the gate', () => {
  it('holds the target\'s restart lock around a publish-then-deliver, like an agent send', async () => {
    const order: string[] = []
    const reply = await runBoardCommentDelivery(req, {
      guard: async (target, fn) => {
        order.push(`guard:${target}`)
        return fn()
      },
      sync: async () => {
        order.push('sync')
        return { ok: true }
      },
      deliver: async (r) => {
        order.push(`deliver:${r.targetNodeId}`)
        return { ok: true, result: { kind: 'delivered' } }
      }
    })
    expect(order).toEqual(['guard:b1', 'sync', 'deliver:b1'])
    expect(reply.ok).toBe(true)
  })

  it('a node mid-restart is refused as busy, never typed into', async () => {
    const deliver = vi.fn()
    const reply = await runBoardCommentDelivery(req, {
      guard: async () => 'not-eligible',
      sync: async () => ({ ok: true }),
      deliver
    })
    expect(deliver).not.toHaveBeenCalled()
    expect(mentionResultFromReply(reply)).toMatchObject({ kind: 'targetBusy' })
  })

  it('a canvas that cannot publish its pending edits delivers nothing and says why', async () => {
    const deliver = vi.fn()
    const reply = await runBoardCommentDelivery(req, {
      guard: async (_t, fn) => fn(),
      sync: async () => ({ ok: false, error: 'Message not sent: resolve the conflict.' }),
      deliver
    })
    expect(deliver).not.toHaveBeenCalled()
    expect(mentionResultFromReply(reply)).toEqual({
      kind: 'error',
      error: 'Message not sent: resolve the conflict.'
    })
  })
})

describe('deliverCommentMentions', () => {
  it('records "sending" at once, then each target\'s own outcome', async () => {
    let finish!: (r: AgentMessageReply) => void
    const unregister = registerBoardCommentDeliverer(
      () => new Promise<AgentMessageReply>((res) => (finish = res))
    )
    const run = deliverCommentMentions(
      { projectId: 'p1', commentId: 'c1', author: 'Enes', text: req.text },
      ['b1']
    )
    expect(useBoardCommentDelivery.getState().byComment.c1.b1.state).toBe('sending')
    // Marked as THIS machine's comment before anything else: its log outcomes are trusted after a reload.
    expect(useBoardCommentDelivery.getState().sent.c1).toBeTypeOf('number')
    finish({ ok: false, result: { kind: 'notPermitted', reason: 'switch-off' } })
    await run
    expect(useBoardCommentDelivery.getState().byComment.c1.b1).toMatchObject({
      state: 'done',
      kind: 'notPermitted',
      reason: 'switch-off'
    })
    unregister()
  })

  it('with no canvas to deliver through, every mention says so — never a silent nothing', async () => {
    await deliverCommentMentions(
      { projectId: 'p1', commentId: 'c2', author: 'Enes', text: req.text },
      ['b1']
    )
    expect(useBoardCommentDelivery.getState().byComment.c2.b1).toMatchObject({ state: 'done', kind: 'error' })
  })

  it('a deliverer that throws is a failure on the row, not an unhandled rejection', async () => {
    const unregister = registerBoardCommentDeliverer(async () => {
      throw new Error('ipc gone')
    })
    await deliverCommentMentions(
      { projectId: 'p1', commentId: 'c3', author: 'Enes', text: req.text },
      ['b1']
    )
    expect(useBoardCommentDelivery.getState().byComment.c3.b1).toMatchObject({
      state: 'done',
      kind: 'error',
      error: 'ipc gone'
    })
    unregister()
  })
})

describe('coalesce — one publish for a comment\'s mentions', () => {
  it('concurrent callers share ONE in-flight run; a later caller starts a fresh one', async () => {
    let runs = 0
    let finish!: (v: boolean) => void
    const save = coalesce(() => {
      runs++
      return new Promise<boolean>((r) => (finish = r))
    })
    const a = save()
    const b = save()
    expect(runs).toBe(1)
    finish(true)
    expect(await Promise.all([a, b])).toEqual([true, true])
    const c = save()
    expect(runs).toBe(2)
    finish(false)
    expect(await c).toBe(false)
  })

  it('a run that throws releases the slot, so the next caller is not stuck on it', async () => {
    let runs = 0
    const save = coalesce(async () => {
      runs++
      throw new Error('disk')
    })
    await expect(save()).rejects.toThrow('disk')
    await expect(save()).rejects.toThrow('disk')
    expect(runs).toBe(2)
  })
})

describe('canDeliverBoardComments', () => {
  it('only the desktop app\'s own window delivers — relay and browser tabs are display-only', () => {
    expect(canDeliverBoardComments('local', false)).toBe(true)
    expect(canDeliverBoardComments('relay', false)).toBe(false)
    expect(canDeliverBoardComments('server', false)).toBe(false)
    expect(canDeliverBoardComments('local', true)).toBe(false)
  })
})
