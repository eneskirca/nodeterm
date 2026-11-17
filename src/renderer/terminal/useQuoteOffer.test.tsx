// @vitest-environment jsdom
//
// The "Add to chat" offer a terminal makes at its copy moment: it holds the copied text for
// QUOTE_OFFER_MS, a newer copy replaces it, and a terminal with no agent offers nothing.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUOTE_OFFER_MS, useQuoteOffer, type QuoteOfferApi } from './useQuoteOffer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
/** Every value the hook returned, newest last. */
let seen: QuoteOfferApi[]

function Probe({ enabled }: { enabled: boolean }) {
  seen.push(useQuoteOffer({ enabled }))
  return null
}

const latest = (): QuoteOfferApi => seen[seen.length - 1]

async function render(enabled: boolean): Promise<void> {
  await act(async () => root.render(<Probe enabled={enabled} />))
}

beforeEach(() => {
  vi.useFakeTimers()
  seen = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('useQuoteOffer', () => {
  it('holds the copied text for six seconds', async () => {
    expect(QUOTE_OFFER_MS).toBe(6000)
    await render(true)
    expect(latest().offer).toBeNull()
    act(() => latest().notify('a'))
    expect(latest().offer).toBe('a')
    advance(5999)
    expect(latest().offer).toBe('a')
    advance(1)
    expect(latest().offer).toBeNull()
  })

  it('offers nothing for a terminal with no agent', async () => {
    await render(false)
    act(() => latest().notify('a'))
    expect(latest().offer).toBeNull()
    advance(QUOTE_OFFER_MS)
    expect(latest().offer).toBeNull()
  })

  it('replaces the offer with a newer copy, and gives the newer one its full time', async () => {
    await render(true)
    act(() => latest().notify('a'))
    advance(4000)
    act(() => latest().notify('b'))
    expect(latest().offer).toBe('b')
    advance(4000)
    expect(latest().offer).toBe('b')
    advance(2000)
    expect(latest().offer).toBeNull()
  })

  it('clears at once, and the old timer brings nothing back', async () => {
    await render(true)
    act(() => latest().notify('a'))
    act(() => latest().clear())
    expect(latest().offer).toBeNull()
    advance(QUOTE_OFFER_MS)
    expect(latest().offer).toBeNull()
  })

  it('does not offer a copy with nothing in it', async () => {
    await render(true)
    act(() => latest().notify(' \n\t '))
    expect(latest().offer).toBeNull()
  })

  it('drops the offer when the node stops being an agent node', async () => {
    await render(true)
    act(() => latest().notify('a'))
    await render(false)
    expect(latest().offer).toBeNull()
  })

  it('keeps notify and clear the same functions across renders (they are published in a map)', async () => {
    await render(true)
    const first = latest()
    act(() => first.notify('a'))
    await render(true)
    expect(latest().notify).toBe(first.notify)
    expect(latest().clear).toBe(first.clear)
  })
})
