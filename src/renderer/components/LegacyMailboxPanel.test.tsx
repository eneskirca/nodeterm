// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LegacyMailboxDetail, LegacyMailboxSummary, LegacyMailboxViewReply } from '@shared/agents/agent-mailbox-legacy'
import type { LegacyMailboxView } from '../lib/agentMailbox'
import { AgentMailboxPanel } from './AgentMailboxPanel'
import { LegacyMailboxPanel } from './LegacyMailboxPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const legacyId = (letter: string): string => `legacy-${letter.repeat(64)}`
const record = (over: Partial<LegacyMailboxDetail> = {}): LegacyMailboxDetail => ({
  legacyId: legacyId('a'), origin: 'delivery-queue-v1', deliveryStatus: 'held', processingStatus: 'unacknowledged',
  unverified: true, sourceEvidence: 'missing', targetEvidence: 'recorded-unverified',
  reason: 'missing-verified-project-and-session-bindings', sourceNodeId: 'old-source', targetNodeId: 'current-worker',
  sourceTitle: '<b>Historical source</b>', verb: 'send', importedAt: 200, enqueuedAt: 100,
  recordedTargetBinding: { sessionId: 'historical-session', agentId: 'codex' }, bodyAvailable: true,
  body: 'Synthetic old task\n<img src=x onerror=alert(1)>', ...over
})
const list = (records: LegacyMailboxDetail[], cursor?: string): LegacyMailboxViewReply => ({ ok: true, result: {
  schemaVersion: 1, records: records.map(({ body: _body, ...summary }): LegacyMailboxSummary => summary), ...(cursor ? { cursor } : {})
} })
const read = (value: LegacyMailboxDetail): LegacyMailboxViewReply => ({ ok: true, result: { schemaVersion: 1, record: value } })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
let host: HTMLDivElement
let root: Root
const close = vi.fn()
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); close.mockClear() })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const render = async (view?: LegacyMailboxView): Promise<void> => {
  await act(async () => root.render(<LegacyMailboxPanel api={view ? { agentMailbox: { legacyView: view } } : {}} onClose={close} />))
}
const click = async (element: HTMLElement): Promise<void> => { await act(async () => element.click()) }
const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((element) => element.textContent === label)
  if (!found) throw new Error(`No button ${label}`)
  return found
}
const text = (): string => document.body.textContent ?? ''

describe('held historical recovery view', () => {
  it('opens separately from the current agent mailbox and uses only local list/read requests', async () => {
    const historical = Object.freeze(record())
    const legacyView = vi.fn<LegacyMailboxView>().mockResolvedValueOnce(list([historical])).mockResolvedValueOnce(read(historical))
    const mutation = vi.fn(() => { throw new Error('No historical mutation is allowed') })
    const api = { paneOwnership: { adopt: mutation }, agentMailbox: { view: vi.fn().mockResolvedValue({ ok: true, result: { schemaVersion: 1, messages: [] } }), legacyView, ack: mutation, complete: mutation, rebind: mutation, resend: mutation } }
    await act(async () => root.render(<AgentMailboxPanel nodeId="current-worker" projectId="private-a" title="Current live worker" api={api} onClose={close} />))
    expect(legacyView).not.toHaveBeenCalled()
    expect(text()).toContain('held deliveries have unverified bindings')
    await click(button('Historical hold'))
    expect(document.querySelector('.agent-mailbox__header')?.textContent).toContain('Local desktop recovery archive')
    expect(document.querySelector('.agent-mailbox__header')?.textContent).not.toContain('Current live worker')
    expect(text()).toContain('not automatically assigned to any current agent')
    expect(text()).not.toContain('Authorize this running session')
    expect(text()).toContain('Delivery: held')
    expect(text()).toContain('Processing: unacknowledged')
    expect(legacyView.mock.calls).toEqual([[{ kind: 'list', limit: 30 }]])
    expect(text()).not.toContain('Synthetic old task')
    await click(document.querySelector('.agent-mailbox__row') as HTMLElement)
    expect(legacyView.mock.calls[1]).toEqual([{ kind: 'read', legacyId: legacyId('a') }])
    expect(text()).toContain('historical-session (unverified)')
    expect(document.querySelector('.agent-mailbox__message')?.textContent).toContain('<img src=x')
    expect(document.querySelector('.agent-mailbox__message img')).toBeNull()
    expect(document.querySelector('.agent-mailbox__row b')).toBeNull()
    expect(mutation).not.toHaveBeenCalled()
    expect(historical.processingStatus).toBe('unacknowledged')
    expect([...document.querySelectorAll('button')].some((element) => /^(ack|complete|rebind|resend)$/i.test(element.textContent ?? ''))).toBe(false)
    await click(button('Back to mailbox'))
    expect(text()).toContain('Current live worker')
    expect(legacyView).toHaveBeenCalledTimes(2)
  })

  it('distinguishes omitted bodies from bodies recorded as empty', async () => {
    const missing = record({ bodyAvailable: false, missingBodyReason: 'omitted-by-legacy-queue', body: undefined })
    const empty = record({ legacyId: legacyId('b'), body: '' })
    const view = vi.fn<LegacyMailboxView>().mockResolvedValueOnce(list([missing, empty])).mockResolvedValueOnce(read(missing)).mockResolvedValueOnce(read(empty))
    await render(view)
    await click(document.querySelectorAll('.agent-mailbox__row')[0] as HTMLElement)
    expect(text()).toContain('old delivery queue omitted this message body')
    expect(document.querySelector('.agent-mailbox__message')).toBeNull()
    await click(document.querySelectorAll('.agent-mailbox__row')[1] as HTMLElement)
    expect(text()).toContain('recorded message body is empty')
    expect(document.querySelector('.agent-mailbox__message')?.textContent).toBe('')
    expect(text()).not.toContain('old delivery queue omitted this message body')
  })

  it('preserves distinct legacy records from the same source and follows the opaque cursor', async () => {
    const view = vi.fn<LegacyMailboxView>().mockResolvedValueOnce(list([record()], legacyId('a'))).mockResolvedValueOnce(list([record({ legacyId: legacyId('b') })]))
    await render(view)
    await click(button('Load more history'))
    expect(view.mock.calls[1]).toEqual([{ kind: 'list', limit: 30, cursor: legacyId('a') }])
    expect(document.querySelectorAll('.agent-mailbox__row')).toHaveLength(2)
  })

  it.each(['not-permitted', 'store-unavailable', 'unsupported-edition'] as const)('shows %s without a successful empty archive', async (code) => {
    await render(vi.fn<LegacyMailboxView>().mockResolvedValue({ ok: false, code, error: 'Synthetic archive refusal', retryable: false }))
    expect(document.querySelector('[role=alert]')?.textContent).toContain(code)
    expect(text()).not.toContain('No held historical records.')
    expect(document.querySelectorAll('.agent-mailbox__row')).toHaveLength(0)
  })

  it('reports missing capability explicitly and never uses a different bridge', async () => {
    await render()
    expect(text()).toContain('Only the local desktop main window can read it')
    expect(text()).not.toContain('No held historical records.')
    expect(button('Refresh history').disabled).toBe(true)
  })

  it('discards an in-flight detail when connection authority changes', async () => {
    const pending = deferred<LegacyMailboxViewReply>()
    const first = vi.fn<LegacyMailboxView>().mockResolvedValueOnce(list([record()])).mockReturnValueOnce(pending.promise)
    await render(first)
    await click(document.querySelector('.agent-mailbox__row') as HTMLElement)
    await render(vi.fn<LegacyMailboxView>().mockResolvedValue({ ok: false, code: 'not-permitted', error: 'Connection changed', retryable: false }))
    await act(async () => pending.resolve(read(record())))
    expect(text()).toContain('Connection changed')
    expect(text()).not.toContain('Synthetic old task')
    expect(document.querySelectorAll('.agent-mailbox__row')).toHaveLength(0)
  })

  it('refuses an unexpected verified record rather than presenting it as a historical hold', async () => {
    const bad = { ...record(), unverified: false } as unknown as LegacyMailboxDetail
    await render(vi.fn<LegacyMailboxView>().mockResolvedValue(list([bad])))
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Unsupported historical hold response')
    expect(document.querySelectorAll('.agent-mailbox__row')).toHaveLength(0)
  })

  it('clears prior records if a later page is refused, and Escape closes the view', async () => {
    const view = vi.fn<LegacyMailboxView>().mockResolvedValueOnce(list([record()], legacyId('a'))).mockResolvedValueOnce({ ok: false, code: 'not-permitted', error: 'Historical read no longer permitted', retryable: false })
    await render(view)
    await click(button('Load more history'))
    expect(document.querySelectorAll('.agent-mailbox__row')).toHaveLength(0)
    expect(text()).toContain('Historical read no longer permitted')
    await act(async () => { document.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(close).toHaveBeenCalledTimes(1)
  })
})
