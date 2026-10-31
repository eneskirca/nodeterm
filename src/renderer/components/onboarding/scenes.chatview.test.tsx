// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SceneChatView } from './scenes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// AgentMascot / AgentIcon pull brand SVGs; the scene only needs them to render something.
vi.mock('../../lib/agentIcons', () => ({ AgentIcon: () => <span data-icon /> }))

/**
 * The ⌘M onboarding scene. Two contracts: (1) it draws BOTH faces of the same node (terminal
 * + chat thread) so the crossfade has something to fade between, and (2) the user's real
 * keystroke (`pulseKey`) flips the face — the animation answers the try-it, as kanban's does.
 */
describe('SceneChatView', () => {
  let root: Root
  let host: HTMLElement

  beforeEach(() => {
    vi.useFakeTimers()
    // jsdom has no matchMedia; the scene reads it once to honour reduced motion.
    window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  const render = async (pulseKey?: number): Promise<void> => {
    await act(async () =>
      root.render(
        <SceneChatView agentId="claude" label="Claude Code" color="#d97757" keys={['⌘', 'M']} pulseKey={pulseKey} />
      )
    )
  }

  it('draws the chord, the node, and both faces of it', async () => {
    await render(0)
    expect(host.querySelectorAll('.onb-cview__key').length).toBe(2)
    expect(host.querySelector('.onb-node__title')?.textContent).toBe('Claude Code')
    expect(host.querySelector('.onb-cview__term')).not.toBeNull()
    expect(host.querySelector('.onb-cview__chat')).not.toBeNull()
    // starts on the terminal face
    expect(host.querySelector('.onb-cview')?.classList.contains('is-chat')).toBe(false)
    expect(host.querySelector('.onb-cview__mode')?.textContent).toBe('terminal')
  })

  it('flips to the chat face when the user presses the real chord (pulseKey)', async () => {
    await render(0)
    await render(1)
    expect(host.querySelector('.onb-cview')?.classList.contains('is-chat')).toBe(true)
    expect(host.querySelector('.onb-cview__mode')?.textContent).toBe('chat')
    // and back on the next press — ⌘M is a toggle
    await render(2)
    expect(host.querySelector('.onb-cview')?.classList.contains('is-chat')).toBe(false)
  })

  it('loops on its own timer when nobody presses anything', async () => {
    await render(0)
    await act(async () => {
      vi.advanceTimersByTime(2800)
    })
    expect(host.querySelector('.onb-cview')?.classList.contains('is-chat')).toBe(true)
  })

  it('drops the chord row when the toggle is unbound', async () => {
    await act(async () =>
      root.render(<SceneChatView agentId="claude" label="Claude Code" color="#d97757" keys={[]} />)
    )
    expect(host.querySelector('.onb-cview__keys')).toBeNull()
    expect(host.querySelector('.onb-cview')).not.toBeNull()
  })
})
