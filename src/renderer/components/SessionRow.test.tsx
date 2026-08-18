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
  statusRestored: false,
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

  it('labels a restored age as last known', () => {
    const html = renderToStaticMarkup(
      <SessionRow
        row={{ ...row, statusRestored: true }}
        stateAgeLabel="1d ago"
        onClick={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onAiName={vi.fn()}
        onContextMenu={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />
    )

    expect(html).toContain('last known · 1d ago')
    expect(html).toContain('Last known state entered 1d ago')
  })
})
