import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// `.replace(/\r\n/g, '\n')` on every read below: a test that reads a checked-in file must not
// care how git checked it out. Git for Windows defaults to `core.autocrlf=true`, so a Windows
// clone has CRLF working files, and a slice on a literal containing `\n` (`indexOf('}\n}')`,
// `indexOf('\n}\n')`) then matches nothing and the assertion fails on a checkout with zero local
// changes (issue #578). `.gitattributes` is the durable half of the fix; this is the half that
// survives a working tree that was checked out before it landed.
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
const VIEW = readFileSync(join(__dirname, 'components/kanban/KanbanView.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('Kanban column row layout', () => {
  it('stretches empty columns to the height of the tallest column without filling the viewport', () => {
    expect(VIEW).toContain('className="kanban-board__columns"')
    expect(CSS).toMatch(
      /\.kanban-board__columns\s*{[^}]*display:\s*flex;[^}]*align-items:\s*stretch;[^}]*height:\s*fit-content;/s
    )
  })
})

describe('Card modal ⌘M view stacking (issue #389 resize handles)', () => {
  // Comments stripped first: the rule's own comment names the numbers it pins.
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const zOf = (re: RegExp): number => {
    const m = bare.match(re)
    expect(m, `rule not found: ${re}`).toBeTruthy()
    return Number(m![1])
  }

  it('lays the ⌘M face BELOW the sheet\'s resize handles, so resize keeps working while it is open', () => {
    const overlay = zOf(
      /\.kanban-modal__pane > \.term-md,\s*\.kanban-modal__pane > \.term-chat\s*{[^}]*z-index:\s*(\d+)/
    )
    const edges = zOf(/\.kanban-modal__resize\s*{[^}]*z-index:\s*(\d+)/)
    const corners = zOf(/\.kanban-modal__resize--sw\s*{[^}]*z-index:\s*(\d+)/)
    expect(overlay).toBeLessThan(edges)
    expect(overlay).toBeLessThan(corners)
  })

  it('still covers the viewer\'s copy pill and upload note (it is the later sibling, so equal z wins)', () => {
    const overlay = zOf(
      /\.kanban-modal__pane > \.term-md,\s*\.kanban-modal__pane > \.term-chat\s*{[^}]*z-index:\s*(\d+)/
    )
    const pill = zOf(/\.term-copy-pill\s*{[^}]*z-index:\s*(\d+)/)
    const upload = zOf(/\.kanban-modal__upload\s*{[^}]*z-index:\s*(\d+)/)
    expect(overlay).toBeGreaterThanOrEqual(pill)
    expect(overlay).toBeGreaterThanOrEqual(upload)
  })
})

describe('Header menus over the columns (issue #1350)', () => {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

  it('ranks the header strip above the board, so its Filter / Views menus cannot sink under a column', () => {
    // Under Liquid Glass both the strip and every column carry a backdrop-filter (the glass chrome
    // rule below), i.e. each is a stacking context; a menu's own z-index cannot leave the strip,
    // so the strip must outrank the columns itself.
    const header = bare.match(/\n\.kanban-header\s*{([^}]*)}/)
    expect(header, '.kanban-header rule').toBeTruthy()
    expect(header![1]).toMatch(/position:\s*relative;/)
    const z = Number(/z-index:\s*(\d+)/.exec(header![1])?.[1])
    expect(z).toBeGreaterThanOrEqual(1)
    expect(bare).toMatch(/\.kanban-header,\s*\.kanban-col,[\s\S]{0,400}backdrop-filter/)
    // The columns themselves stay unranked: equal `auto` is what let a later column win.
    expect(bare.match(/\n\.kanban-col\s*{([^}]*)}/)![1]).not.toMatch(/z-index/)
  })
})
