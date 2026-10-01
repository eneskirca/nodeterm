// Live links: rules no single unit can see. Each is a way a live link turns into a leak, or into a
// broadcast the owner cannot see.
//
// Renderer-side on purpose: importing `ui-visibility` from here does not reach across the core
// boundary. Source-level where the rule is about WHERE something is written.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HIDEABLE_HEADER_BUTTONS, HIDEABLE_MENU_ITEMS } from './ui-visibility'

const root = join(__dirname, '..', '..', '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n')
/** From a top-level `export interface X {` to its closing `}` at column 0. */
function block(src: string, header: RegExp): string {
  const m = header.exec(src)
  if (!m) throw new Error(`not found: ${header}`)
  const end = src.indexOf('\n}\n', m.index)
  if (end === -1) throw new Error(`no end for: ${header}`)
  return src.slice(m.index, end)
}

const LINK_STATE = /watchLink|liveLink|live[ -]link|watch[-_]link/i

/** The four surfaces that show a node, and so the chip (CONTRIBUTING: one session, one voice). */
const SURFACES = [
  'src/renderer/nodes/TerminalNode.tsx',
  'src/renderer/components/kanban/SessionCard.tsx',
  'src/renderer/components/kanban/CardModal.tsx',
  'src/renderer/components/SessionRow.tsx'
]

describe('live-link guards', () => {
  it('no canvas content type carries link state (canvas sync and the canvas authority would publish it)', () => {
    const types = read('src/shared/types.ts')
    for (const h of [/export interface CanvasNodeState\b/, /export interface ProjectKanban\b/, /export interface Project\b/]) {
      expect(block(types, h)).not.toMatch(LINK_STATE)
    }
    for (const f of ['src/shared/canvas-mutations.ts', 'src/shared/canvas-content.ts']) {
      expect(read(f)).not.toMatch(LINK_STATE)
    }
  })

  it('the renderer serializers and the projects store never read the live-link store', () => {
    for (const f of ['src/renderer/state/workspace.ts', 'src/renderer/state/projects.ts']) {
      expect(read(f)).not.toMatch(LINK_STATE)
    }
  })

  it('the LIVE chip is not user-hideable', () => {
    // Neither inventory can carry the chip. (The menu ROW "Share live link…" may be hideable; the
    // chip that says a terminal IS being broadcast may not.)
    expect(HIDEABLE_HEADER_BUTTONS.map((r) => r.id).filter((id) => /live/i.test(id))).toEqual([])
    expect([...HIDEABLE_MENU_ITEMS, ...HIDEABLE_HEADER_BUTTONS].map((r) => r.id).filter((id) => /chip|indicator/i.test(id))).toEqual([])
    for (const f of SURFACES) {
      const src = read(f)
      expect(src, f).toMatch(/import \{ LiveLinkChip(, [\w, ]+)? \} from '(\.\.\/|\.\/)(components\/)?LiveLinkChip'/)
      const lines = src.split('\n')
      const at = lines.findIndex((l) => l.includes('<LiveLinkChip'))
      expect(at, `${f} renders <LiveLinkChip`).toBeGreaterThanOrEqual(0)
      // Not behind a visibility check: nothing between the previous element that CLOSED (its `/>` or
      // `</`) and the chip — the span where a wrapping `{!isHidden(…) && (` would open — nor on the
      // three lines above it, however they are laid out…
      let from = at - 1
      while (from > 0 && !/\/>|<\//.test(lines[from])) from--
      expect(lines.slice(Math.max(0, Math.min(from, at - 3)), at + 1).join('\n'), f).not.toMatch(/isHidden|hidden/i)
      // …nor anywhere in the file under an id that names the chip.
      expect(src, f).not.toMatch(/isHidden\(\s*['"][^'"]*(chip|indicator)/i)
      // R57: every chip says which session it is viewed through (a relay copy of a git-shared node
      // carries the same id, and must not show this machine's chip). The prop is required, so this
      // pins that no surface satisfies it with a constant.
      for (const line of lines.filter((l) => l.includes('<LiveLinkChip'))) {
        expect(line, f).toMatch(/source=\{/)
        expect(line, f).not.toMatch(/source=["']local["']|source=\{['"]local['"]\}/)
      }
    }
  })

  it('R57: the surfaces outside a project\'s SessionProvider resolve the session from the project', () => {
    // The boards and the sessions sidebar are not inside the node's SessionProvider (useSession()
    // there is the app's local session), so each resolves its project's session and hands it on.
    const sidebar = read('src/renderer/components/SessionsSidebar.tsx')
    expect((sidebar.match(/<SessionRow\b/g) ?? []).length).toBeGreaterThan(0)
    expect((sidebar.match(/liveLinkSource=\{projectSessionSource\(/g) ?? []).length).toBe(
      (sidebar.match(/<SessionRow\b/g) ?? []).length
    )
    for (const f of ['src/renderer/components/kanban/KanbanView.tsx', 'src/renderer/components/kanban/GlobalKanbanView.tsx']) {
      const src = read(f)
      expect(src, f).toContain('const liveLinkSource = projectSessionSource(projectId)')
      const cards = src.split('<SessionCard').slice(1)
      expect(cards.length, f).toBeGreaterThan(0)
      for (const c of cards) expect(c.slice(0, c.indexOf('/>')), f).toContain('liveLinkSource={liveLinkSource}')
      const modals = src.split('<CardModal').slice(1)
      expect(modals.length, f).toBeGreaterThan(0)
      for (const m of modals) expect(m.slice(0, m.indexOf('/>')), f).toContain('projectId={projectId}')
    }
  })

  it('no canvas-control verb can publish a terminal', () => {
    // The verbs moved: core/canvas-control-core.ts (handlers, agent-facing docs) and
    // shared/control-verbs.ts (the verb registry). Neither may name a live link.
    for (const f of ['src/core/canvas-control-core.ts', 'src/shared/control-verbs.ts']) {
      expect(read(f), f).not.toMatch(LINK_STATE)
    }
  })
})
