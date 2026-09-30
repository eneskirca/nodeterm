import fs from 'node:fs'
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

  it('never pauses the notch HUD, whose window is never focused', () => {
    // hud.css belongs to a separate always-on-top panel window that by design never takes focus,
    // so the shared gate would freeze it permanently rather than while nobody is looking.
    const hud = path.join(__dirname, 'hud', 'hud.css')
    if (!fs.existsSync(hud)) return
    expect(fs.readFileSync(hud, 'utf8')).not.toContain('--nt-anim-state')
  })
})
