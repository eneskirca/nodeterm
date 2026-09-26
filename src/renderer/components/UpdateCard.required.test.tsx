// @vitest-environment jsdom
// Issue #898: with "Download and install updates automatically" off, "Update now" on the mandatory
// card leads to a manual update-available. That must not replace the non-dismissible required card
// with the optional (dismissible) Download card: the card stays required and offers the download.
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
      getPolicy: () => Promise.resolve({ minSupported: '0.3.9', mandatory: true }),
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
const buttons = (): string[] => [...container.querySelectorAll('button')].map((b) => b.textContent ?? '')

describe('the mandatory-update card when the update is manual', () => {
  beforeEach(async () => {
    await act(async () => {}) // let getPolicy resolve
  })

  it('starts as the required card', () => {
    expect(text()).toContain('Update required')
    expect(buttons()).toContain('Update now')
  })

  it('stays required, cannot be dismissed, and offers the download page', () => {
    act(() => fire.available({ version: '0.3.9', notes: '', manual: true }))
    expect(text()).toContain('Update required')
    expect(text()).toContain('minimum 0.3.9')
    expect(buttons().some((b) => b.includes('Dismiss'))).toBe(false)
    expect(container.querySelector('[title="Dismiss"]')).toBeNull()
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Download')
    expect(btn).toBeTruthy()
    act(() => btn!.click())
    expect(opened).toEqual(['https://nodeterm.dev/releases'])
  })

  it('still follows a self-install download as before', () => {
    act(() => fire.available({ version: '0.3.9', notes: '', manual: false }))
    expect(text()).toContain('Downloading Update')
  })
})
