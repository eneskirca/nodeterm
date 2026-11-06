// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatGateStatus } from '../../lib/chatSendGate'
import { pullLinkPlan, sendTo, type SendToPayload } from '../../lib/sendTo'
import { SENT_TOAST_MS, SendToProvider, useSendTo, type SendToHost } from './SendTo'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const nodes = [
  { id: 'pull', type: 'pull', data: {} },
  { id: 'a1', type: 'terminal', data: { title: 'Reviewer', agentId: 'claude' } },
  { id: 'a2', type: 'terminal', data: { title: 'Fixer', agentId: 'claude' } },
  { id: 'a3', type: 'terminal', data: { title: 'Codex helper', agentId: 'codex' } },
  { id: 'sh', type: 'terminal', data: { title: 'zsh' } }
]

/** The canvas side, faked: the link store is planned exactly as Canvas plans it. */
function fakeHost(over: { status?: (id: string) => ChatGateStatus; relay?: boolean } = {}) {
  const links: { id: string; source: string; target: string }[] = []
  const ropes = [{ source: 'pull', target: 'a2' }]
  const sendChatPrompt = vi.fn(async (_id: string, _text: string, _agentId: string) => true as const)
  const link = vi.fn((agentNodeId: string) => {
    const plan = pullLinkPlan(agentNodeId, 'pull', links, () => ({ kind: 'terminal', contextCapable: true }))
    links.push(...plan.edges)
    return plan.linked.length > 0 || plan.skipped.some((s) => s.why === 'already linked')
  })
  const status = over.status ?? ((id: string): ChatGateStatus => ({ state: id === 'a1' ? 'working' : 'done' }))
  const host: SendToHost = {
    unavailable: over.relay ? 'Send to agent is not available in a relay tab.' : undefined,
    pullId: 'pull',
    nodes: () => nodes,
    edges: () => [...ropes, ...links],
    status,
    send: (targetId, pr, payload) => sendTo({
      relay: !!over.relay, nodes: () => nodes, link, status,
      paneOwner: async (id) => {
        const command = String(nodes.find((n) => n.id === id)?.data.agentId)
        return { panePid: 1, tty: 't', command, argv: [command] } as never
      },
      customAgents: [], sendChatPrompt, guard: async (_id, run) => run()
    }, { pullId: 'pull', targetId, pr, payload })
  }
  return { host, links, link, sendChatPrompt }
}

function Button({ payload, onSent }: { payload: SendToPayload; onSent?: () => void }): React.JSX.Element {
  const { sendTo: open, why } = useSendTo()
  return <><button disabled={!open} onClick={() => open?.(payload, onSent)}>Ask agent</button>{why && <span>{why}</span>}</>
}

let host: HTMLDivElement
let root: Root
afterEach(() => { act(() => root.unmount()); host.remove() })

async function mount(h: SendToHost, payload: SendToPayload = { kind: 'check', name: 'build' }, onSent?: () => void) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<SendToProvider host={h} pr={{ repository: 'o/r', number: 7, title: 'Add it' }}><Button payload={payload} onSent={onSent} /></SendToProvider>)
  })
}
const q = <T extends Element>(sel: string) => host.querySelector(sel) as T
const options = () => [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent)
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }) }
const key = async (k: string) => {
  await act(async () => { q('input').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
}
async function type(text: string) {
  const input = q<HTMLInputElement>('input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Send to… picker', () => {
  it('lists every agent node of the project, the linked one first, and the shell not at all', async () => {
    await mount(fakeHost().host)
    await click(q('button'))
    expect(q('[role="dialog"]').getAttribute('aria-label')).toBe('Send the failing check to')
    expect(options()).toEqual([expect.stringContaining('Fixer'), expect.stringContaining('Codex helper'), expect.stringContaining('Reviewer')])
    expect(options()[0]).toContain('linked')
    expect(options()[2]).toContain('working')
  })

  it('filters by the search box and closes on Escape', async () => {
    await mount(fakeHost().host)
    await click(q('button'))
    await type('codex')
    expect(options()).toEqual([expect.stringContaining('Codex helper')])
    await type('zzz')
    expect(host.textContent).toContain('No agent matches.')
    await key('Escape')
    expect(q('[role="dialog"]')).toBeNull()
  })

  it('sends once by keyboard, links the agent once, and runs onSent', async () => {
    const f = fakeHost()
    const onSent = vi.fn()
    await mount(f.host, { kind: 'pr' }, onSent)
    await click(q('button'))
    await key('ArrowDown')
    await key('ArrowDown')
    await key('ArrowUp')
    expect(q('[aria-selected="true"]').textContent).toContain('Codex helper')
    await key('Enter')
    expect(f.sendChatPrompt).toHaveBeenCalledTimes(1)
    expect(f.sendChatPrompt.mock.calls[0][0]).toBe('a3')
    expect(f.sendChatPrompt.mock.calls[0][1]).toContain('the whole PR')
    expect(f.links).toEqual([{ id: 'bridge-a3-pull', source: 'a3', target: 'pull' }])
    expect(onSent).toHaveBeenCalledTimes(1)
    expect(q('[role="dialog"]')).toBeNull()
    expect(q('[role="status"]').textContent).toContain('Sent to Codex helper.')
    // A second send to the same agent draws no second link; the agent now reads as linked.
    await click(q('button'))
    expect(options()[1]).toContain('Codex helper')
    expect(options()[1]).toContain('linked')
    await click(host.querySelectorAll('[role="option"]')[1])
    expect(f.sendChatPrompt).toHaveBeenCalledTimes(2)
    expect(f.links).toHaveLength(1)
  })

  it('takes the "Sent to" receipt down on its own', async () => {
    await mount(fakeHost().host, { kind: 'pr' })
    vi.useFakeTimers()
    try {
      await click(q('button'))
      await key('Enter')
      expect(q('[role="status"]').textContent).toContain('Sent to')
      await act(async () => { vi.advanceTimersByTime(SENT_TOAST_MS) })
      expect(q('[role="status"]')).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('shows the refusal for a busy agent, keeps the picker open, and links nothing', async () => {
    const f = fakeHost({ status: () => ({ state: 'waiting' }) })
    await mount(f.host)
    await click(q('button'))
    await click(host.querySelectorAll('[role="option"]')[0])
    expect(q('[role="alert"]').textContent).toContain('cannot take a message')
    expect(q('[role="dialog"]')).not.toBeNull()
    expect(f.sendChatPrompt).not.toHaveBeenCalled()
    expect(f.link).not.toHaveBeenCalled()
  })

  it('is off on a relay tab and says why', async () => {
    await mount(fakeHost({ relay: true }).host)
    expect(q<HTMLButtonElement>('button').disabled).toBe(true)
    expect(host.textContent).toContain('relay tab')
  })
})
