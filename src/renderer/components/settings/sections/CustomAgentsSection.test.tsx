// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { CustomAgentsSection } from './CustomAgentsSection'

// Standalone harness — react-dom + the real zustand settings store, no
// testing-library dependency. Each agent card is identified by a "Remove" button.
function renderSection(): { host: HTMLElement; root: Root } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<CustomAgentsSection isActive />)
  })
  return { host, root }
}

function addButton(host: HTMLElement): HTMLButtonElement {
  const btn = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Add agent'
  )
  expect(btn).toBeTruthy()
  return btn as HTMLButtonElement
}

function agentCards(host: HTMLElement): number {
  return (host.textContent!.split('Remove').length - 1)
}

describe('CustomAgentsSection add agent', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('adds a new agent card when Add agent is clicked', () => {
    const { host, root } = renderSection()
    const before = agentCards(host)
    act(() => {
      addButton(host).click()
    })
    expect(agentCards(host)).toBe(before + 1)
    root.unmount()
  })

  it('adds a card even when crypto.randomUUID is unavailable (plain-HTTP server)', () => {
    // Regression for CustomAgentsSection's original crypto.randomUUID() call: that is
    // secure-context-only, so the Server Edition on a LAN (plain http) threw on click,
    // and "Add agent" appeared to do nothing. getRandomValues is available everywhere.
    const desc = Object.getOwnPropertyDescriptor(window.crypto, 'randomUUID')
    Object.defineProperty(window.crypto, 'randomUUID', {
      value: undefined,
      configurable: true
    })
    const { host, root } = renderSection()
    const before = agentCards(host)
    try {
      act(() => {
        addButton(host).click()
      })
      expect(agentCards(host)).toBe(before + 1)
    } finally {
      if (desc) Object.defineProperty(window.crypto, 'randomUUID', desc)
    }
    root.unmount()
  })
})