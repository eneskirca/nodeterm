// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyEnvInfo } from '@shared/types'

const h = vi.hoisted(() => ({
  requests: [] as Array<{
    nodeId: string
    resolve: (info: PtyEnvInfo) => void
  }>
}))

vi.mock('../state/contextWindow', () => ({
  useContextWindow: (selector: (state: unknown) => unknown) =>
    selector({
      bySessionId: {
        session: {
          sessionId: 'session',
          usedTokens: 50_000,
          windowTokens: 200_000,
          usedPercent: 25,
          model: 'test-model',
          updatedAt: Date.now()
        }
      }
    })
}))

vi.mock('../state/settings', () => ({
  useSettings: (selector: (state: unknown) => unknown) =>
    selector({ settings: { usagePercentMode: 'used' } })
}))

vi.mock('../session/session', () => ({
  activeSessionApi: () => ({
    pty: {
      envInfo: (nodeId: string) =>
        new Promise<PtyEnvInfo>((resolve) => h.requests.push({ nodeId, resolve }))
    }
  })
}))

import { ContextMeter } from './ContextMeter'

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
