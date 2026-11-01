import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const GLOBAL_KANBAN_SRC = fs.readFileSync(path.join(__dirname, 'GlobalKanbanView.tsx'), 'utf8')

describe('global kanban swimlane collapse wiring', () => {
  it('toggles the lane body from its header', () => {
    expect(GLOBAL_KANBAN_SRC).toContain('const [collapsed, setCollapsed] = useState(false)')
    expect(GLOBAL_KANBAN_SRC).toContain('onClick={toggleCollapsed}')
    expect(GLOBAL_KANBAN_SRC).toContain('aria-expanded={!collapsed}')
    expect(GLOBAL_KANBAN_SRC).toContain('setCollapsed((value) => !value)')
    expect(GLOBAL_KANBAN_SRC).toContain('{!collapsed && (')
  })
})

describe('global kanban card read state', () => {
  it('clears the unread dot when a card opens, like the per-project board', () => {
    // On the store of the card's own lane project (bug D): a team lane reads its relay session's.
    expect(GLOBAL_KANBAN_SRC).toContain(
      "import { agentStatusForProject, sessionForProject, useSessionRegistryVersion } from '../../session/session'"
    )
    expect(GLOBAL_KANBAN_SRC).toContain(
      'if (modalNodeId) agentStatusForProject(modalProjectId).store.getState().clearUnread(modalNodeId)'
    )
  })
})
