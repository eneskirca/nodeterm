// @vitest-environment jsdom
// Issue #814: the card must show the no-channel state as its own card — the manual-download
// MECHANISM (one card, one link to the download page), a different sentence. And the two states
// it sits between must be untouched: "up to date" still means we looked, and the Linux .deb card
// still names its version.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateCard } from './UpdateCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Fire = (...a: unknown[]) => void
const fire: Record<string, Fire> = {}
const sub = (name: string) => (listener: Fire) => {
  fire[name] = listener
  return () => delete fire[name]
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const opened: string[] = []

beforeEach(() => {
  for (const k of Object.keys(fire)) delete fire[k]
  opened.length = 0
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    updates: {
      onAvailable: sub('available'),
      onDownloaded: sub('downloaded'),
      onProgress: sub('progress'),
      onError: sub('error'),
      onNotAvailable: sub('notAvailable'),
      onNoChannel: sub('noChannel'),
      getPolicy: () => Promise.resolve({ minSupported: null, mandatory: false }),
      check: () => {},
      restart: () => {}
    }
  }
  window.open = ((url: string) => {
    opened.push(url)
    return null
  }) as typeof window.open
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
    root.render(<UpdateCard />)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const text = (): string => container.textContent ?? ''

describe('the no-channel card', () => {
  beforeEach(() => act(() => fire.noChannel()))

  it('says the build has no channel and points at the download page', () => {
    expect(text()).toContain('No update channel')
    expect(text()).toContain('This build has no update channel')
    expect(text()).toContain('Download the latest installer to update.')
  })

  it('never claims the user is up to date', () => {
    expect(text()).not.toContain('up to date')
    expect(text()).not.toContain('latest version')
  })

  it('offers the download page through the same link the manual card uses', () => {
    const btn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Open download page'
    )
    expect(btn).toBeTruthy()
    act(() => btn!.click())
    expect(opened).toEqual(['https://nodeterm.dev/releases'])
  })

  it('stays put — no auto-dismiss timer, unlike the up-to-date toast', () => {
    vi.useFakeTimers()
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(text()).toContain('No update channel')
  })

  it('is dismissible, and nothing else remains', () => {
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')
    expect(close).toBeTruthy()
    act(() => close!.click())
    expect(container.textContent).toBe('')
  })
})

describe('the states either side of it are unchanged', () => {
  it('"not available" still renders the up-to-date card', () => {
    act(() => fire.notAvailable())
    expect(text()).toContain("You're up to date")
    expect(text()).toContain('nodeterm is on the latest version.')
    expect(text()).not.toContain('No update channel')
  })

  it('a Linux .deb update still names its version on the manual card', () => {
    act(() => fire.available({ version: '0.3.8', notes: '', manual: true }))
    expect(text()).toContain('Update available')
    expect(text()).toContain('nodeterm v0.3.8 is available. Download it to update.')
    expect(text()).not.toContain('No update channel')
  })
})
