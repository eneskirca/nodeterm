// The phone's Board verbs (`projects.ensureBoard` / `projects.setCardColumn`). What these pin:
//   - Absent injection ⇒ an honest "not served" (a pre-feature host), never a silent success.
//   - A missing projectId / nodeId is refused before anything is asked of the store.
//   - `columnId: null` is a REAL value (the virtual Ungrouped column) and must be told apart from a
//     missing or garbage key — reading either as "unassign" would move a card the user didn't ask
//     to move.
//   - A store REFUSAL comes back as an ok answer whose body says "no" (`columns: null` / `moved:
//     false`), not a protocol error: the phone shows the user that nothing happened, which is the
//     whole point of the change (the direct-SSH path used to no-op in silence).
//   - The client sends nothing path-shaped; only a projectId, which the store resolves against its
//     own index.
import { describe, expect, it, vi } from 'vitest'
import {
  createHostHandlers,
  type HostFsOps,
  type HostKanbanOps,
  type HostPtyManager,
  type HostRelaySocket
} from './host-service'

const COLUMNS = [
  { id: 'kcol-1', title: 'To Do', color: '#0a84ff' },
  { id: 'kcol-2', title: 'In Progress', color: '#ffd60a' },
  { id: 'kcol-3', title: 'Done', color: '#32d74b' }
]

function makeFakes(over: Partial<HostKanbanOps> = {}, served = true) {
  const responses: Array<{ id: string; ok: boolean; body: any }> = []
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: () => true
  }
  const fs: HostFsOps = {
    listDir: async () => [],
    readText: async () => '',
    readBinary: async () => '',
    writeText: async () => true
  }
  const kanban: HostKanbanOps = {
    ensureBoard: vi.fn(async () => COLUMNS),
    setCardColumn: vi.fn(async () => true),
    ...over
  }
  const handlers = createHostHandlers(
    {} as HostPtyManager, socket, fs, () => [],
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    served ? kanban : undefined
  )
  return { handlers, responses, kanban }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('projects.ensureBoard', () => {
  it('seeds/returns the board and answers with its columns', async () => {
    const { handlers, responses, kanban } = makeFakes()
    handlers.onRpc({ id: '1', method: 'projects.ensureBoard', params: { projectId: 'p1' } })
    await flush()
    expect(kanban.ensureBoard).toHaveBeenCalledWith('p1')
    expect(responses[0]).toMatchObject({ ok: true })
    expect(responses[0].body.columns).toEqual(COLUMNS)
  })

  it('answers `columns: null` — an ANSWER, not an error — when the store refuses', async () => {
    const { handlers, responses } = makeFakes({ ensureBoard: async () => null })
    handlers.onRpc({ id: '1', method: 'projects.ensureBoard', params: { projectId: 'p1' } })
    await flush()
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { columns: null } })
  })

  it('answers `columns: null` when the store throws', async () => {
    const { handlers, responses } = makeFakes({ ensureBoard: async () => { throw new Error('boom') } })
    handlers.onRpc({ id: '1', method: 'projects.ensureBoard', params: { projectId: 'p1' } })
    await flush()
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { columns: null } })
  })

  it('refuses a missing projectId without asking the store', async () => {
    const { handlers, responses, kanban } = makeFakes()
    handlers.onRpc({ id: '1', method: 'projects.ensureBoard', params: {} })
    expect(responses[0].ok).toBe(false)
    expect(kanban.ensureBoard).not.toHaveBeenCalled()
  })

  it('is not served when the host has no kanban ops (a pre-feature desktop)', () => {
    const { handlers, responses } = makeFakes({}, false)
    handlers.onRpc({ id: '1', method: 'projects.ensureBoard', params: { projectId: 'p1' } })
    expect(responses[0].ok).toBe(false)
    expect(String(responses[0].body.message)).toContain('not served')
  })
})

describe('projects.setCardColumn', () => {
  it('moves a card to a column', async () => {
    const { handlers, responses, kanban } = makeFakes()
    handlers.onRpc({
      id: '1', method: 'projects.setCardColumn',
      params: { projectId: 'p1', nodeId: 'term-a-1', columnId: 'kcol-2' }
    })
    await flush()
    expect(kanban.setCardColumn).toHaveBeenCalledWith('p1', 'term-a-1', 'kcol-2')
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { moved: true } })
  })

  it('passes columnId null straight through (the virtual Ungrouped column)', async () => {
    const { handlers, kanban } = makeFakes()
    handlers.onRpc({
      id: '1', method: 'projects.setCardColumn',
      params: { projectId: 'p1', nodeId: 'term-a-1', columnId: null }
    })
    await flush()
    expect(kanban.setCardColumn).toHaveBeenCalledWith('p1', 'term-a-1', null)
  })

  it('refuses a MISSING or non-string columnId rather than reading it as Ungrouped', async () => {
    for (const params of [
      { projectId: 'p1', nodeId: 'term-a-1' },
      { projectId: 'p1', nodeId: 'term-a-1', columnId: 7 },
      { projectId: 'p1', nodeId: 'term-a-1', columnId: {} }
    ]) {
      const { handlers, responses, kanban } = makeFakes()
      handlers.onRpc({ id: '1', method: 'projects.setCardColumn', params })
      expect(responses[0].ok).toBe(false)
      expect(kanban.setCardColumn).not.toHaveBeenCalled()
    }
  })

  it('refuses a missing projectId / nodeId without asking the store', () => {
    for (const params of [
      { nodeId: 'term-a-1', columnId: null },
      { projectId: 'p1', columnId: null },
      { projectId: 'p1', nodeId: '', columnId: null }
    ]) {
      const { handlers, responses, kanban } = makeFakes()
      handlers.onRpc({ id: '1', method: 'projects.setCardColumn', params })
      expect(responses[0].ok).toBe(false)
      expect(kanban.setCardColumn).not.toHaveBeenCalled()
    }
  })

  it('answers `moved: false` when the store refuses or throws — never a silent success', async () => {
    for (const ops of [
      { setCardColumn: async () => false },
      { setCardColumn: async () => { throw new Error('boom') } }
    ] as Partial<HostKanbanOps>[]) {
      const { handlers, responses } = makeFakes(ops)
      handlers.onRpc({
        id: '1', method: 'projects.setCardColumn',
        params: { projectId: 'p1', nodeId: 'term-a-1', columnId: 'kcol-2' }
      })
      await flush()
      expect(responses[0]).toEqual({ id: '1', ok: true, body: { moved: false } })
    }
  })

  it('is not served when the host has no kanban ops', () => {
    const { handlers, responses } = makeFakes({}, false)
    handlers.onRpc({
      id: '1', method: 'projects.setCardColumn',
      params: { projectId: 'p1', nodeId: 'term-a-1', columnId: null }
    })
    expect(responses[0].ok).toBe(false)
    expect(String(responses[0].body.message)).toContain('not served')
  })
})
