// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailboxMessage, MailboxReply, MailboxSummary } from '@shared/agents/agent-mailbox'
import type { MailboxView } from '../lib/agentMailbox'
import { AgentMailboxPanel } from './AgentMailboxPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const message = (over: Partial<MailboxMessage> = {}): MailboxMessage => ({
  messageId: 'mail-a', idempotencyKey: 'synthetic-send-a', revision: 1, createdAt: 100, updatedAt: 100,
  source: { nodeId: 'sender', projectId: 'project', sessionId: 'sender-session', agentId: 'codex' },
  target: { nodeId: 'recipient', projectId: 'project', sessionId: 'recipient-session', agentId: 'claude' },
  deliveryStatus: 'queued', processingStatus: 'unacknowledged', body: 'A task to plan.', ...over
})
const summary = (value: MailboxMessage): MailboxSummary => {
  const { body: _body, ...rest } = value
  return rest
}
const listReply = (values: MailboxMessage[], cursor?: string): MailboxReply => ({ ok: true, result: { schemaVersion: 1, messages: values.map(summary), ...(cursor ? { cursor } : {}) } })
const readReply = (value: MailboxMessage): MailboxReply => ({ ok: true, result: {
  schemaVersion: 1, message: value, messageId: value.messageId, revision: value.revision,
  deliveryStatus: value.deliveryStatus, processingStatus: value.processingStatus
} })
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

let root: Root
let host: HTMLDivElement
const onClose = vi.fn()
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  onClose.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
const render = async (view?: MailboxView): Promise<void> => {
  await act(async () => root.render(<AgentMailboxPanel nodeId="recipient" title="Research agent" api={view ? { agentMailbox: { view } } : {}} onClose={onClose} />))
}
const button = (text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((item) => item.textContent === text)
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
const click = async (item: HTMLElement): Promise<void> => { await act(async () => item.click()) }
const text = (): string => document.body.textContent ?? ''

describe('agent Inbox / Outbox view', () => {
  it('shows separate confirmed statuses; listing and reading never acknowledge or complete', async () => {
    const view = vi.fn<MailboxView>().mockResolvedValueOnce(listReply([message()])).mockResolvedValueOnce(readReply(message()))
    await render(view)
    expect(text()).toContain('Delivery: queued')
    expect(text()).toContain('Processing: unacknowledged')
    expect(view.mock.calls).toEqual([[{ nodeId: 'recipient', box: 'inbox', state: 'open', limit: 50 }]])
    expect(text()).not.toContain('A task to plan.')
    await click(document.querySelector('.agent-mailbox__row') as HTMLElement)
    expect(text()).toContain('A task to plan.')
    expect(view.mock.calls[1]).toEqual([{ nodeId: 'recipient', messageId: 'mail-a' }])
    expect(view).toHaveBeenCalledTimes(2)
    expect(text()).toContain('unacknowledged')
    expect([...document.querySelectorAll('button')].some((item) => /^(ACK|Accept|Complete)$/i.test(item.textContent ?? ''))).toBe(false)
  })

  it('filters Outbox/history and follows opaque pagination without losing earlier mail', async () => {
    const view = vi.fn<MailboxView>()
      .mockResolvedValueOnce(listReply([]))
      .mockResolvedValueOnce(listReply([message()], 'next:opaque'))
      .mockResolvedValueOnce(listReply([message({ messageId: 'mail-b' })]))
      .mockResolvedValueOnce(listReply([]))
    await render(view)
    await click(button('Outbox'))
    expect(view.mock.calls[1][0]).toEqual({ nodeId: 'recipient', box: 'outbox', state: 'open', limit: 50 })
    await click(button('Load more'))
    expect(view.mock.calls[2][0]).toEqual({ nodeId: 'recipient', box: 'outbox', state: 'open', limit: 50, cursor: 'next:opaque' })
    expect(document.querySelectorAll('.agent-mailbox__row')).toHaveLength(2)
    await click(document.querySelector('input[type=checkbox]') as HTMLElement)
    expect(view.mock.calls[3][0]).toEqual({ nodeId: 'recipient', box: 'outbox', state: 'all', limit: 50 })
    expect(document.querySelectorAll('.agent-mailbox__row')).toHaveLength(0)
  })

  it('distinguishes denied/unavailable reads from an empty Inbox', async () => {
    const view = vi.fn<MailboxView>().mockResolvedValue({ ok: false, error: 'Mailbox scope refused', code: 'not-permitted', retryable: false })
    await render(view)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('not-permitted')
    expect(text()).not.toContain('No open messages.')
    expect(text()).not.toContain('No messages.')
    await render()
    expect(text()).toContain('This connection does not support agent mailboxes')
    expect(text()).not.toContain('No open messages.')
  })

  it('ignores an old Inbox response after changing to Outbox', async () => {
    const old = deferred<MailboxReply>()
    const view = vi.fn<MailboxView>().mockReturnValueOnce(old.promise).mockResolvedValueOnce(listReply([message({ messageId: 'outgoing' })]))
    await render(view)
    await click(button('Outbox'))
    await act(async () => old.resolve(listReply([message({ messageId: 'private-old-result' })])))
    expect(text()).toContain('outgoing')
    expect(text()).not.toContain('private-old-result')
  })

  it('cancels stale detail when switching boxes and renders message content only as text', async () => {
    const detail = deferred<MailboxReply>()
    const view = vi.fn<MailboxView>().mockResolvedValueOnce(listReply([message()])).mockReturnValueOnce(detail.promise).mockResolvedValueOnce(listReply([]))
    await render(view)
    await click(document.querySelector('.agent-mailbox__row') as HTMLElement)
    await click(button('Outbox'))
    await act(async () => detail.resolve(readReply(message({ body: 'old detail must stay hidden' }))))
    expect(text()).not.toContain('old detail must stay hidden')

    view.mockResolvedValueOnce(listReply([message()])).mockResolvedValueOnce(readReply(message({ body: '<img src=x onerror=alert(1)>\nLiteral mail', processingStatus: 'blocked', note: 'Need input', revision: 3 })))
    await click(button('Inbox'))
    await click(document.querySelector('.agent-mailbox__row') as HTMLElement)
    expect(document.querySelector('.agent-mailbox__message')?.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(document.querySelector('.agent-mailbox__message img')).toBeNull()
    expect(text()).toContain('Processing: blocked')
    expect(text()).toContain('Need input')
  })

  it('shows read errors without retaining stale content and closes on Escape', async () => {
    const view = vi.fn<MailboxView>().mockResolvedValueOnce(listReply([message()])).mockRejectedValueOnce(new Error('Connection lost'))
    await render(view)
    await click(document.querySelector('.agent-mailbox__row') as HTMLElement)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Connection lost')
    expect(text()).not.toContain('A task to plan.')
    await act(async () => { document.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
