// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { KanbanSourceFilter } from './KanbanSourceFilter'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('KanbanSourceFilter', () => {
  it('offers All, Issues, Pull requests, and Sessions without changing board data', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const onChange = vi.fn()
    act(() => root.render(<KanbanSourceFilter value="all" onChange={onChange} />))
    expect([...host.querySelectorAll('button')].map((button) => button.textContent))
      .toEqual(['All', 'Issues', 'Pull requests', 'Sessions'])
    act(() => host.querySelectorAll('button')[1].click())
    expect(onChange).toHaveBeenCalledWith('github')
    act(() => root.unmount())
  })
})
