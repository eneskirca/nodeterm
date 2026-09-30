import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guard on the account usage popover's overflow behaviour (issue #503).
 *
 * The panel had no `max-height` and no scroll, so once about four accounts were present it grew
 * taller than the window: the FIRST account's header and Session meter were clipped off the top
 * with no way to reach them, and the last was squeezed against the status bar. Removing the
 * account was the only workaround.
 *
 * The fix is structural, not cosmetic, and every part of it is load-bearing:
 *  - the popover is capped and is a flex COLUMN, so the heading stays put;
 *  - `__body` is the scroll container, and needs `min-height: 0` or a flex child refuses to
 *    shrink below its content height and the cap does nothing.
 *
 * The "Switch Claude account…" button used to be a fixed footer OUTSIDE `__body`. Issue #912 moved
 * it into the Claude / System block it acts on: as a footer it sat under whichever provider was
 * listed last and read as that provider's action. That block is always first, so it scrolls with
 * the account it belongs to rather than away from it.
 *
 * None of that renders in CI, and all of it is one "simplification" away from being undone.
 */

const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8')
const TSX = readFileSync(join(__dirname, 'components/UsageIndicator.tsx'), 'utf8')

/** The declaration body of the rule whose selector list is EXACTLY `selector`. */
function ruleBody(selector: string): string {
  for (const chunk of CSS.split('}')) {
    const brace = chunk.indexOf('{')
    if (brace < 0) continue
    const head = chunk
      .slice(0, brace)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((sel) => sel.trim())
      .filter(Boolean)
      .join(',')
    // Comments are stripped from the body too: they legitimately NAME the properties they
    // explain, and a `not.toMatch` would then answer about the prose instead of the rule.
    if (head === selector) return chunk.slice(brace + 1).replace(/\/\*[\s\S]*?\*\//g, '')
  }
  throw new Error(`no rule for selector "${selector}"`)
}

describe('.usage-popover is bounded and scrolls (issue #503)', () => {
  it('caps its height so it can never grow past the window', () => {
    const body = ruleBody('.usage-popover')
    expect(body).toMatch(/max-height:\s*calc\(100vh/)
  })

  it('is a flex column, so the heading and footer can be held out of the scroll', () => {
    const body = ruleBody('.usage-popover')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-direction:\s*column/)
  })

  it('scrolls the account list rather than truncating it', () => {
    const body = ruleBody('.usage-popover__body')
    expect(body).toMatch(/overflow-y:\s*auto/)
    // Without min-height: 0 a flex child will not shrink below its content, and the cap above
    // becomes decorative.
    expect(body).toMatch(/min-height:\s*0/)
    // A max-height here would be a silent truncation — the panel must show every account.
    expect(body).not.toMatch(/max-height/)
  })

  it('holds the heading out of the scrolling area', () => {
    expect(ruleBody('.usage-popover__head')).toMatch(/flex:\s*none/)
  })
})

describe('UsageIndicator keeps the switch action with the account it switches (issue #912)', () => {
  it('opens __body after the head and renders the switch action inside it, not as a footer', () => {
    const head = TSX.indexOf('className="usage-popover__head"')
    const bodyOpen = TSX.indexOf('className="usage-popover__body"')
    expect(head).toBeGreaterThan(-1)
    expect(bodyOpen).toBeGreaterThan(head)
    // Rendered by the Claude block and the System account row, both inside __body.
    const uses = [...TSX.matchAll(/switchAction\}/g)].map((m) => m.index ?? -1)
    expect(uses.length).toBeGreaterThanOrEqual(2)
    for (const at of uses) expect(at).toBeGreaterThan(bodyOpen)
  })
})
