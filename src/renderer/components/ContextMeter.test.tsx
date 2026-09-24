// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ContextMeter } from './ContextMeter'
import { useContextWindow } from '../state/contextWindow'
import { useSettings } from '../state/settings'
import { setCustomAgentBaseResolver } from '@shared/agents/config'

it('qualifies model-name guesses but not observed session configuration', async () => {
  const el = document.createElement('div')
  const root = createRoot(el)
  const usage = { sessionId: 's', usedTokens: 16000, windowTokens: 32000, usedPercent: 50, model: 'vendor-sonnet', updatedAt: Date.now() }
  try {
    useContextWindow.getState().set({ ...usage, windowSource: 'estimate' })
    await act(async () => root.render(<ContextMeter sessionId="s" />))
    expect(el.querySelector('button')?.title).toContain('Estimated context window')
    await act(async () => { useContextWindow.getState().set({ ...usage, windowSource: 'session-env' }) })
    expect(el.querySelector('button')?.title).toMatch(/^Context window/)
  } finally { await act(async () => root.unmount()) }
})

it('shows only the requested SSH node even when local and remote rollouts share an id', async () => {
  useSettings.setState(s => ({ settings: { ...s.settings, usagePercentMode: 'used' } }))
  const el = document.createElement('div')
  const root = createRoot(el)
  const usage = { sessionId: 'copied', usedTokens: 10, windowTokens: 100, usedPercent: 10, model: 'gpt', updatedAt: Date.now(), windowSource: 'transcript' as const }
  useContextWindow.setState({ bySessionId: {}, byNodeId: {} })
  useContextWindow.getState().set(usage)
  useContextWindow.getState().set({ ...usage, nodeId: 'a', usedPercent: 70 })
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
