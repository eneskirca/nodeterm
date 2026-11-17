import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Reduce Motion is enforced by scan, for the same reason the idle gate is: it was added one
 * selector at a time, so every new animation was one forgotten line away from ignoring it — and
 * nothing fails when it does. Issue #1454: a Reduce Motion user's canvas still flowed four edges,
 * pulsed four subagent dots and two sidebar checks, keeping a FOCUSED window at 120 frames/s
 * (renderer 110 %, GPU 42 % with the OS setting on; 64 % / 3 % with those stopped).
 *
 * The rule: every REPEATING animation (`infinite`, or an iteration count of 2 or more) in
 * styles.css must be turned off (`animation: none`) by a `@media (prefers-reduced-motion: reduce)`
 * rule that names its selector — or be listed below with the reason it is not. A one-shot
 * entrance animation is out of scope, and so is anything already inside a `no-preference` block.
 */

const css = fs
  .readFileSync(path.join(__dirname, 'styles.css'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Selectors whose reduce-motion rule is spelled differently, mapped to the selector that IS in a
 * reduce block. Each mapping is checked: the covering selector must really be stopped there.
 */
const COVERED_BY: Record<string, string> = {
  // Styled at (0,2,0); a bare `.term-node__status-dot` lost on specificity (see the comment in
  // the reduce block), so the block names the parent class instead.
  '.term-node__status--busy .term-node__status-dot': '.term-node__status .term-node__status-dot',
  '.term-node__status--attention .term-node__status-dot': '.term-node__status .term-node__status-dot'
}

/** Repeating animations that deliberately keep moving under Reduce Motion, with the reason. */
const EXEMPT: Record<string, string> = {
  // Progress indicators exist only while a task the user started is running, and stopped they read
  // as a hang. HIG: reduce motion, keep the meaning; a spinner IS the meaning.
  '.ui-spinner': 'progress spinner',
  '.dictation__spinner': 'progress spinner (transcribing)',
  '.dictation__mic--active': 'live recording indicator while the user holds the mic',
  '.term-node__upload-spin': 'progress spinner (upload)',
  '.update-card__spinner': 'progress spinner (update download)',
  '.scm-gen.is-generating': 'progress indicator (commit message being generated)',
  '.ex-dl__spin': 'progress spinner (download)',
  '.ex-dls__spin': 'progress spinner (download)',
  '.usage-refresh.spin svg': 'progress spinner (refresh the user clicked)',
  '.sessmem-panel__refresh.spin svg': 'progress spinner (refresh the user clicked)',
  // Dead: the SDK chat node was removed (2026-07) and nothing renders these classes any more.
  '.chat-node__badge--working': 'dead CSS (chat node removed)',
  '.chat-node__badge--needs': 'dead CSS (chat node removed)',
  '.chat-node__typing span': 'dead CSS (chat node removed)',
  // KNOWN GAP: four setup-tour scenes the tour's own reduce block does not freeze yet. A transient
  // tour, not a status, but they owe a readable final frame like the rest of the block.
  '.ctx-menu.onb-menu': 'known gap: setup-tour scene',
  '.onb-capsule': 'known gap: setup-tour scene',
  '.onb-capsule__blob': 'known gap: setup-tour scene',
  '.onb-notchpanel': 'known gap: setup-tour scene'
}

function blocks(marker: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let i = 0
  while ((i = css.indexOf(marker, i)) >= 0) {
    const open = css.indexOf('{', i)
    let depth = 0
    let j = open
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}' && --depth === 0) break
    }
    out.push([open, j])
    i = j
  }
  return out
}

const reduce = blocks('@media (prefers-reduced-motion: reduce)')
const noPreference = blocks('@media (prefers-reduced-motion: no-preference)')
const inside = (at: number, ranges: Array<[number, number]>): boolean => ranges.some(([a, b]) => at > a && at < b)
const selectorsOf = (head: string): string[] => head.split(',').map((s) => s.trim().replace(/\s+/g, ' '))

/** Every selector a reduce-motion block turns the animation off for. */
function stoppedUnderReduce(): Set<string> {
  const out = new Set<string>()
  for (const [a, b] of reduce) {
    for (const m of css.slice(a + 1, b).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/animation(-name)?:\s*none/.test(m[2])) for (const s of selectorsOf(m[1])) out.add(s)
    }
  }
  return out
}

/** `infinite`, or a bare iteration count of 2+ (parenthesised arguments such as steps(12) aside). */
function repeats(body: string): boolean {
  const value = body.match(/animation:\s*([^;]+)/)?.[1]
  if (!value) return false
  return value
    .replace(/\([^)]*\)/g, '')
    .split(/[\s,]+/)
    .some((t) => t === 'infinite' || (/^\d+$/.test(t) && Number(t) >= 2))
}

function repeatingSelectors(): string[] {
  const out: string[] = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const at = m.index ?? 0
    if (!repeats(m[2]) || inside(at, reduce) || inside(at, noPreference)) continue
    out.push(...selectorsOf(m[1]))
  }
  return out
}

describe('Reduce Motion stops every repeating animation', () => {
  const stopped = stoppedUnderReduce()
  const repeating = repeatingSelectors()

  it('finds the repeating animations and the reduce blocks at all (non-vacuous)', () => {
    expect(repeating.length).toBeGreaterThan(30)
    expect(stopped.size).toBeGreaterThan(20)
    // The ones issue #1454 measured are in the scanned set.
    expect(repeating).toContain('.subagent-node.working .subagent-node__dot')
    expect(repeating).toContain('.ss-check--unread')
  })

  it('names every repeating animation in a reduce rule, or exempts it with a reason', () => {
    const missing = repeating.filter((sel) => {
      if (sel in EXEMPT) return false
      return !stopped.has(COVERED_BY[sel] ?? sel)
    })
    expect(
      missing,
      'These animations keep moving for a Reduce Motion user. Add the selector to a\n' +
        '`@media (prefers-reduced-motion: reduce)` rule with `animation: none` (and a static look if\n' +
        'the resting frame is not readable), or list it in EXEMPT with the reason.\n'
    ).toEqual([])
  })

  it("stops React Flow's working-edge flow, which lives in xyflow's sheet", () => {
    const vendor = fs.readFileSync(createRequire(__filename).resolve('@xyflow/react/dist/style.css'), 'utf8')
    expect(vendor).toMatch(/\.react-flow__edge\.animated path\s*\{[^}]*animation:\s*dashdraw/)
    expect(stopped.has('.react-flow__edge.animated path')).toBe(true)
  })

  it('keeps the exemption and alias lists honest', () => {
    for (const sel of Object.keys(EXEMPT)) {
      expect(repeating, `EXEMPT lists ${sel}, which no longer repeats`).toContain(sel)
      expect(stopped.has(sel), `${sel} is stopped under Reduce Motion now — drop it from EXEMPT`).toBe(false)
    }
    for (const [sel, cover] of Object.entries(COVERED_BY)) {
      expect(repeating, `COVERED_BY lists ${sel}, which no longer repeats`).toContain(sel)
      expect(stopped.has(cover), `${sel} is said to be covered by ${cover}, which is not stopped`).toBe(true)
    }
  })
})
