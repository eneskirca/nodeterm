// @vitest-environment jsdom
// jsdom so `pinNeutralMachineNoun` can pin the machine noun the Stop-all copy names.
import { describe, it, expect, vi } from 'vitest'
import {
  liveLinkCommands,
  liveLinkMenuItemsFor,
  liveLinkMenuRow,
  liveLinkNodeFor,
  liveLinkPrepare,
  liveLinkUnavailable,
  openLiveLink,
  stopAllConfirm,
  stopAllLiveLinks,
  stopLiveLinks,
  type LiveLinkAvailabilityFacts
} from './liveLinkEntry'
import { PRO_GATE_FEATURE, SAVE_FIRST_MESSAGE, STOP_FAILED_MESSAGE } from './liveLink'
import { pinNeutralMachineNoun } from './testMachineNoun'

pinNeutralMachineNoun()

const R43 = 'Live links need a Pro license on this server — not available in the Server Edition yet'
const RELAY = 'Live links are created on the machine that runs this terminal.'
const LIMIT = 'Stop a live link first — 5 can be active at once.'

const facts = (over: Partial<LiveLinkAvailabilityFacts> = {}): LiveLinkAvailabilityFacts => ({
  serverEdition: false,
  source: 'local',
  activeLinks: 0,
  ...over
})
const target = { nodeId: 'n1', title: 'build', projectId: 'p1' }

describe('liveLinkUnavailable', () => {
  it('reads the surface facts in the H1 order', () => {
    expect(liveLinkUnavailable(facts({ serverEdition: true, source: 'relay', activeLinks: 9 }))).toBe(R43)
    expect(liveLinkUnavailable(facts({ source: 'relay', activeLinks: 9 }))).toBe(RELAY)
    expect(liveLinkUnavailable(facts({ activeLinks: 5 }))).toBe(LIMIT)
    expect(liveLinkUnavailable(facts({ activeLinks: 4 }))).toBeNull()
  })
})

describe('openLiveLink: the availability rule runs BEFORE the Pro gate (H1, H4)', () => {
  const run = (f: LiveLinkAvailabilityFacts) => {
    const requirePro = vi.fn((_feature: string, go: () => void) => go())
    const show = vi.fn()
    const notice = vi.fn()
    openLiveLink({ facts: () => f, requirePro, show, notice }, target)
    return { requirePro, show, notice }
  }

  it('a Server Edition tab never reaches the Pro gate — it is told why instead', () => {
    const r = run(facts({ serverEdition: true }))
    expect(r.requirePro).not.toHaveBeenCalled()
    expect(r.show).not.toHaveBeenCalled()
    expect(r.notice).toHaveBeenCalledWith(R43)
  })

  it('a relay tab never reaches the Pro gate', () => {
    const r = run(facts({ source: 'relay' }))
    expect(r.requirePro).not.toHaveBeenCalled()
    expect(r.notice).toHaveBeenCalledWith(RELAY)
  })

  it('five active links: the limit sentence, no gate', () => {
    const r = run(facts({ activeLinks: 5 }))
    expect(r.requirePro).not.toHaveBeenCalled()
    expect(r.notice).toHaveBeenCalledWith(LIMIT)
  })

  it('available: the Pro gate decides, with the ruled feature string, and opens the dialog for the target', () => {
    const r = run(facts())
    expect(r.requirePro).toHaveBeenCalledTimes(1)
    expect(r.requirePro.mock.calls[0][0]).toBe(PRO_GATE_FEATURE)
    expect(r.show).toHaveBeenCalledWith(target)
    expect(r.notice).not.toHaveBeenCalled()
  })

  it('asks the facts for the TARGET project (a relay project is not judged by the active one)', () => {
    const f = vi.fn(() => facts())
    openLiveLink({ facts: f, requirePro: vi.fn(), show: vi.fn(), notice: vi.fn() }, { ...target, projectId: 'relayed' })
    expect(f).toHaveBeenCalledWith('relayed')
  })
})

describe('liveLinkMenuRow', () => {
  const base = {
    node: { id: 'n1', kind: 'terminal', title: 'build' },
    projectId: 'p1',
    hidden: [] as string[],
    facts: facts(),
    icon: null,
    open: vi.fn()
  }

  it('a terminal node gets one enabled row that opens for this node and project', () => {
    const open = vi.fn()
    const rows = liveLinkMenuRow({ ...base, open })
    expect(rows).toHaveLength(1)
    const row = rows[0] as { label: string; disabled?: boolean; onClick: () => void }
    expect(row.label).toBe('Share live link…')
    expect(row.disabled).toBeFalsy()
    row.onClick()
    expect(open).toHaveBeenCalledWith({ nodeId: 'n1', title: 'build', projectId: 'p1' })
  })

  it('is disabled WITH its reason, never hidden, where it cannot work', () => {
    for (const [f, why] of [
      [facts({ serverEdition: true }), R43],
      [facts({ source: 'relay' }), RELAY],
      [facts({ activeLinks: 5 }), LIMIT]
    ] as const) {
      const rows = liveLinkMenuRow({ ...base, facts: f })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ disabled: true, hint: why })
    }
  })

  it('no row for a hidden id, a missing node or a non-terminal node', () => {
    expect(liveLinkMenuRow({ ...base, hidden: ['live-link'] })).toEqual([])
    expect(liveLinkMenuRow({ ...base, node: null })).toEqual([])
    expect(liveLinkMenuRow({ ...base, node: { id: 'n1', kind: 'sticky', title: 'x' } })).toEqual([])
  })

  it('an untitled node is offered as "Terminal"', () => {
    const open = vi.fn()
    const row = liveLinkMenuRow({ ...base, node: { id: 'n1', kind: 'terminal', title: '  ' }, open })[0] as { onClick: () => void }
    row.onClick()
    expect(open).toHaveBeenCalledWith({ nodeId: 'n1', title: 'Terminal', projectId: 'p1' })
  })
})

describe('liveLinkNodeFor (R49)', () => {
  const live = [{ id: 'n1', type: 'terminal', data: { title: 'live title' } }]
  const stored = [
    { id: 'n1', kind: 'terminal', title: 'stored title' },
    { id: 's1', kind: 'sticky', title: 'note' }
  ]

  it('the active project is read from the live canvas', () => {
    expect(liveLinkNodeFor({ nodeId: 'n1', projectId: 'a', activeProjectId: 'a', live, stored })).toEqual({
      id: 'n1',
      kind: 'terminal',
      title: 'live title'
    })
  })

  it('any other project (a non-active sidebar row, an Omni lane) from its stored copy', () => {
    expect(liveLinkNodeFor({ nodeId: 'n1', projectId: 'b', activeProjectId: 'a', live: [], stored })).toEqual({
      id: 'n1',
      kind: 'terminal',
      title: 'stored title'
    })
    // …so the row it feeds is offered there, for THAT project.
    const open = vi.fn()
    const row = liveLinkMenuRow({
      node: liveLinkNodeFor({ nodeId: 'n1', projectId: 'b', activeProjectId: 'a', live: [], stored }),
      projectId: 'b',
      hidden: [],
      facts: facts(),
      icon: null,
      open
    })[0] as { onClick: () => void }
    row.onClick()
    expect(open).toHaveBeenCalledWith({ nodeId: 'n1', title: 'stored title', projectId: 'b' })
  })

  it('a node that is not there, or a hand-mangled stored list, is no node', () => {
    expect(liveLinkNodeFor({ nodeId: 'zz', projectId: 'b', activeProjectId: 'a', live, stored })).toBeNull()
    expect(liveLinkNodeFor({ nodeId: 'n1', projectId: 'b', activeProjectId: 'a', live, stored: undefined })).toBeNull()
    expect(
      liveLinkNodeFor({ nodeId: 'n1', projectId: 'b', activeProjectId: 'a', live, stored: 5 as never })
    ).toBeNull()
  })
})

// D2/M1: the composition Canvas calls for every surface. With a LOCAL tab on screen, a non-active
// RELAY project's sidebar row (or Omni lane card) must be judged by THAT project's session.
describe('liveLinkMenuItemsFor (D2/M1)', () => {
  const stored: Record<string, { id: string; kind: string; title: string }[]> = {
    'p-relay': [{ id: 'n9', kind: 'terminal', title: 'theirs' }],
    'p-local': [{ id: 'n1', kind: 'terminal', title: 'ours' }]
  }
  const factsOf = (projectId: string): LiveLinkAvailabilityFacts =>
    facts({ source: projectId === 'p-relay' ? 'relay' : 'local' })
  const compose = (over: Partial<Parameters<typeof liveLinkMenuItemsFor>[0]>) =>
    liveLinkMenuItemsFor({
      nodeId: 'n9',
      projectId: 'p-relay',
      activeProjectId: 'p-local',
      live: [{ id: 'n1', type: 'terminal', data: { title: 'ours' } }],
      stored: (pid) => stored[pid],
      hidden: [],
      facts: factsOf,
      icon: null,
      open: vi.fn(),
      ...over
    })

  it("a non-active relay project's node is judged by ITS session, not the active local tab's", () => {
    const open = vi.fn()
    const rows = compose({ open })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ disabled: true, hint: RELAY })
    ;(rows[0] as { onClick: () => void }).onClick()
    expect(open).toHaveBeenCalledWith({ nodeId: 'n9', title: 'theirs', projectId: 'p-relay' })
  })

  it('no project given: the active one, read from the live canvas', () => {
    const open = vi.fn()
    const rows = compose({ nodeId: 'n1', projectId: undefined, open })
    expect(rows[0]).toMatchObject({ disabled: false })
    ;(rows[0] as { onClick: () => void }).onClick()
    expect(open).toHaveBeenCalledWith({ nodeId: 'n1', title: 'ours', projectId: 'p-local' })
    expect(compose({ projectId: undefined, activeProjectId: null })).toEqual([])
  })
})

describe('liveLinkPrepare (R47)', () => {
  it('nothing to save: no save, no refusal', async () => {
    const save = vi.fn(async () => true)
    expect(await liveLinkPrepare({ needed: false, conflict: true, save })).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('a dirty canvas is saved first', async () => {
    const save = vi.fn(async () => true)
    expect(await liveLinkPrepare({ needed: true, conflict: false, save })).toBeNull()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('never saves over an unresolved conflict', async () => {
    const save = vi.fn(async () => true)
    expect(await liveLinkPrepare({ needed: true, conflict: true, save })).toBe(SAVE_FIRST_MESSAGE)
    expect(save).not.toHaveBeenCalled()
  })

  it('a failed or throwing save refuses with the ruled sentence', async () => {
    expect(await liveLinkPrepare({ needed: true, conflict: false, save: async () => false })).toBe(SAVE_FIRST_MESSAGE)
    expect(
      await liveLinkPrepare({
        needed: true,
        conflict: false,
        save: async () => {
          throw new Error('disk')
        }
      })
    ).toBe(SAVE_FIRST_MESSAGE)
  })
})

describe('Stop all (R48)', () => {
  it('the confirm names other machines, is danger-styled, and stops only on confirm', () => {
    const close = vi.fn()
    const stop = vi.fn()
    const spec = stopAllConfirm({ close, stop })
    // R62: the timing is part of the promise — at once HERE, within minutes elsewhere.
    expect(spec.message).toBe(
      'Stop every live link on your license? This also ends links shared from other computers. Viewers on this computer are disconnected at once; links on other computers stop within a few minutes.'
    )
    expect(spec.confirmLabel).toBe('Stop all')
    expect(spec.danger).toBe(true)
    expect(stop).not.toHaveBeenCalled()
    spec.onConfirm()
    expect(close).toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('a rejected stop is reported, never swallowed (H23)', async () => {
    const onError = vi.fn()
    expect(await stopLiveLinks(() => Promise.reject(new Error('socket down')), onError)).toBe(false)
    expect(onError).toHaveBeenCalledWith(STOP_FAILED_MESSAGE)
    const ok = vi.fn()
    expect(await stopLiveLinks(() => Promise.resolve(), ok)).toBe(true)
    expect(ok).not.toHaveBeenCalled()
  })
})

// R62: what Stop all reached is always said. This machine's links are stopped whatever the answer;
// the outcome is about the server revoke, the only thing that reaches the OTHER machines' links.
describe('stopAllLiveLinks (R62)', () => {
  it('a success is reported too (with nothing listed here, nothing else on screen changes)', async () => {
    expect(await stopAllLiveLinks(async () => 'stopped')).toEqual({
      ok: true,
      text: 'Stopped every live link on your license. Links on other computers end within a few minutes.'
    })
  })
  it('no entitlement: this machine stopped, the others could not be — and why', async () => {
    const r = await stopAllLiveLinks(async () => 'no-entitlement')
    expect(r.ok).toBe(false)
    expect(r.text).toBe(
      "Stopped the live links on this computer. Links shared from other computers can't be stopped from here: this computer has no Pro license. Activate Pro here, or stop them on the machine that shared them."
    )
  })
  it('a failed server call is NOT a success: the others may still be running', async () => {
    const r = await stopAllLiveLinks(async () => 'failed')
    expect(r).toEqual({
      ok: false,
      text: `${STOP_FAILED_MESSAGE} Links on this computer are stopped; links shared from other computers may still be running.`
    })
    // An answer this build does not know (an older core) reads the same way, never as a success.
    expect((await stopAllLiveLinks(async () => undefined as never)).ok).toBe(false)
  })
  it('a rejection (the Server Edition socket was down) says nothing reached nodeterm', async () => {
    expect(await stopAllLiveLinks(() => Promise.reject(new Error('socket')))).toEqual({ ok: false, text: STOP_FAILED_MESSAGE })
  })
  it('unsupported says so', async () => {
    expect((await stopAllLiveLinks(async () => 'unsupported')).ok).toBe(false)
  })
})

describe('liveLinkCommands (palette)', () => {
  const base = { entitled: false, serverEdition: false, icon: null }
  it('Manage always; Stop all with links OR a Pro license (R62), labelled for every machine, and it CONFIRMS', () => {
    const manage = vi.fn()
    const confirmStopAll = vi.fn()
    const none = liveLinkCommands({ ...base, activeLinks: 0, manage, confirmStopAll })
    expect(none.map((c) => c.id)).toEqual(['live-links-manage'])
    // Pro, and nothing listed HERE: links shared from another machine are invisible on this one,
    // and Stop all is the only control that reaches them.
    const entitled = liveLinkCommands({ ...base, entitled: true, activeLinks: 0, manage, confirmStopAll })
    expect(entitled.map((c) => c.id)).toEqual(['live-links-manage', 'live-links-stop-all'])
    // Never in the Server Edition (R43): no license layer, nothing to stop.
    const server = liveLinkCommands({ ...base, serverEdition: true, entitled: true, activeLinks: 3, manage, confirmStopAll })
    expect(server.map((c) => c.id)).toEqual(['live-links-manage'])
    const some = liveLinkCommands({ ...base, activeLinks: 2, manage, confirmStopAll })
    expect(some.map((c) => c.id)).toEqual(['live-links-manage', 'live-links-stop-all'])
    expect(some[0].label).toBe('Manage live links')
    expect(some[1].label).toBe('Stop all live links (every machine on this license)')
    some[0].run()
    expect(manage).toHaveBeenCalledTimes(1)
    some[1].run()
    expect(confirmStopAll).toHaveBeenCalledTimes(1)
  })
})
