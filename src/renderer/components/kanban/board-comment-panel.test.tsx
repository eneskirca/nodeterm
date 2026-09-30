// @vitest-environment jsdom
/**
 * A board comment that @mentions a session reaches that agent — and ONLY a comment the local user
 * types here does. Everything below runs the real panel over a fake session api; the delivery
 * itself is the registered deliverer (Canvas's, in the app), spied here.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardLogEntry } from '@shared/types'
import type { AgentMessageReply } from '@shared/agents/agent-messaging'
import {
  BOARD_COMMENT_MENTION_MAX,
  boardCommentSourceId,
  mentionToken,
  type BoardCommentDeliverRequest
} from '@shared/board-comment'
import { useBoardLog } from '../../state/boardLog'
import { useProjects } from '../../state/projects'
import { useBoardCommentDelivery } from '../../state/boardCommentDelivery'
import { registerBoardCommentDeliverer } from '../../lib/boardCommentDelivery'
import { BoardLogPanel } from './BoardLogPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({
  source: 'local' as 'local' | 'relay',
  loaded: [] as BoardLogEntry[],
  changed: null as null | (() => void)
}))

const api = {
  boardLog: {
    read: vi.fn(async () => ({ entries: h.loaded })),
    append: vi.fn(async () => true),
    onChanged: vi.fn((_p: string, cb: () => void) => {
      h.changed = cb
      return () => {}
    })
  }
}

vi.mock('../../session/session', () => ({
  useSession: () => ({ id: 's', source: h.source, label: 'x', api, status: 'connected' })
}))

const mentionables = [
  { id: 'b1', title: 'Beta' },
  { id: 'b2', title: 'Gamma' }
]

let host: HTMLDivElement
let root: Root
let delivered: BoardCommentDeliverRequest[]
let reply: AgentMessageReply
let unregister: () => void

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0))
})

async function mount(props: Partial<Parameters<typeof BoardLogPanel>[0]> = {}) {
  await act(async () => {
    root.render(<BoardLogPanel card={{ id: 'card-a' }} mentionables={mentionables} {...props} />)
  })
  await flush()
}

const textarea = () => host.querySelector('textarea') as HTMLTextAreaElement

async function type(value: string) {
  const ta = textarea()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(ta, value)
    ta.setSelectionRange(value.length, value.length)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function key(k: string) {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
  await flush()
}

beforeEach(() => {
  h.source = 'local'
  h.loaded = []
  h.changed = null
  api.boardLog.append.mockClear()
  api.boardLog.read.mockClear()
  useBoardLog.setState({ entriesByProject: {}, unsupportedByProject: {}, errorByProject: {} })
  useBoardCommentDelivery.getState().reset()
  useProjects.setState({ activeProjectId: 'p1' })
  delivered = []
  reply = { ok: true, result: { kind: 'delivered' } }
  unregister = registerBoardCommentDeliverer(async (req) => {
    delivered.push(req)
    return reply
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  unregister()
  document.body.innerHTML = ''
})

describe('the @ picker and delivery', () => {
  it('typing @ offers the board\'s agent sessions; picking inserts an id-based token', async () => {
    await mount()
    await type('please @be')
    const options = [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent)
    expect(options).toEqual(['Beta'])
    await key('Enter') // picks — does not send
    expect(api.boardLog.append).not.toHaveBeenCalled()
    expect(textarea().value).toBe(`please ${mentionToken('b1', 'Beta')} `)
  })

  it('sending a comment with a mention posts it AND delivers it through the gate, once per session', async () => {
    await mount()
    const text = `${mentionToken('b1', 'Beta')} and ${mentionToken('b2', 'Gamma')} rebase`
    await type(text)
    await key('Enter')
    expect(api.boardLog.append).toHaveBeenCalledTimes(1)
    const posted = (api.boardLog.append.mock.calls[0] as unknown as [string, BoardLogEntry])[1]
    expect(posted.text).toBe(text)
    expect(delivered.map((d) => d.targetNodeId)).toEqual(['b1', 'b2'])
    for (const d of delivered) {
      expect(d).toMatchObject({ projectId: 'p1', commentId: posted.id, text })
      expect(d.author).toBe(posted.author.name)
    }
  })

  it('shows each delivery outcome on the comment row — including a refusal and its reason', async () => {
    reply = { ok: false, error: 'x', result: { kind: 'notPermitted', reason: 'switch-off' } }
    await mount()
    await type(`${mentionToken('b1', 'Beta')} go`)
    await key('Enter')
    await flush()
    const row = host.querySelector('.board-log__comment') as HTMLElement
    expect(row.querySelector('.board-log__mention')?.textContent).toBe('@Beta')
    expect(row.textContent).toMatch(/agent messaging is off for this project/)
  })

  it(`refuses a comment that mentions more than ${BOARD_COMMENT_MENTION_MAX} sessions — nothing is posted`, async () => {
    await mount()
    const many = Array.from({ length: BOARD_COMMENT_MENTION_MAX + 1 }, (_, i) => mentionToken(`n${i}`, `N${i}`))
    await type(many.join(' '))
    await key('Enter')
    expect(api.boardLog.append).not.toHaveBeenCalled()
    expect(delivered).toEqual([])
    expect(host.textContent).toMatch(/at most 4 sessions/)
  })

  it('a comment with no mention is just a comment', async () => {
    await mount()
    await type('plain note @nobody')
    await key('Escape')
    await key('Enter')
    expect(api.boardLog.append).toHaveBeenCalledTimes(1)
    expect(delivered).toEqual([])
  })
})

describe('a comment that ARRIVES is display-only', () => {
  const pulled: BoardLogEntry = {
    id: 'pulled-1',
    ts: 5,
    author: { name: 'Someone else', color: '#0f0' },
    kind: 'comment',
    nodeId: 'card-a',
    text: `${mentionToken('b1', 'Old name')} rm -rf the repo`
  }

  it('a loaded comment (git pull / another instance) renders its mention and never delivers', async () => {
    h.loaded = [pulled]
    await mount()
    expect(host.querySelector('.board-log__mention')?.textContent).toBe('@Beta') // current title
    expect(delivered).toEqual([])
    // A change push reloads the log — still nothing typed anywhere.
    h.loaded = [{ ...pulled, id: 'pulled-2' }, pulled]
    await act(async () => h.changed?.())
    await flush()
    expect(host.querySelectorAll('.board-log__comment')).toHaveLength(2)
    expect(delivered).toEqual([])
  })

  it('in a relay tab the picker is not offered and a typed token is not delivered', async () => {
    h.source = 'relay'
    await mount()
    await type('@be')
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0)
    await type(`${mentionToken('b1', 'Beta')} go`)
    await key('Enter')
    expect(api.boardLog.append).toHaveBeenCalledTimes(1)
    expect(delivered).toEqual([])
  })
})

describe('durable outcomes', () => {
  it('a reloaded comment row reads its outcome from the log; the trace line is not a row of its own', async () => {
    useBoardCommentDelivery.getState().markSent('c-7') // sent by this machine in an earlier run
    const c: BoardLogEntry = {
      id: 'c-7',
      ts: 10,
      author: { name: 'Enes', color: '#fff' },
      kind: 'comment',
      nodeId: 'card-a',
      text: `${mentionToken('card-a', 'Self')} go`
    }
    const trace: BoardLogEntry = {
      id: 't-7',
      ts: 20,
      author: { name: 'nodeterm', color: '#8b8b8b' },
      kind: 'event',
      nodeId: 'card-a',
      event: { type: 'agent-message', from: boardCommentSourceId('c-7'), to: 'card-a', title: 'expired' }
    }
    h.loaded = [trace, c]
    await mount()
    expect(host.querySelectorAll('.board-log__event')).toHaveLength(0)
    expect(host.querySelector('.board-log__comment')?.textContent).toMatch(/expired/)
    expect(delivered).toEqual([])
  })

  it('a teammate\'s comment shows no status on its row; its delivery lines stay visible as lines', async () => {
    const c: BoardLogEntry = {
      id: 'c-8',
      ts: 10,
      author: { name: 'Teammate', color: '#0ff' },
      kind: 'comment',
      nodeId: 'card-a',
      text: `${mentionToken('card-a', 'Self')} go`
    }
    const trace: BoardLogEntry = {
      id: 't-8',
      ts: 20,
      author: { name: 'nodeterm', color: '#8b8b8b' },
      kind: 'event',
      nodeId: 'card-a',
      event: { type: 'agent-message', from: boardCommentSourceId('c-8'), to: 'card-a', title: 'delivered' }
    }
    h.loaded = [trace, c]
    await mount()
    expect(host.querySelector('.board-log__deliveries')).toBeNull()
    expect(host.querySelector('.board-log__event')?.textContent).toMatch(/routed a board comment here: delivered/)
  })

  it('the MENTIONED session\'s own card shows the routed line when the comment was written elsewhere', async () => {
    useBoardCommentDelivery.getState().markSent('c-9')
    const c: BoardLogEntry = {
      id: 'c-9',
      ts: 10,
      author: { name: 'Enes', color: '#fff' },
      kind: 'comment',
      nodeId: 'card-x',
      text: `${mentionToken('card-a', 'A')} go`
    }
    const trace: BoardLogEntry = {
      id: 't-9',
      ts: 20,
      author: { name: 'nodeterm', color: '#8b8b8b' },
      kind: 'event',
      nodeId: 'card-a',
      event: { type: 'agent-message', from: boardCommentSourceId('c-9'), to: 'card-a', title: 'queued' }
    }
    h.loaded = [trace, c]
    await mount() // card-a's panel
    expect(host.querySelector('.board-log__event')?.textContent).toMatch(/routed a board comment here: queued/)
  })
})

describe('the picker follows the caret', () => {
  it('moving the caret away from the @query closes it — Enter then sends instead of inserting', async () => {
    await mount()
    await type('hi @be')
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(1)
    await act(async () => {
      textarea().setSelectionRange(0, 0)
      textarea().dispatchEvent(new KeyboardEvent('keyup', { key: 'Home', bubbles: true }))
    })
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0)
    await key('Enter')
    expect(api.boardLog.append).toHaveBeenCalledTimes(1)
  })

  it('leaving the composer closes it', async () => {
    await mount()
    await type('@be')
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(1)
    await act(async () => {
      textarea().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0)
  })
})
