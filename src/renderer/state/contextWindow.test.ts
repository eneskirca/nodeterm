// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'

it('keeps copied remote session ids separate and ignores stale clears for another session', async () => {
  vi.resetModules()
  const { useContextWindow } = await import('./contextWindow')
  const usage = { sessionId: 'copied', usedTokens: 10, windowTokens: 100, usedPercent: 10, model: 'gpt', updatedAt: 1, windowSource: 'transcript' as const }
  const put = useContextWindow.getState().set
  put(usage)
  put({ ...usage, nodeId: 'host-a', usedTokens: 20 })
  put({ ...usage, nodeId: 'host-b', usedTokens: 70 })
  expect(useContextWindow.getState().bySessionId.copied.usedTokens).toBe(10)
  expect(useContextWindow.getState().byNodeId['host-a'].usedTokens).toBe(20)
  expect(useContextWindow.getState().byNodeId['host-b'].usedTokens).toBe(70)
  put({ ...usage, nodeId: 'host-a', sessionId: 'new' })
  put({ ...usage, nodeId: 'host-a', cleared: true })
  expect(useContextWindow.getState().byNodeId['host-a'].sessionId).toBe('new')
  put({ ...usage, nodeId: 'host-a', sessionId: 'new', cleared: true })
  expect(useContextWindow.getState().byNodeId['host-a']).toBeUndefined()
  expect(useContextWindow.getState().byNodeId['host-b'].usedTokens).toBe(70)
})

it('does not restore an old denominator from persistent browser state', async () => {
  localStorage.setItem('nodeterm.contextWindow', JSON.stringify({ old: { sessionId: 'old', windowTokens: 200000 }, claude: { sessionId: 'claude', windowSource: 'session-env', windowTokens: 32000 }, own: { sessionId: 'own', windowSource: 'transcript', windowTokens: 64000 } }))
  vi.resetModules()
  const { useContextWindow } = await import('./contextWindow')
  expect(useContextWindow.getState().bySessionId).toEqual({ own: { sessionId: 'own', windowSource: 'transcript', windowTokens: 64000 } })
  localStorage.clear()
})
