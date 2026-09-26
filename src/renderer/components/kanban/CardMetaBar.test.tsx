// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import { CardMetaBar } from './CardMetaBar'

vi.mock('./LabelPicker', () => ({ LabelPicker: () => null }))
vi.mock('../../state/presence', () => ({
  loadIdentity: () => ({ name: 'me', color: '#fff' }),
  selectFaces: () => [],
  usePresence: () => []
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const board: ProjectKanban = { columns: [], assignments: [] }

let host: HTMLDivElement
let root: Root
const onChangeLinks = vi.fn()
const onAttachLink = vi.fn()

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  onChangeLinks.mockReset()
  onAttachLink.mockReset()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    shell: { openExternal: vi.fn() }
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (props: Partial<Parameters<typeof CardMetaBar>[0]> = {}): void => {
  act(() => root.render(
    <CardMetaBar
      nodeId="n1"
      board={board}
      onChange={vi.fn()}
      links={[]}
      onChangeLinks={onChangeLinks}
      onAttachLink={onAttachLink}
      {...props}
    />
  ))
}

const groups = (): string[] =>
  [...host.querySelectorAll('.kanban-meta__label')].map((el) => el.textContent ?? '')

describe('CardMetaBar GitHub group', () => {
  it('is absent when the project has no repository', () => {
    render({ links: [{ kind: 'issue', number: 12 }] })
    expect(groups()).not.toContain('GitHub')
  })

  it('lists every link once a repository is configured', () => {
    render({
      githubRepository: 'o/r',
      links: [{ kind: 'issue', number: 12, title: 'Board' }, { kind: 'pull', number: 3 }]
    })
    expect(groups()).toContain('GitHub')
    expect([...host.querySelectorAll('.kanban-meta__ghlink a')].map((a) => a.textContent))
      .toEqual(['#12 Board', '#3'])
  })

  it('detaches through the write funnel, with the event that names it', () => {
    render({ githubRepository: 'o/r', links: [{ kind: 'pull', number: 3, title: 'Ship' }] })
    const remove = host.querySelector('.kanban-meta__ghlink .kanban-meta__clear')!
    act(() => remove.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onChangeLinks).toHaveBeenCalledWith(undefined, {
      type: 'github-detached', to: 'pull', title: '#3 Ship'
    })
  })

  it('asks the board to open the picker, anchored at the button', () => {
    render({ githubRepository: 'o/r', links: [] })
    const add = [...host.querySelectorAll('.kanban-avatar--add')].at(-1)!
    act(() => add.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onAttachLink).toHaveBeenCalledWith(expect.objectContaining({ x: expect.any(Number) }))
  })
})
