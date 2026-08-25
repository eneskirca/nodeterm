// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContextMeter } from './ContextMeter'
import { useContextWindow } from '../state/contextWindow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const usage = {
  sessionId: 'sid-1',
  usedTokens: 40_000,
  windowTokens: 200_000,
  usedPercent: 20,
  model: 'claude-sonnet-4-5',
  updatedAt: Date.now()
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  useContextWindow.setState({ bySessionId: {} })
})

function render(modelOverride?: string): void {
  useContextWindow.setState({ bySessionId: { [usage.sessionId]: usage } })
  act(() => root.render(
    <ContextMeter sessionId={usage.sessionId} modelOverride={modelOverride} />
  ))
}

describe('ContextMeter model label', () => {
  it('shows an explicit switched model before the transcript emits a new usage sample', () => {
    render('anthropic/claude-opus-4-8')

    expect(host.textContent).toContain('Opus 4.8')
    expect(host.textContent).not.toContain('Sonnet 4.5')
  })

  it('falls back to the transcript model when the node has no explicit selection', () => {
    render()

    expect(host.textContent).toContain('Sonnet 4.5')
  })
})
