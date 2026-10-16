// Every surface that offers actions on a canvas node takes its rows from ONE builder,
// lib/nodeActionItems: the canvas node menu, the sessions-sidebar row menu, and the kanban card
// menus (per-project board and Omni lanes, through components/kanban/cardMenu.tsx). A second copy
// of these rows is how the board fell behind the canvas in the first place; this fails the moment
// one is written. Canvas.tsx cannot be mounted in a test, so the wiring is pinned at source level.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(RENDERER, rel), 'utf8').replace(/\r\n/g, '\n')

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Every `import … from '…'` statement of a file: the module specifiers and the bound names. */
function imports(src: string): { specifiers: string[]; names: string[] } {
  const specifiers: string[] = []
  const names: string[] = []
  for (const m of src.matchAll(/^import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    specifiers.push(m[3])
    for (const part of m[2].replace(/[{}*]/g, ' ').split(/[\s,]+/)) {
      if (part && part !== 'type' && part !== 'as') names.push(part)
    }
  }
  return { specifiers, names }
}

/** The source of one `const name = useCallback(…)` up to the next `const` at the same depth. */
function callback(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = useCallback(`)
  expect(at, name).toBeGreaterThan(-1)
  const end = src.indexOf('\n  const ', at + 10)
  return src.slice(at, end === -1 ? undefined : end)
}

describe('node actions: one builder for every surface', () => {
  const canvas = read('canvas/Canvas.tsx')

  it('the canvas node menu is the builder', () => {
    expect(callback(canvas, 'selectionItems')).toContain('buildNodeActionItems(ids, at, liveNodeActionCtx(), filter)')
  })

  it('the sessions-sidebar row menu is the builder minus Delete', () => {
    const row = canvas.slice(canvas.indexOf('const onRowContextMenu = useCallback('))
    const body = row.slice(0, row.indexOf('\n  // Stream live subagent'))
    expect(body).toContain("...selectionItems([id], undefined, { omit: ['delete'] }),")
    expect(body).not.toContain("it.label === 'Delete'")
  })

  it('both boards build their card menu with the shared card menu, fed by the builder', () => {
    expect(read('components/kanban/KanbanView.tsx')).toContain('buildCardMenuItems({')
    expect(read('components/kanban/GlobalKanbanView.tsx')).toContain('buildCardMenuItems({')
    expect(read('components/kanban/cardMenu.tsx')).toContain('...(a.nodeActions?.(card.id) ?? []),')
    expect(callback(canvas, 'boardNodeActionItems')).toContain('{ allow: BOARD_NODE_ACTION_IDS }')
  })

  it('the card modal renders only the rows its sessionActions prop hands it', () => {
    const modal = imports(read('components/kanban/CardModal.tsx'))
    for (const name of ['buildNodeActionItems', 'sessionRows', 'restartEligibility']) {
      expect(modal.names, name).not.toContain(name)
    }
    expect(modal.specifiers.filter((s) => /lib\/nodeActionItems$/.test(s))).toEqual([])
  })

  it('neither board imports the builder directly; Canvas hands them the rows', () => {
    for (const file of ['components/kanban/KanbanView.tsx', 'components/kanban/GlobalKanbanView.tsx']) {
      expect(imports(read(file)).specifiers.filter((s) => /lib\/nodeActionItems$/.test(s)), file).toEqual([])
    }
  })

  it('no other renderer file defines the node rows again', () => {
    const owned = join(RENDERER, 'lib/nodeActionItems.tsx')
    const rows = ["label: 'Restart agent'", "label: 'Pause & end session'", "label: 'Switch Claude account'"]
    const offenders = sources(RENDERER)
      .filter((f) => f !== owned)
      .filter((f) => rows.some((r) => readFileSync(f, 'utf8').includes(r)))
      .map((f) => relative(RENDERER, f))
    expect(offenders).toEqual([])
  })
})
