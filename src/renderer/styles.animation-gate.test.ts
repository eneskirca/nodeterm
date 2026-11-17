import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The animation gate is an ALL-OR-NOTHING fix, which is why it is enforced by scan rather than by
 * review.
 *
 * A running CSS animation obliges the compositor to produce a frame every vsync, and that cost is
 * paid once for the window, not once per animation. Measured on the Server Edition with a
 * 40-terminal canvas idling for 25 s under headless Chrome: 1.5 % total browser CPU with nothing
 * animating, 33 % with ONE node pulsing, 101 % with twenty, and 1.6 % with the same twenty paused.
 * The step is at the first animation. So a single `infinite` animation added later without the
 * gate does not make the feature 1/56th worse — it holds the frame loop open and takes the whole
 * win back, while every animation the gate DOES cover still looks correctly frozen, which is
 * exactly the kind of regression nobody notices by looking.
 *
 * Joining the gate means one of two things, and the allowlist below is for neither:
 *   - `animation-play-state: var(--nt-anim-state);` after the shorthand (the shorthand resets
 *     play-state, so it must come after), or
 *   - an explicit `:root[data-nt-window='idle']` rule that gives the element a static state.
 */

const STYLES = path.join(__dirname, 'styles.css')
const PLAY_STATE = 'animation-play-state: var(--nt-anim-state)'

/**
 * Animations that deliberately stay out of the shared play-state property because an idle-window
 * rule handles them by hand. Keyed by keyframe name, with the reason, so removing the hand-written
 * rule without removing the entry fails below.
 */
const STATIC_WHEN_IDLE: Record<string, string> = {
  // Bounded (4 cycles) and resting lit since the second CPU/GPU pass; the entry stays for the same
  // reason as the working glow's.
  'nt-unread-glow': 'held lit rather than frozen mid-cycle, alongside its two siblings',
  // Bounded (4 cycles) since the CPU/GPU pass, so the infinite scan no longer sees it; the entry
  // stays because its idle and Reduce Motion rules still hold it lit mid-pulse.
  'nt-working-glow': 'held lit rather than frozen mid-cycle, alongside its two siblings',
  'nt-attention-glow': 'held lit rather than frozen mid-cycle, alongside its two siblings'
}

function readStyles(): string {
  // Normalized per the repo's line-endings rule: `.gitattributes` only applies on re-checkout, so
  // a tree cloned before it still has CRLF working files and every `\n` slice below would miss.
  return fs.readFileSync(STYLES, 'utf8').replace(/\r\n/g, '\n')
}

/** The body of the first rule whose selector is exactly `sel` (up to its closing brace). */
function ruleBody(css: string, sel: string): string {
  const i = css.indexOf(sel + ' {')
  expect(i, `no rule for ${sel}`).toBeGreaterThanOrEqual(0)
  return css.slice(i, css.indexOf('}', i))
}

/** The body of `@keyframes name`, up to its closing brace at column 0. */
function keyframesBody(css: string, name: string): string {
  const i = css.indexOf(`@keyframes ${name}`)
  expect(i, `no @keyframes ${name}`).toBeGreaterThanOrEqual(0)
  return css.slice(i, css.indexOf('\n}', i))
}

/** Every `animation:` shorthand in the file that runs forever, with its line number. */
function infiniteAnimationLines(css: string): { line: number; text: string }[] {
  return css
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter((l) => l.text.includes('animation:') && /\binfinite\b/.test(l.text))
}

describe('idle-window animation gate', () => {
  const css = readStyles()

  it('defines the variable and the idle state that drive it', () => {
    expect(css).toContain('--nt-anim-state: running')
    expect(css).toMatch(/:root\[data-nt-window='idle'\]\s*\{\s*--nt-anim-state:\s*paused/)
  })

  it('finds the infinite animations at all (a passing scan over nothing proves nothing)', () => {
    expect(infiniteAnimationLines(css).length).toBeGreaterThan(20)
  })

  it('gates every infinite animation, or names it in the static-when-idle allowlist', () => {
    const lines = css.split('\n')
    const ungated: string[] = []

    for (const { line, text } of infiniteAnimationLines(css)) {
      const keyframe = Object.keys(STATIC_WHEN_IDLE).find((k) => text.includes(k))
      if (keyframe) continue

      // The property is either on the same line (single-line rule) or on the next non-blank one.
      const sameLine = text.includes(PLAY_STATE)
      const next = (lines[line] ?? '').trim()
      if (sameLine || next.startsWith(PLAY_STATE)) continue

      ungated.push(`styles.css:${line}  ${text.trim()}`)
    }

    expect(
      ungated,
      'These infinite animations keep the compositor producing frames while nobody is looking at\n' +
        'the window, which takes back the whole win of the gate (see the header of this file).\n' +
        `Add "${PLAY_STATE};" directly after the shorthand, or give the element an explicit\n` +
        "`:root[data-nt-window='idle']` rule and list its keyframe in STATIC_WHEN_IDLE.\n"
    ).toEqual([])
  })

  it("gates React Flow's own infinite animations (dashdraw), which the scan above cannot see", () => {
    // styles.css @imports xyflow's sheet, whose `dashdraw 0.5s linear infinite` on animated edges
    // never read the variable, so both gates missed it — MEASURED: one working edge under Liquid
    // Glass held 79 % GPU + 36 % renderer and +340 MB GPU footprint on an idle window; the
    // play-state rule took it back to the 0.5 % / 3.3 % baseline. Every infinite rule in the vendor
    // sheet needs a rule here with the SAME selector (same specificity, later by order, so it wins)
    // that sets the play-state — an upgrade that adds one fails here instead of silently costing.
    const vendor = fs
      .readFileSync(createRequire(__filename).resolve('@xyflow/react/dist/style.css'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const vendorSelectors = [...vendor.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => /animation:[^;]*\binfinite\b/.test(m[2]))
      .flatMap((m) => m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')))
    // Non-vacuous: the edge rule is the one that was measured.
    expect(vendorSelectors).toContain('.react-flow__edge.animated path')

    // Offsets below are all taken on the same comment-stripped text.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const ours = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => m[2].includes(PLAY_STATE))
      .map((m) => ({
        index: m.index ?? 0,
        selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '))
      }))
    const importAt = stripped.indexOf("@import '@xyflow/react/dist/style.css'")
    expect(importAt, 'styles.css no longer imports the xyflow sheet').toBeGreaterThanOrEqual(0)

    const ungated = vendorSelectors.filter(
      (sel) => !ours.some((r) => r.index > importAt && r.selectors.includes(sel))
    )
    expect(
      ungated,
      "These @xyflow/react rules run an infinite animation that ignores --nt-anim-state. Add the\n" +
        `exact selector to the rule in styles.css that sets "${PLAY_STATE};" for React Flow.\n`
    ).toEqual([])
  })

  it('backs every static-when-idle entry with a real idle rule', () => {
    for (const [keyframe, reason] of Object.entries(STATIC_WHEN_IDLE)) {
      // The keyframe still has to exist, or the entry is stale and is silently excusing nothing.
      expect(css, `${keyframe} is allowlisted (${reason}) but has no @keyframes`).toContain(
        `@keyframes ${keyframe}`
      )
      // And the animation it drives must be turned off — not merely paused — while idle.
      const selector = css.match(
        new RegExp(`:root\\[data-nt-window='idle'\\][^{]*\\{[^}]*animation:\\s*none[^}]*\\}`, 'g')
      )
      expect(selector, `${keyframe} is allowlisted (${reason}) but nothing sets animation: none`)
        .not.toBeNull()
    }
  })

  it('the working glow is bounded and rests at the static-lit opacity', () => {
    // An infinite pulse kept the compositor at display rate for a whole agent turn while the
    // window was focused (measured +3 points CPU, ~25 style recalcs/s per visible working node).
    // Four cycles keep the "it just started working" signal; the rest is the idle gate's 0.7.
    const rule = ruleBody(css, '.react-flow__node:has(.term-node.working)::after')
    expect(rule).toMatch(/animation:\s*nt-working-glow\s+2\.6s\s+ease-in-out\s+4\b/)
    expect(rule).not.toMatch(/infinite/)
    expect(rule).toMatch(/opacity:\s*0\.7/)
    const kf = keyframesBody(css, 'nt-working-glow')
    // Starts and ends at the resting value, so the settle is seamless.
    expect(kf).toMatch(/0%,\s*100%\s*\{\s*opacity:\s*0\.7/)
  })

  it('the unread glow and the minimap working/unread beats are bounded and rest lit', () => {
    // Infinite, these kept the compositor at display rate for as long as any node stayed unread
    // (measured: ~120% -> ~26% idle renderer+GPU with every status animation paused).
    const rule = ruleBody(css, '.react-flow__node:has(.term-node.unread)::after')
    expect(rule).toMatch(/animation:\s*nt-unread-glow\s+2s\s+ease-in-out\s+4\b/)
    expect(rule).toMatch(/opacity:\s*0\.85/)
    expect(keyframesBody(css, 'nt-unread-glow')).toMatch(/0%,\s*100%\s*\{\s*opacity:\s*0\.85/)
    for (const [sel, kf] of [
      ['.minimap .mm-unread', 'mm-pulse-unread'],
      ['.minimap .mm-working', 'mm-pulse-soft']
    ]) {
      // The selector also heads a shared stroke-width group rule; take the rule that animates.
      const r = css.split(sel + ' {').slice(1).map((b) => b.slice(0, b.indexOf('}'))).find((b) => b.includes('animation:')) ?? ''
      expect(r).toMatch(new RegExp(`animation:\\s*${kf}\\s+[\\d.]+s\\s+ease-in-out\\s+4\\b`))
      expect(r).not.toMatch(/infinite/)
      expect(keyframesBody(css, kf)).toMatch(/0%,\s*100%\s*\{\s*stroke-opacity:\s*1\b/)
    }
  })

  it('the board card RUNNING chip is bounded and rests at full opacity', () => {
    // Infinite, one chip held the compositor at display rate for as long as its agent worked,
    // and under Liquid Glass every column's backdrop-filter ran again each frame. MEASURED (Server
    // Edition, headless Chrome, 20 RUNNING cards, glass on, 15 s): GPU 50 % -> 17.5 % with the
    // chips still. The covered-canvas gate cannot reach it: the board is what covers the canvas.
    const rule = ruleBody(css, '.kanban-badge--running')
    expect(rule).toMatch(/animation:\s*nt-pulse\s+1\.1s\s+ease-in-out\s+4\b/)
    expect(rule).not.toMatch(/infinite/)
    // Ends where it started, at the chip's own (unanimated) look: no snap when the fourth cycle ends.
    expect(keyframesBody(css, 'nt-pulse')).toMatch(/0%,\s*100%\s*\{\s*opacity:\s*1;\s*transform:\s*scale\(1\)/)
  })

  it('the subagent and loop card dots and the sidebar unread check are bounded (issue #1454)', () => {
    // A FOCUSED window has no gate. Issue #1454 measured a canvas whose only running animations
    // were these, the sessions sidebar's unread checks and four working-subagent edges: renderer
    // 108 % and GPU 38 % with the window focused, 64 % / 3 % with them stopped. The cards still
    // say "working" in text with a running timer; the sidebar row keeps its check. Four pulses mark
    // the change, like every other status indicator. (The needs-you bell keeps pulsing on purpose:
    // needs-you is the one state that must keep pulling the eye.)
    for (const sel of [
      '.subagent-node.working .subagent-node__dot',
      '.loop-node.working .loop-node__dot',
      '.ss-check--unread'
    ]) {
      const rule = ruleBody(css, sel)
      expect(rule, sel).toMatch(/animation:\s*nt-pulse\s+1\.1s\s+ease-in-out\s+4\b/)
      expect(rule, sel).not.toMatch(/infinite/)
    }
  })

  it('working edges flow for a few seconds, then hold the dash (issue #1454)', () => {
    // React Flow's `dashdraw` (0.5 s, infinite in its own sheet) ran for as long as a subagent or
    // loop worked, and held a focused window's frame loop open by itself. The edge keeps its dash
    // (xyflow's `stroke-dasharray`, untouched), so "dashed = working, solid = done" still reads;
    // only the flow stops. Same specificity as xyflow's rule and later, so the longhand wins.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const importAt = stripped.indexOf("@import '@xyflow/react/dist/style.css'")
    const bounded = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
      (m) =>
        (m.index ?? 0) > importAt &&
        m[1].split(',').map((s) => s.trim()).includes('.react-flow__edge.animated path') &&
        /animation-iteration-count:/.test(m[2])
    )
    expect(bounded, 'no rule bounds .react-flow__edge.animated path').toBeDefined()
    const count = Number(bounded![2].match(/animation-iteration-count:\s*(\d+)/)?.[1])
    const vendor = fs
      .readFileSync(createRequire(__filename).resolve('@xyflow/react/dist/style.css'), 'utf8')
      .replace(/\r\n/g, '\n')
    const seconds = Number(vendor.match(/\.react-flow__edge\.animated path\s*\{[^}]*animation:\s*dashdraw\s+([\d.]+)s/)?.[1])
    expect(seconds).toBeGreaterThan(0)
    expect(count * seconds).toBeGreaterThanOrEqual(2)
    expect(count * seconds).toBeLessThanOrEqual(5)
    expect(bounded![2]).not.toMatch(/stroke-dasharray/)
  })

  it('never pauses the notch HUD, whose window is never focused', () => {
    // hud.css belongs to a separate always-on-top panel window that by design never takes focus,
    // so the shared gate would freeze it permanently rather than while nobody is looking.
    const hud = path.join(__dirname, 'hud', 'hud.css')
    if (!fs.existsSync(hud)) return
    expect(fs.readFileSync(hud, 'utf8')).not.toContain('--nt-anim-state')
  })
})
