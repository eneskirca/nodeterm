// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import type { MenuItem } from '../ContextMenu'
import { buildCardMenuItems, type CardMenuArgs } from './cardMenu'

const prompt = vi.hoisted(() => ({ answer: null as string | null }))
vi.mock('../promptDialog', () => ({ promptDialog: vi.fn(async () => prompt.answer) }))

const board: ProjectKanban = { columns: [{ id: 'c1', title: 'To Do', color: '#fff' }], assignments: [] }

function args(over: Partial<CardMenuArgs> = {}): CardMenuArgs {
  return {
    card: { id: 'n1', kind: 'terminal', title: 'Agent' },
    board,
    hidden: [],
    commit: vi.fn(),
    openCard: vi.fn(),
    openOnCanvas: vi.fn(),
    rename: vi.fn(),
    aiName: vi.fn(),
    nodeActions: () => [{ label: 'Refresh terminal', onClick: () => {} }],
    remove: vi.fn(),
    ...over
  }
}
const labels = (items: MenuItem[]): string[] =>
  items.map((it) => (it.type === 'separator' ? '—' : it.type === 'colors' ? '[colors]' : 'label' in it ? it.label : '?'))
const click = (items: MenuItem[], label: string): void => {
  const it = items.find((x) => 'label' in x && x.label === label)
  if (!it || !('onClick' in it)) throw new Error(`no row ${label}`)
  it.onClick()
}

describe('buildCardMenuItems', () => {
  it('a terminal card: open, view, move, rename, AI name, node rows, delete', () => {
    expect(labels(buildCardMenuItems(args()))).toEqual([
      'Open card',
      'Open card in chat / markdown view',
      'Open on canvas',
      'Move to',
      '—',
      'Rename…',
      'Name with AI',
      '—',
      'Refresh terminal',
      '—',
      'Delete'
    ])
  })

  it('the view row opens the card modal on its chat / markdown view, never the canvas node', () => {
    const a = args()
    click(buildCardMenuItems(a), 'Open card in chat / markdown view')
    expect(a.openCard).toHaveBeenCalledWith('n1', 'md')
  })

  it('the view row follows the markdown-view hide id', () => {
    expect(labels(buildCardMenuItems(args({ hidden: ['markdown-view'] })))).not.toContain(
      'Open card in chat / markdown view'
    )
  })

  it('Rename and Name with AI stay whatever the hide list says', () => {
    const rows = labels(buildCardMenuItems(args({ hidden: ['ai-name', 'markdown-view', 'colors'] })))
    expect(rows).toContain('Rename…')
    expect(rows).toContain('Name with AI')
  })

  it('rename asks for a name and applies only a non-empty one', async () => {
    const a = args()
    prompt.answer = '  Build  '
    click(buildCardMenuItems(a), 'Rename…')
    await vi.waitFor(() => expect(a.rename).toHaveBeenCalledWith('n1', 'Build'))
    prompt.answer = '   '
    click(buildCardMenuItems(a), 'Rename…')
    await new Promise((r) => setTimeout(r, 0))
    expect(a.rename).toHaveBeenCalledTimes(1)
  })

  it('a sticky gets no rename, no view row and no AI name', () => {
    const rows = labels(buildCardMenuItems(args({ card: { id: 'n1', kind: 'sticky', title: 'note' } })))
    expect(rows).not.toContain('Rename…')
    expect(rows).not.toContain('Open card in chat / markdown view')
    expect(rows).not.toContain('Name with AI')
  })

  it('Delete goes through the board remove (its confirm), with no node rows supplied too', () => {
    const a = args({ nodeActions: undefined, aiName: undefined })
    const items = buildCardMenuItems(a)
    expect(labels(items).at(-1)).toBe('Delete')
    click(items, 'Delete')
    expect(a.remove).toHaveBeenCalledWith('n1')
  })
})
