// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { useBrowserHistory } from '../state/browserHistory'
import { BrowserStartPage } from './BrowserStartPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('BrowserStartPage', () => {
  // The page used to select `s.recent(8)` — a NEW array on every read, which zustand 5 never sees
  // as unchanged: "Maximum update depth exceeded" the moment a blank browser showed this page.
  it('renders the recent list without looping', () => {
    useBrowserHistory.setState({
      entries: [
        { url: 'https://example.com/a', title: 'A', ts: 2 },
        { url: 'https://example.com/b', title: 'B', ts: 1 }
      ]
    })
    const host = document.createElement('div')
    const root = createRoot(host)
    expect(() => act(() => root.render(<BrowserStartPage onNavigate={() => undefined} />))).not.toThrow()
    expect(host.querySelectorAll('.startpage__recent-item')).toHaveLength(2)
    act(() => root.unmount())
  })
})
