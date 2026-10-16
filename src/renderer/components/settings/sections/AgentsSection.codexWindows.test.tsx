// @vitest-environment jsdom
//
// Shared Codex identity is gated off on Windows (phase 1). The node works fine, so there is no
// per-node chip — but Settings says so once, instead of leaving the feature silently missing.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { UNKNOWN_CODEX_IDENTITY_CAPS } from '@shared/types'
import { resetCodexIdentityCapsForTests } from '../../../state/codexIdentity'
import { AgentsSection } from './AgentsSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LINE = 'Shared Codex app-server is not available on Windows yet'
let root: Root | null = null
let host: HTMLElement | null = null

async function render(): Promise<string> {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    settings: { save: vi.fn(async () => undefined) },
    claude: { cliCaps: vi.fn(async () => null) }
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<AgentsSection isActive />)
  })
  return host.textContent ?? ''
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  root = null
  host = null
  resetCodexIdentityCapsForTests()
})

describe('Settings → Agents: shared Codex identity on Windows', () => {
  it('shows one muted line when the core reports unsupported-platform', async () => {
    resetCodexIdentityCapsForTests({ ...UNKNOWN_CODEX_IDENTITY_CAPS, unavailableReason: 'unsupported-platform' })
    const text = await render()
    expect(text.split(LINE)).toHaveLength(2)
  })

  it('says nothing on any other answer', async () => {
    resetCodexIdentityCapsForTests(UNKNOWN_CODEX_IDENTITY_CAPS)
    expect(await render()).not.toContain(LINE)
  })
})
