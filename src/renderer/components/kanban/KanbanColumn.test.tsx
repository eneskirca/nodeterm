// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { KanbanColumn, type KanbanLane } from './KanbanColumn'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const lanes: KanbanLane[] = [
  { sourceId: 'github', count: 7, cards: <article key="i" className="gh">issue</article>,
    footer: <button key="more">Show more issues</button> },
  { sourceId: 'sessions', count: 2, cards: <article key="s" className="sess">session</article> }
]

const render = (extra: Partial<Parameters<typeof KanbanColumn>[0]> = {}): HTMLElement => {
  const host = document.createElement('div')
  act(() => createRoot(host).render(
    <KanbanColumn
      column={null}
      lanes={lanes}
      createOptions={[]}
      onCreate={vi.fn()}
      onDragEnd={vi.fn()}
      onDropOnColumn={vi.fn()}
      {...extra}
    />
  ))
  return host
}

describe('KanbanColumn lanes', () => {
  it('places lanes in registry order, not the order it was handed them', () => {
    const host = render()
    const cards = [...host.querySelectorAll('.kanban-col__cards article')].map((el) => el.className)
    expect(cards).toEqual(['sess', 'gh'])
  })

  it('renders a lane footer under that lane', () => {
    const host = render()
    expect(host.querySelector('.kanban-col__cards button')?.textContent).toBe('Show more issues')
  })

  it('counts every lane, including totals larger than the cards fetched', () => {
    expect(render().querySelector('.kanban-col__count')?.textContent).toBe('9')
  })

  it('marks empty columns with .kanban-col--empty for compact vertical layout', () => {
    expect(render().querySelector('.kanban-col--empty')).toBeNull()
    const emptyHost = render({ lanes: [{ sourceId: 'sessions', count: 0, cards: [] }] })
    expect(emptyHost.querySelector('.kanban-col--empty')).not.toBeNull()
  })

  it('renders the new-session menu outside the column overflow container', async () => {
    const host = render({
      createOptions: [{ key: 'terminal', label: 'Terminal', choice: { kind: 'terminal' }, icon: <span /> }]
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.kanban-col__new')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const menu = document.body.querySelector('.kanban-col__newmenu--portal')
    expect(menu).not.toBeNull()
    expect(menu?.parentElement).toBe(document.body)
    menu?.remove()
  })
})
