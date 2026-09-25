import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The sessions-sidebar row gives its NAME priority over the chips beside it.
 *
 * MEASURED in a real browser against these rules (headless Chrome, the 300px sidebar, a row
 * carrying a session chip and the account chip): the title was **45px** — four or five characters
 * — against 128px for the same row without the account chip, and a row with long values overflowed
 * its own line by 44px with the title at **0**. The cause was not one number: `.ss-title` was the
 * only shrinkable thing in the line, because `.ss-chip` was `flex: 0 0 auto` and the shared
 * `.node-account-chip` (built for the node header, where there is room) carries `flex-shrink: 0`
 * and a 120px cap.
 *
 * Every rule below is one of the three halves of the fix, and each is invisible in review: a
 * `flex` shorthand quietly re-setting `flex-shrink` back to 0, or the sidebar's class going
 * missing from `SessionRow`, restores the bug with nothing on screen to say so.
 *
 * `\r\n` is normalized for the same reason every other file-reading test here does it (see the
 * line-endings rule in CLAUDE.md): a Windows checkout would otherwise fail these on whitespace.
 */
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
const ROW = readFileSync(join(__dirname, 'components/SessionRow.tsx'), 'utf8').replace(/\r\n/g, '\n')

/** The body of the first rule whose selector list is exactly `sel`. */
function rule(sel: string): string {
  const i = CSS.indexOf(`\n${sel} {`)
  expect(i, `no rule for ${sel}`).toBeGreaterThan(-1)
  return CSS.slice(i, CSS.indexOf('}', i))
}

describe('sessions-sidebar row: the name outranks the chips', () => {
  it('gives the title a floor, expressed as a token on the line it belongs to', () => {
    expect(rule('.ss-row__titleline')).toContain('--ss-title-min:')
    const title = rule('.ss-title')
    expect(title).toContain('min-width: var(--ss-title-min)')
    // Grows into the free space AND may shrink — but never past the floor above.
    expect(title).toContain('flex: 1 1 auto')
  })

  it('makes both chips yield, rather than the name', () => {
    for (const sel of ['.ss-chip', '.ss-account']) {
      const r = rule(sel)
      // `0 1 auto` is the whole point: the header's `flex-shrink: 0` is what crushed the title.
      expect(r, sel).toContain('flex: 0 1 auto')
      // Without this a flex item's automatic minimum is its content, so it cannot actually shrink.
      expect(r, sel).toContain('min-width: 0')
    }
  })

  it('sizes the shared account chip for this row, overriding the node header in BOTH dimensions', () => {
    const r = rule('.ss-account')
    // The header's 120px cap and its 8px left margin are what this row cannot afford.
    expect(r).toMatch(/max-width: \d/)
    expect(r).toContain('margin-left: 0')
    // Later in the file than `.node-account-chip`, or the equal-specificity override loses.
    expect(CSS.indexOf('\n.ss-account {')).toBeGreaterThan(CSS.indexOf('\n.node-account-chip {'))
  })

  it('is actually applied — the row passes the sidebar class to the shared chip', () => {
    expect(ROW).toContain('<AccountChip chip={accountChip} className="ss-account" />')
  })

  it('takes the hover-only actions OUT of flow, so they cost the name nothing', () => {
    // Measured: both buttons are invisible until the row is hovered, and in flow they held 46px of
    // a 253px line. Out of flow the same row's name went 101px -> 131px (and 136 -> 174 with one
    // chip). `position: absolute` is the whole mechanism; the pointer-events pair is what stops an
    // invisible cluster from swallowing clicks meant for the row.
    const r = rule('.ss-row__actions')
    expect(r).toContain('position: absolute')
    expect(r).toContain('pointer-events: none')
    expect(CSS).toMatch(/\.ss-row:hover \.ss-row__actions[^{]*\{[^}]*pointer-events: auto/)
    // The line it floats inside must establish the containing block, or it anchors to the viewport.
    expect(rule('.ss-row__titleline')).toContain('position: relative')
  })

  it('keeps the session chip readable once truncated, via its tooltip', () => {
    // It can now be ellipsised, and an ellipsised chip with no tooltip is the one state where the
    // session name is unrecoverable from the UI.
    expect(ROW).toMatch(/className="ss-chip" title=\{row\.session\}/)
  })
})

/**
 * A project name is free text and can be anything a user pastes into a rename field — a 2,798-
 * character prompt copied out of a terminal, in the case that prompted this. MEASURED in Electron
 * against these rules with such a name: the sidebar's project header grew to 1,190px tall, and a
 * "Recently closed" row on the welcome screen held a 16,162px-wide name in its 480px width, pushing
 * the folder path and the delete button out of view. Both now cut the name to one line, the way
 * `.ss-subgroup__name` and `.tab__name` already do.
 */
describe('project names stay on one line', () => {
  it.each(['.ss-group__name', '.welcome__recent-name'])('%s ellipsizes instead of wrapping or overflowing', (sel) => {
    const r = sel === '.ss-group__name' ? rule(sel) : blockRule(sel)
    expect(r).toContain('white-space: nowrap')
    expect(r).toContain('overflow: hidden')
    expect(r).toContain('text-overflow: ellipsis')
    // A flex item's automatic minimum is its content, so without these it cannot shrink at all.
    expect(r).toContain('min-width: 0')
    expect(r).toMatch(/flex: 0 1 auto/)
  })
})

/** The body of a multi-line rule (`.sel {` on its own line), as the welcome screen's rules are written. */
function blockRule(sel: string): string {
  const i = CSS.indexOf(`\n${sel} {\n`)
  expect(i, `no rule for ${sel}`).toBeGreaterThan(-1)
  return CSS.slice(i, CSS.indexOf('}', i))
}
