// @vitest-environment jsdom
//
// The terminal surfaces' "Add to chat" glue: a copy offers a quote only while the node's agent CLI
// is in the pane (read at the copy, not at render), a covered terminal withdraws its offer, and a
// click quotes to the node through the one funnel, over the session's own api.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import { useTerminalQuote, type TerminalQuote } from './useTerminalQuote'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Status = { agentId?: string; hibernated?: boolean; paused?: boolean; dropped?: boolean; sessionEnded?: boolean }

let host: HTMLDivElement
let root: Root
let seen: TerminalQuote[]
let status: Status | undefined
const sendText = vi.fn(async () => true as const)
// The funnel asks the kernel who owns the pane before it types (lib/chatPaneGate.ts): codex's own.
const paneOwner = vi.fn(async () => ({
  panePid: 100,
  tty: '/dev/pts/31',
  command: 'node',
  argv: ['node /usr/bin/codex', '/usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex'],
  pids: [201550, 201574]
}))
const api = {
  pty: { sendText, paneOwner, readChatScreen: vi.fn(async () => ({ screen: { kind: 'prompt' }, suggestion: null })) }
} as unknown as NodeTerminalApi

function Probe(props: { agentId?: string; covered?: boolean }) {
  seen.push(
    useTerminalQuote({
      api,
      nodeId: 'n1',
      agentId: props.agentId,
      enabled: true,
      covered: props.covered ?? false,
      readStatus: () => status
    })
  )
  return null
}
const latest = (): TerminalQuote => seen[seen.length - 1]

async function render(props: { agentId?: string; covered?: boolean } = { agentId: 'codex' }): Promise<void> {
  await act(async () => root.render(<Probe {...props} />))
}

beforeEach(() => {
  seen = []
  status = undefined
  sendText.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useTerminalQuote', () => {
  it('offers what was copied while the agent CLI is in the pane', async () => {
    await render()
    act(() => latest().notify('the copied line'))
    expect(latest().offer).toBe('the copied line')
  })

  it("offers nothing once the agent's CLI has left the pane — the funnel would only refuse it", async () => {
    await render()
    for (const gone of [{ hibernated: true }, { paused: true }, { dropped: true }, { sessionEnded: true }]) {
      status = gone
      act(() => latest().notify('x'))
      expect(latest().offer).toBeNull()
    }
  })

  it('reads the pane at the copy, not at render', async () => {
    await render()
    status = { sessionEnded: true }
    act(() => latest().notify('x'))
    expect(latest().offer).toBeNull()
    status = undefined // the CLI is back; nothing re-rendered since
    act(() => latest().notify('y'))
    expect(latest().offer).toBe('y')
  })

  it('takes a hook-identified agent when the node was created without one', async () => {
    await render({})
    act(() => latest().notify('x'))
    expect(latest().offer).toBeNull() // no agent at all: a plain terminal
    status = { agentId: 'claude' }
    act(() => latest().notify('x'))
    expect(latest().offer).toBe('x')
  })

  it('keeps one notify identity across renders (a module-level registry compares it)', async () => {
    await render()
    const first = latest().notify
    await render({ agentId: 'codex', covered: false })
    expect(latest().notify).toBe(first)
  })

  it('a covered terminal withdraws its offer', async () => {
    await render()
    act(() => latest().notify('x'))
    await render({ agentId: 'codex', covered: true })
    expect(latest().offer).toBeNull()
  })

  it('a click quotes to the node through the funnel, unsent at its prompt', async () => {
    await render()
    act(() => latest().notify('quote me'))
    await act(async () => latest().add('quote me'))
    expect(latest().offer).toBeNull()
    expect(paneOwner).toHaveBeenCalledWith('n1')
    expect(sendText).toHaveBeenCalledWith('n1', '> quote me', { enter: false })
  })
})
