// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ContextMeter } from './ContextMeter'
import { useContextWindow } from '../state/contextWindow'
import { useSettings } from '../state/settings'
import { setCustomAgentBaseResolver } from '@shared/agents/config'
import type { PtyEnvInfo } from '@shared/types'

it('qualifies model-name guesses but not observed session configuration', async () => {
  const el = document.createElement('div')
  const root = createRoot(el)
  const usage = { sessionId: 's', usedTokens: 16000, windowTokens: 32000, usedPercent: 50, model: 'vendor-sonnet', updatedAt: Date.now() }
  try {
    useContextWindow.getState().set({ ...usage, windowSource: 'estimate' })
    await act(async () => root.render(<ContextMeter sessionId="s" />))
    // The estimate is the '~' on the pill and the popover's "(estimated window)" — the pill title
    // itself stays plain.
    expect(el.querySelector('.ctx-pill__num')?.textContent).toContain('~')
    await act(async () => { useContextWindow.getState().set({ ...usage, windowSource: 'session-env' }) })
    // An observed (session-env) window is not an estimate: no tilde.
    expect(el.querySelector('.ctx-pill__num')?.textContent).not.toContain('~')
  } finally { await act(async () => root.unmount()) }
})

it('shows only the requested SSH node even when local and remote rollouts share an id', async () => {
  useSettings.setState(s => ({ settings: { ...s.settings, usagePercentMode: 'used' } }))
  const el = document.createElement('div')
  const root = createRoot(el)
  const usage = { sessionId: 'copied', usedTokens: 10, windowTokens: 100, usedPercent: 10, model: 'gpt', updatedAt: Date.now(), windowSource: 'transcript' as const }
  useContextWindow.setState({ bySessionId: {}, byNodeId: {} })
  useContextWindow.getState().set(usage)
  // Node-scoped copy on host A: 70% there (70/100 used tokens for that node's own denominator).
  useContextWindow.getState().set({ ...usage, nodeId: 'a', usedTokens: 70, usedPercent: 70 })
  try {
    await act(async () => root.render(<ContextMeter sessionId="copied" nodeId="b" remote agentId="codex" />))
    expect(el.querySelector('button')).toBeNull()
    await act(async () => root.render(<ContextMeter sessionId="copied" nodeId="a" remote agentId="codex" />))
    expect(el.querySelector('button')?.title).toContain('70%')
    setCustomAgentBaseResolver(id => id === 'custom:remote-codex' ? 'codex' : undefined)
    await act(async () => root.render(<ContextMeter sessionId="copied" nodeId="b" remote agentId="custom:remote-codex" />))
    expect(el.querySelector('button')).toBeNull()
    await act(async () => root.render(<ContextMeter sessionId="new-thread" nodeId="a" remote agentId="codex" />))
    expect(el.querySelector('button')).toBeNull()
    await act(async () => root.render(<ContextMeter sessionId="copied" />))
    expect(el.querySelector('button')?.title).toContain('10%')
  } finally {
    setCustomAgentBaseResolver(null)
    await act(async () => root.unmount())
  }
})

const h = vi.hoisted(() => ({
  requests: [] as Array<{
    nodeId: string
    resolve: (info: PtyEnvInfo) => void
  }>
}))

vi.mock('../session/session', () => ({
  activeSessionApi: () => ({
    pty: {
      envInfo: (nodeId: string) =>
        new Promise<PtyEnvInfo>((resolve) => h.requests.push({ nodeId, resolve }))
    }
  })
}))


;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const info = (key: string): PtyEnvInfo => ({
  source: 'spawn',
  vars: [{ key, value: key.toLowerCase() }]
})

describe('ContextMeter spawn environment', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    h.requests.length = 0
    // The meter renders nothing until the session has usage data; every env test seeds one row so
    // the pill exists to click. (Ours' original relied on cross-test localStorage pollution.)
    useContextWindow.setState({ bySessionId: {}, byNodeId: {} })
    useContextWindow.getState().set({
      sessionId: 'session',
      usedTokens: 1000,
      windowTokens: 10_000,
      usedPercent: 10,
      model: 'm',
      updatedAt: Date.now(),
      windowSource: 'transcript'
    })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.innerHTML = ''
  })

  const clickMeter = (): void => {
    ;(host.querySelector('.ctx-pill') as HTMLButtonElement).click()
  }

  it('clears an old result before refetching when reopened', async () => {
    await act(async () => root.render(<ContextMeter sessionId="session" nodeId="node-a" />))
    await act(async () => clickMeter())
    expect(h.requests.map((request) => request.nodeId)).toEqual(['node-a'])
    await act(async () => h.requests[0].resolve(info('A_ONLY')))
    expect(host.textContent).toContain('A_ONLY')

    await act(async () => clickMeter())
    await act(async () => clickMeter())
    expect(h.requests.map((request) => request.nodeId)).toEqual(['node-a', 'node-a'])
    expect(host.textContent).not.toContain('A_ONLY')

    await act(async () => h.requests[1].resolve(info('A_FRESH')))
    expect(host.textContent).toContain('A_FRESH')
  })

  it('hides the prior node and ignores its late response after nodeId changes', async () => {
    await act(async () => root.render(<ContextMeter sessionId="session" nodeId="node-a" />))
    await act(async () => clickMeter())
    await act(async () => h.requests[0].resolve(info('A_ONLY')))
    expect(host.textContent).toContain('A_ONLY')

    await act(async () => root.render(<ContextMeter sessionId="session" nodeId="node-b" />))
    expect(h.requests.map((request) => request.nodeId)).toEqual(['node-a', 'node-b'])
    expect(host.textContent).not.toContain('A_ONLY')

    const superseded = h.requests[1]
    await act(async () => root.render(<ContextMeter sessionId="session" nodeId="node-c" />))
    await act(async () => h.requests[2].resolve(info('C_ONLY')))
    expect(host.textContent).toContain('C_ONLY')
    await act(async () => superseded.resolve(info('B_LATE')))
    expect(host.textContent).toContain('C_ONLY')
    expect(host.textContent).not.toContain('B_LATE')
  })
})
