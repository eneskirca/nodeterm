// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { ContextApi } from '@shared/types'
import type { AgentId } from '@shared/agents/config'
import { useContextEnsure } from './useContextEnsure'

function Probe({ api, node = 'canvas', sid = 's1', account = 'a', agent = 'codex' }: {
  api: ContextApi; node?: string; sid?: string; account?: string; agent?: AgentId
}) {
  useContextEnsure(api, node, agent, sid || undefined, '/remote/repo', account)
  return null
}
it('rehydrates canvas/modal mounts and changed node, account, session and core identities', async () => {
  const first = { ensure: vi.fn(), onUpdate: vi.fn() }, second = { ensure: vi.fn(), onUpdate: vi.fn() }
  const local = vi.fn()
  Object.defineProperty(window, 'nodeTerminal', { configurable: true, value: { context: { ensure: local } } })
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<Probe api={first} />))
    expect(first.ensure).toHaveBeenLastCalledWith('s1', '/remote/repo', 'a', 'canvas', 'codex')
    await act(async () => root.render(<Probe api={first} account="b" />))
    expect(first.ensure).toHaveBeenLastCalledWith('s1', '/remote/repo', 'b', 'canvas', 'codex')
    await act(async () => root.render(<Probe api={second} account="b" />))
    expect(second.ensure).toHaveBeenLastCalledWith('s1', '/remote/repo', 'b', 'canvas', 'codex')
    await act(async () => root.render(<Probe api={second} node="modal" sid="s2" />))
    expect(second.ensure).toHaveBeenLastCalledWith('s2', '/remote/repo', 'a', 'modal', 'codex')
    await act(async () => root.render(null))
    await act(async () => root.render(<Probe api={second} node="modal" sid="s2" />))
    expect(second.ensure).toHaveBeenCalledTimes(3)
    expect(local).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()) }
})
it('does not ask for an unknown session or unsupported agent; keeps Claude routing', async () => {
  const api = { ensure: vi.fn(), onUpdate: vi.fn() }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<Probe api={api} sid="" />))
    await act(async () => root.render(<Probe api={api} agent="custom:unsupported" />))
    expect(api.ensure).not.toHaveBeenCalled()
    await act(async () => root.render(<Probe api={api} agent="claude" account="claude-account" />))
    expect(api.ensure).toHaveBeenCalledWith('s1', '/remote/repo', 'claude-account', 'canvas', 'claude')
  } finally { await act(async () => root.unmount()) }
})
