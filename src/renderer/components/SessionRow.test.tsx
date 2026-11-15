import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SessionRow } from './SessionRow'
import type { SessionRowVM } from '../lib/sessionList'

const row: SessionRowVM = {
  id: 'nt-1',
  title: 'Investigate status',
  color: '#888',
  isAgent: true,
  statusKind: 'attention',
  stateLabel: 'Waiting for your response',
  statusUpdatedAt: 1,
  unread: false,
  usesContext: false,
  projectId: 'p1',
  projectName: 'Project',
  projectColor: '#123'
}

describe('SessionRow status age', () => {
  it('renders the relative state age supplied by status-group mode', () => {
    const html = renderToStaticMarkup(
      <SessionRow
        row={row}
        stateAgeLabel="5m ago"
        onClick={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onAiName={vi.fn()}
        onContextMenu={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />
    )

    expect(html).toContain('5m ago')
    expect(html).toContain('Entered this state 5m ago')
  })
})

// Issue #291: the icon shows wherever the node is listed — the sidebar row draws it through the
// same NodeIconView as the canvas header.
describe('SessionRow icon', () => {
  const render = (icon: SessionRowVM['icon']): string =>
    renderToStaticMarkup(
      <SessionRow
        row={{ ...row, icon }}
        onClick={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onAiName={vi.fn()}
        onContextMenu={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />
    )

  it('draws a glyph icon as an svg inside the row icon slot', () => {
    const html = render({ type: 'lucide', name: 'database' })
    expect(html).toMatch(/<span class="node-icon ss-row__icon"[^>]*><svg[^>]*lucide-database/)
  })

  it('draws nothing for a glyph name the allowlist does not know', () => {
    const html = render({ type: 'lucide', name: 'skull' } as SessionRowVM['icon'])
    expect(html).not.toContain('ss-row__icon')
  })
})
