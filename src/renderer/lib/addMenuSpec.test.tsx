import { describe, it, expect } from 'vitest'
import type { MenuItem } from '../components/ContextMenu'
import {
  ADD_GROUP_LABEL,
  ADD_ITEM_GROUP,
  AGENT_GROUP_LABEL,
  CONTENT_ADD_ITEMS,
  buildGroupedAddMenu,
  contentAddItemsToMenuItems,
  contentAddItemsToDockRows,
  FILES_NO_CWD_HINT,
  NEW_FILE_NO_CWD_HINT,
  WORKTREE_NO_CWD_HINT,
  WORKTREE_SSH_HINT,
  type AddItem,
  type AddHandlers,
  type AgentAddEntry
} from './addMenuSpec'

/** The SSH-gated row's label, spelled once so the assertions below read cleanly. */
const SSH_GATED_ROW = 'New worktree…'

const noop = () => {}
const handlers = (overrides: Partial<AddHandlers> = {}): AddHandlers => ({
  terminal: noop,
  remote: noop,
  browser: noop,
  web: noop,
  sticky: noop,
  files: noop,
  dino: noop,
  trigger: noop,
  openFile: noop,
  newFile: noop,
  spawnTeam: noop,
  worktree: noop,
  ...overrides
})

const allKinds: AddItem['kind'][] = [
  'terminal',
  'remote',
  'browser',
  'web',
  'sticky',
  'files',
  'dino',
  'trigger',
  'open-file',
  'new-file',
  'spawn-team',
  'worktree'
]

describe('CONTENT_ADD_ITEMS', () => {
  it('lists every content kind in the canonical order', () => {
    expect(CONTENT_ADD_ITEMS.map((i) => i.kind)).toEqual(allKinds)
  })
})

describe('contentAddItemsToMenuItems', () => {
  it('emits a MenuItem for every kind that should show (cwd + non-ssh)', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: true,
      isSshProject: false
    })
    const labels = items.map((i) => ('label' in i ? i.label : null))
    // "New file…" shows because hasCwd; worktree is enabled (not ssh).
    expect(labels).toEqual([
      'New terminal',
      'New remote…',
      'New browser',
      'New web view…',
      'New sticky note',
      'New file manager',
      'New dino game',
      'New trigger…',
      'Open file…',
      'New file…',
      'Spawn a team…',
      'New worktree…'
    ])
  })

  // Follows the rule main established for "New file…": a folder-shaped row on a cwd-less canvas
  // degrades EXPLICITLY. This test previously asserted the row was HIDDEN, which is the behaviour
  // that rule reversed.
  it('DISABLES "New file manager" with its reason when the project has no cwd — never hides it', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: false,
      isSshProject: false
    })
    const row = items.find((i) => 'label' in i && i.label === 'New file manager')
    expect(row).toBeDefined()
    expect(row && 'disabled' in row && row.disabled).toBe(true)
    expect(row && 'hint' in row && row.hint).toBe(FILES_NO_CWD_HINT)
  })

  // A cwd-less project is a supported, persisted canvas — the folder-shaped rows must degrade
  // EXPLICITLY (the SSH worktree row's rule), not vanish. Hiding them left the user with no row and
  // no reason, and the fix ("Set folder…") one menu away with nothing pointing at it.
  it('DISABLES "New file…" with its reason when the project has no cwd — never hides it', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: false,
      isSshProject: false
    })
    const newFile = items.find((i) => 'label' in i && i.label === 'New file…')
    expect(newFile).toBeDefined()
    expect(newFile && 'disabled' in newFile && newFile.disabled).toBe(true)
    expect(newFile && 'hint' in newFile && newFile.hint).toBe(NEW_FILE_NO_CWD_HINT)
  })

  it('disables "New worktree…" with its own reason on a cwd-less project', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: false,
      isSshProject: false
    })
    const worktree = items.find((i) => 'label' in i && i.label === 'New worktree…')
    expect(worktree && 'disabled' in worktree && worktree.disabled).toBe(true)
    expect(worktree && 'hint' in worktree && worktree.hint).toBe(WORKTREE_NO_CWD_HINT)
  })

  it('keeps the SSH reason on an SSH project that also has no cwd — the stronger one wins', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: false,
      isSshProject: true
    })
    const worktree = items.find((i) => 'label' in i && i.label === 'New worktree…')
    expect(worktree && 'hint' in worktree && worktree.hint).toBe(WORKTREE_SSH_HINT)
  })

  it('disables "New worktree…" on an SSH project and surfaces the hint', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: true,
      isSshProject: true
    })
    const worktree = items.find((i) => 'label' in i && i.label === 'New worktree…')
    expect(worktree).toBeDefined()
    expect(worktree && 'disabled' in worktree && worktree.disabled).toBe(true)
    expect(worktree && 'hint' in worktree && worktree.hint).toBeTruthy()
  })

  it('wires each handler to its item', () => {
    const calls: string[] = []
    const h = handlers({
      terminal: () => calls.push('terminal'),
      browser: () => calls.push('browser'),
      web: () => calls.push('web'),
      sticky: () => calls.push('sticky'),
      dino: () => calls.push('dino'),
      spawnTeam: () => calls.push('spawnTeam'),
      worktree: () => calls.push('worktree')
    })
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, h, {
      hasCwd: true,
      isSshProject: false
    })
    for (const item of items) {
      if ('onClick' in item) item.onClick()
    }
    expect(calls.sort()).toEqual(['browser', 'dino', 'spawnTeam', 'sticky', 'terminal', 'web', 'worktree'])
  })
})

describe('contentAddItemsToDockRows', () => {
  it('omits the Dock-local terminal + remote rows (the Dock renders those itself) and keeps the rest', () => {
    const rows = contentAddItemsToDockRows(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: true,
      isSshProject: false
    })
    // NO 'terminal' and NO 'remote': the Dock draws its own Terminal button and its own
    // "New Remote Connection" flow. Emitting a terminal row here duplicated the Terminal entry.
    expect(rows.map((r) => r.kind)).toEqual([
      'browser',
      'web',
      'sticky',
      'files',
      'dino',
      'trigger',
      'open-file',
      'new-file',
      'spawn-team',
      'worktree'
    ])
    expect(rows.some((r) => r.kind === 'terminal')).toBe(false)
    expect(rows.some((r) => r.kind === 'remote')).toBe(false)
  })

  it('DISABLES "files" with its reason when there is no cwd — the Dock keeps the row too', () => {
    const rows = contentAddItemsToDockRows(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: false,
      isSshProject: false
    })
    const row = rows.find((r) => r.kind === 'files')
    expect(row).toBeDefined()
    expect(row?.disabled).toBe(true)
    expect(row?.hint).toBe(FILES_NO_CWD_HINT)
  })

  it('DISABLES "new-file" with its reason when there is no cwd — the Dock keeps the row too', () => {
    const rows = contentAddItemsToDockRows(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: false,
      isSshProject: false
    })
    const newFile = rows.find((r) => r.kind === 'new-file')
    expect(newFile).toBeDefined()
    expect(newFile?.disabled).toBe(true)
    expect(newFile?.hint).toBe(NEW_FILE_NO_CWD_HINT)
    expect(rows.find((r) => r.kind === 'worktree')?.hint).toBe(WORKTREE_NO_CWD_HINT)
  })

  // The per-surface decision, pinned so it is a decision rather than an oversight: the Dock's
  // rows stay FLAT. Its popup is opened deliberately, it already omits terminal + remote (10 rows,
  // not 18), and its agent flyouts are bespoke JSX — grouping it would mean a second submenu
  // implementation with its own geometry, for crowding nobody reported.
  it('stays FLAT — the Dock adapter emits rows, never groups', () => {
    const rows = contentAddItemsToDockRows(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: true,
      isSshProject: false
    })
    expect(rows.every((r) => typeof r.label === 'string' && 'onClick' in r)).toBe(true)
    expect(rows.map((r) => r.kind)).not.toContain(undefined)
  })
})

// ─── Grouping ────────────────────────────────────────────────────────────────────────────────
// The pane right-click and the sidebar "+" render the GROUPED tree; the Dock deliberately does
// not (see the per-surface note in the module doc and the Dock case just above).

const agent = (agentId: string, label = `New ${agentId}`): AgentAddEntry => ({
  agentId,
  item: { label, onClick: noop }
})
/** An agent row that already owns an account picker — Claude's and Codex's real shape. */
const agentWithAccounts = (agentId: string, accounts: string[]): AgentAddEntry => ({
  agentId,
  item: {
    type: 'submenu',
    label: `New ${agentId}`,
    children: accounts.map((a) => ({ label: a, onClick: noop }))
  }
})

/** Every label the user can actually REACH, at either level. */
function reachableLabels(items: readonly MenuItem[]): string[] {
  const out: string[] = []
  for (const item of items) {
    if (item.type === 'submenu') {
      out.push(item.label)
      for (const child of item.children) if ('label' in child) out.push(child.label)
    } else if ('label' in item) out.push(item.label)
  }
  return out
}

const topLabels = (items: readonly MenuItem[]): string[] =>
  items.map((i) => ('label' in i ? i.label : `[${i.type}]`))

describe('ADD_ITEM_GROUP', () => {
  // The compile-time half is the total Record; this is the runtime half, so a kind added with a
  // cast or a loosened type still cannot slip through unrouted.
  it('routes every content kind', () => {
    for (const kind of allKinds) expect(ADD_ITEM_GROUP[kind]).toBeTruthy()
    expect(Object.keys(ADD_ITEM_GROUP).sort()).toEqual([...allKinds].sort())
  })
})

describe('buildGroupedAddMenu', () => {
  const ctx = { hasCwd: true, isSshProject: false }
  const agents = [
    agentWithAccounts('claude', ['System account', 'work@example.com']),
    agent('codex', 'New Codex'),
    agent('gemini', 'New Gemini'),
    agent('grok', 'New Grok'),
    agent('custom:1', 'New My Agent')
  ]

  it('shows terminal + remote, the account-capable agents, then four submenus — in that order', () => {
    const items = buildGroupedAddMenu(CONTENT_ADD_ITEMS, handlers(), ctx, agents)
    expect(topLabels(items)).toEqual([
      'New terminal',
      'New remote…',
      'New claude',
      'New Codex',
      AGENT_GROUP_LABEL,
      ADD_GROUP_LABEL.view,
      ADD_GROUP_LABEL.files,
      ADD_GROUP_LABEL.orchestrate
    ])
  })

  it('puts each content kind in its declared group', () => {
    const items = buildGroupedAddMenu(CONTENT_ADD_ITEMS, handlers(), ctx, agents)
    const children = (label: string): string[] => {
      const sub = items.find((i) => i.type === 'submenu' && i.label === label)
      return sub && sub.type === 'submenu'
        ? sub.children.map((c) => ('label' in c ? c.label : ''))
        : []
    }
    expect(children(ADD_GROUP_LABEL.view)).toEqual([
      'New browser',
      'New web view…',
      'New sticky note',
      'New file manager',
      'New dino game'
    ])
    expect(children(ADD_GROUP_LABEL.files)).toEqual(['Open file…', 'New file…'])
    expect(children(ADD_GROUP_LABEL.orchestrate)).toEqual([
      'New trigger…',
      'Spawn a team…',
      SSH_GATED_ROW
    ])
    expect(children(AGENT_GROUP_LABEL)).toEqual(['New Gemini', 'New Grok', 'New My Agent'])
  })

  // Grouping must be a REARRANGEMENT, never a filter: the ⌘K palette makes this menu
  // non-exhaustive by choice, but a row that silently vanished from it would be a feature nobody
  // can find.
  it('loses nothing — every flat row is still reachable', () => {
    const flat = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), ctx)
    const grouped = buildGroupedAddMenu(CONTENT_ADD_ITEMS, handlers(), ctx, agents)
    const reachable = new Set(reachableLabels(grouped))
    for (const row of flat) if ('label' in row) expect(reachable).toContain(row.label)
    for (const a of agents) if ('label' in a.item) expect(reachable).toContain(a.item.label)
  })

  // The shape keeps account pickers one hover away: ContextMenu renders any depth now, so this is a
  // design choice (see the grouping section of addMenuSpec), not a renderer limit.
  it('never emits a third level', () => {
    const items = buildGroupedAddMenu(CONTENT_ADD_ITEMS, handlers(), ctx, agents)
    for (const item of items) {
      if (item.type !== 'submenu') continue
      for (const child of item.children) expect(child.type).not.toBe('submenu')
    }
  })

  it('keeps an agent row that OWNS an account picker at the first level', () => {
    // Codex only grows a submenu once the user has managed Codex accounts. Nesting it then would
    // delete the picker silently — so the row must stay at the top in BOTH shapes.
    const withCodexAccounts = [
      agentWithAccounts('claude', ['System account']),
      agentWithAccounts('codex', ['System account', 'ci@example.com']),
      agent('gemini', 'New Gemini')
    ]
    const items = buildGroupedAddMenu(CONTENT_ADD_ITEMS, handlers(), ctx, withCodexAccounts)
    const codex = items.find((i) => 'label' in i && i.label === 'New codex')
    expect(codex).toBeDefined()
    expect(codex?.type).toBe('submenu')
    expect(reachableLabels(items)).toContain('ci@example.com')
  })

  // The half of `isPinnedAgentEntry` that has NO live example yet, and is therefore the half a
  // refactor deletes as dead code. Today the only agents that grow a picker (claude, codex) are
  // also the account-capable ones, so the id rule alone would look sufficient — it is not: the
  // refusal is about the ROW's shape, and an agent that grows a submenu for any other reason
  // would be nested and rendered as nothing. Written as a hypothetical on purpose.
  it('keeps ANY submenu row at the first level, account-capable or not', () => {
    const items = buildGroupedAddMenu(CONTENT_ADD_ITEMS, handlers(), ctx, [
      agent('claude', 'New Claude Code'),
      // Not in ACCOUNT_CAPABLE_AGENT_IDS, but its row is a submenu.
      agentWithAccounts('gemini', ['profile-a', 'profile-b'])
    ])
    expect(topLabels(items)).toContain('New gemini')
    expect(reachableLabels(items)).toContain('profile-b')
    const agentSub = items.find((i) => i.type === 'submenu' && i.label === AGENT_GROUP_LABEL)
    expect(agentSub).toBeUndefined()
  })

  it('pins an account-capable agent even while it has NO accounts, so the shape is stable', () => {
    // Otherwise the Codex row would jump between the top level and the submenu as accounts come
    // and go — a menu that rearranges itself is a menu nobody can learn.
    const flatCodex = buildGroupedAddMenu(CONTENT_ADD_ITEMS, handlers(), ctx, [
      agent('claude', 'New Claude Code'),
      agent('codex', 'New Codex'),
      agent('gemini', 'New Gemini')
    ])
    expect(topLabels(flatCodex).slice(0, 4)).toEqual([
      'New terminal',
      'New remote…',
      'New Claude Code',
      'New Codex'
    ])
  })

  it('emits NO agent submenu when every agent is pinned — an empty flyout is a dead target', () => {
    const items = buildGroupedAddMenu(CONTENT_ADD_ITEMS, handlers(), ctx, [
      agent('claude'),
      agent('codex')
    ])
    expect(topLabels(items)).not.toContain(AGENT_GROUP_LABEL)
  })

  // The explicit-degrade rule (#621) has to survive the move into a flyout: a row that is off for
  // a reason the user cannot see teaches nothing.
  it('carries the disabled state AND its reason into the submenu', () => {
    const ssh = buildGroupedAddMenu(
      CONTENT_ADD_ITEMS,
      handlers(),
      { hasCwd: true, isSshProject: true },
      agents
    )
    const orchestrate = ssh.find(
      (i) => i.type === 'submenu' && i.label === ADD_GROUP_LABEL.orchestrate
    )
    const row =
      orchestrate?.type === 'submenu'
        ? orchestrate.children.find((c) => 'label' in c && c.label === SSH_GATED_ROW)
        : undefined
    expect(row && 'disabled' in row && row.disabled).toBe(true)
    expect(row && 'hint' in row && row.hint).toBe(WORKTREE_SSH_HINT)

    const noCwd = buildGroupedAddMenu(
      CONTENT_ADD_ITEMS,
      handlers(),
      { hasCwd: false, isSshProject: false },
      agents
    )
    const files = noCwd.find((i) => i.type === 'submenu' && i.label === ADD_GROUP_LABEL.files)
    const newFile =
      files?.type === 'submenu'
        ? files.children.find((c) => 'label' in c && c.label === 'New file…')
        : undefined
    expect(newFile && 'hint' in newFile && newFile.hint).toBe(NEW_FILE_NO_CWD_HINT)
  })

  it('wires every handler through the grouped tree', () => {
    const calls: string[] = []
    const h = handlers({
      terminal: () => calls.push('terminal'),
      remote: () => calls.push('remote'),
      browser: () => calls.push('browser'),
      web: () => calls.push('web'),
      sticky: () => calls.push('sticky'),
      files: () => calls.push('files'),
      dino: () => calls.push('dino'),
      trigger: () => calls.push('trigger'),
      openFile: () => calls.push('openFile'),
      newFile: () => calls.push('newFile'),
      spawnTeam: () => calls.push('spawnTeam'),
      worktree: () => calls.push('scopedCheckout')
    })
    const items = buildGroupedAddMenu(CONTENT_ADD_ITEMS, h, ctx, agents)
    for (const item of items) {
      if (item.type === 'submenu') {
        for (const child of item.children) if ('onClick' in child) child.onClick()
      } else if ('onClick' in item) item.onClick()
    }
    // Every content handler is reachable — nothing was orphaned by the move into a flyout.
    expect(calls.sort()).toEqual([
      'browser',
      'dino',
      'files',
      'newFile',
      'openFile',
      'remote',
      'scopedCheckout',
      'spawnTeam',
      'sticky',
      'terminal',
      'trigger',
      'web'
    ])
  })
})
