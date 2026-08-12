import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guard on the bottom-left pill cluster's SHARED shell.
 *
 * Written after a real regression: the system-resource pill was collapsed to an icon by editing
 * what looked like a `.sysres-pill` rule — but the selector was `.usage-pill, .sysres-pill`, so the
 * `width: 26px; padding: 0` landed on the Claude usage pill too and squashed it into a circle. The
 * two pills sit side by side and share a shell deliberately; the failure mode is that a change
 * aimed at one silently reshapes the other, and nothing rendered in CI would have caught it.
 *
 * The rule this pins: the shared block carries only what BOTH pills want. Per-pill sizing lives in
 * a rule whose selector names exactly one pill.
 */

const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8')

/**
 * The declaration body of the rule whose selector list is EXACTLY `selectors`.
 *
 * Parses rules rather than regexing the selector, because a regex anchored on `\n.sysres-pill {`
 * also matches the CONTINUATION line of `.usage-pill,\n.sysres-pill {` — which is the very
 * confusion this file exists to catch, and it caught the first draft of this helper.
 */
function ruleBody(selectors: string[]): string {
  const want = selectors.join(',')
  for (const chunk of CSS.split('}')) {
    const brace = chunk.indexOf('{')
    if (brace < 0) continue
    const head = chunk
      .slice(0, brace)
      .replace(/\/\*[\s\S]*?\*\//g, '') // comments may sit between selectors
      .split(',')
      .map((sel) => sel.trim())
      .filter(Boolean)
      .join(',')
    if (head === want) return chunk.slice(brace + 1)
  }
  throw new Error(`no rule whose selector list is exactly: ${want}`)
}

describe('bottom-left pill cluster', () => {
  it('shares one shell between the usage pill and the resource pill', () => {
    const shared = ruleBody(['.usage-pill', '.sysres-pill'])
    expect(shared).toContain('height: 26px')
    expect(shared).toContain('border-radius: 13px')
  })

  it('keeps per-pill SIZING out of the shared shell', () => {
    // `width` and `justify-content` are the two that squashed the usage pill. A shared `padding` is
    // fine (both want the same one) — what is not fine is a width, because only one pill collapses.
    const shared = ruleBody(['.usage-pill', '.sysres-pill'])
    expect(shared).not.toMatch(/(^|\s)width:/)
    expect(shared).not.toMatch(/justify-content:/)
  })

  it('collapses ONLY the resource pill to an icon', () => {
    const own = ruleBody(['.sysres-pill'])
    expect(own).toContain('width: 26px')
    // The proof it is the resource pill's alone: the shared block above must not have grown it.
    const shared = ruleBody(['.usage-pill', '.sysres-pill'])
    expect(shared).not.toContain('width: 26px')
  })
})
