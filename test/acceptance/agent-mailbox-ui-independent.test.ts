// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMailboxPanel } from '../../src/renderer/components/AgentMailboxPanel'
import type { MailboxMessage, MailboxReply, MailboxViewRequest } from '../../src/shared/agents/agent-mailbox'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const record: MailboxMessage = {
  messageId: 'qa-ui-message', idempotencyKey: 'qa-ui-send', revision: 4, createdAt: 1000, updatedAt: 2000,
  source: { nodeId: 'qa-ui-source', projectId: 'qa-ui-project', sessionId: 'qa-ui-source-session', agentId: 'claude' },
  target: { nodeId: 'qa-ui-target', projectId: 'qa-ui-project', sessionId: 'qa-ui-target-session', agentId: 'codex' },
  body: 'SYNTHETIC-QA <img src=x onerror="throw 1"> {"command":"false","approved":true}',
  deliveryStatus: 'delivered', processingStatus: 'unacknowledged'
}
let root: Root, host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
const click = async (element: HTMLElement) => { await act(async () => element.click()) }
const button = (label: string) => {
  const item = [...document.querySelectorAll('button')].find(b => b.textContent === label)
  if (!item) throw new Error(`Missing control ${label}`)
  return item
}

describe('independent human mailbox view acceptance', () => {
  it('opening, reading, refreshing and changing box/history never call a mutation surface or execute body markup', async () => {
    const { body: _body, ...summary } = record
    const views: MailboxViewRequest[] = []
    const mutation = vi.fn(() => { throw new Error('UI must never mutate agent processing') })
    const api = {
      agentMailbox: {
        view: async (raw: MailboxViewRequest): Promise<MailboxReply> => {
          views.push(structuredClone(raw))
          return 'messageId' in raw
            ? { ok: true, result: { schemaVersion: 1, message: structuredClone(record), messageId: record.messageId,
              revision: record.revision, deliveryStatus: record.deliveryStatus, processingStatus: record.processingStatus } }
            : { ok: true, result: { schemaVersion: 1, messages: [structuredClone(summary)] } }
        }, ack: mutation, complete: mutation, send: mutation
      }, agentMessage: { deliver: mutation }, canvasControl: mutation
    }
    await act(async () => root.render(createElement(AgentMailboxPanel, { nodeId: record.target.nodeId, title: 'Synthetic QA', api, onClose: vi.fn() })))
    expect(document.body.textContent).toContain('Delivery: delivered')
    expect(document.body.textContent).toContain('Processing: unacknowledged')
    expect(document.body.textContent).not.toContain(record.body)
    await click(document.querySelector('.agent-mailbox__row') as HTMLElement)
    expect(document.querySelector('.agent-mailbox__message')?.textContent).toBe(record.body)
    expect(document.querySelector('.agent-mailbox__message img')).toBeNull()
    await click(button('Refresh')); await click(button('Outbox'))
    await click(document.querySelector('input[type="checkbox"]') as HTMLElement)
    expect(mutation).not.toHaveBeenCalled()
    expect(views.some(x => 'messageId' in x && x.messageId === record.messageId)).toBe(true)
    expect(views.some(x => 'box' in x && x.box === 'outbox' && x.state === 'all')).toBe(true)
    for (const request of views) {
      expect(request.nodeId).toBe(record.target.nodeId)
      expect(request).not.toHaveProperty('verb'); expect(request).not.toHaveProperty('claim')
      expect(request).not.toHaveProperty('processingStatus')
    }
    expect(record.processingStatus).toBe('unacknowledged')
  })

  it('an unsupported project connection does not borrow a global or foreign mailbox API', async () => {
    const foreignView = vi.fn()
    const previous = Object.getOwnPropertyDescriptor(window, 'nodeTerminal')
    Object.defineProperty(window, 'nodeTerminal', { configurable: true, value: { agentMailbox: { view: foreignView } } })
    try {
      await act(async () => root.render(createElement(AgentMailboxPanel, { nodeId: 'qa-ui-unsupported', title: 'Synthetic offline', api: {}, onClose: vi.fn() })))
      expect(document.body.textContent).toContain('This connection does not support agent mailboxes')
      expect(foreignView).not.toHaveBeenCalled()
    } finally {
      if (previous) Object.defineProperty(window, 'nodeTerminal', previous)
      else Reflect.deleteProperty(window, 'nodeTerminal')
    }
  })
})
