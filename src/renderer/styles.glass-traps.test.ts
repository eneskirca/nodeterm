import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Liquid Glass is OPT-IN per surface: a translucent glass fill is only ever handed to a surface
 * that also gets a working blur. Visual QA rounds 2 and 3 found eleven surfaces that were
 * see-through with no blur — terminal text read sharp through menus, drawers, pickers and
 * tooltips — because the shared panel tokens themselves resolved to the fill, which reached every
 * floating surface nobody had listed. Round 4 found the same failure in TIME: a scrim fading its
 * opacity is a backdrop root for the glass inside it, and a menu fading its own opacity lays the
 * page sharp under its blur, for the 120–160 ms of every open.
 *
 * The rules checked here:
 * 1. every rule that paints a translucent glass fill (as a background, a background-image or by
 *    assigning it to a custom property that surfaces paint) must, for each of its selectors, either
 *    carry a working backdrop-filter itself (the LAST backdrop-filter declaration wins) or target
 *    an element that a blur rule covers: the blur rule's selector must match at least everything the
 *    fill's selector matches — same ancestors, and its subject compound (pseudo-classes and `:not()`
 *    included) a subset of the fill's; a `::before` blur covers its host. A token assignment on
 *    `:root` targets no surface in particular, so it always fails.
 *    A later unconditional rule that sets the same element's backdrop-filter to something without a
 *    blur cancels it (the cascade, not one rule, decides).
 * 2. no glass surface (anything painting a fill or carrying a blur, a blurred `::before` layer, the
 *    host of a `::before` layer) and no scrim (`SCRIMS` in the probe) animates or transitions
 *    `opacity` — unless, in BOTH motion preferences (reduce and no-preference), a rule overrides that
 *    animation/transition for the same element with one that does not: a rule under the glass gate,
 *    or a later default-look rule on the same selector. An override inside a media query counts
 *    only for the preference that query names (code review 7 #1/#2: the kanban modal kept its fade
 *    under Reduce Motion because its only override sat in a no-preference query).
 * The live half — backdrop roots, which CSS alone cannot see, at rest and mid-animation — is
 * `scripts/glass-trap-probe.mjs` (see CLAUDE.md, Liquid Glass chrome).
 */
const FILL = /var\(--(glass-chrome-bg|glass-control-bg|term-glass-bg|term-glass-header-bg)\)/
const PAINT = /(?:^|;)\s*(background(?:-color|-image)?|--[\w-]+)\s*:([^;]*)/g
const GATE = /^:root\[data-nt-glass='on'\](?:\[[^\]]*\])*\s*/

/** In-flow pieces that only stack on their own blurred surface, never over other content. */
const IN_FLOW: Record<string, string> = {
  '.kanban-modal__termwrap--glass': 'the card-modal terminal fills the blurred .kanban-modal',
  '.term-node--glass .term-node__header': 'the header row of its own blurred glass node',
}

interface Rule {
  selectors: string[]
  body: string
  /** The enclosing `@media` conditions ('' when unconditional). */
  media: string
  /** Source order. */
  index: number
}

/** Every `@<name> … {` block's extent and prelude. */
function blocks(src: string, name: RegExp): { from: number; to: number; prelude: string }[] {
  const out: { from: number; to: number; prelude: string }[] = []
  for (const m of src.matchAll(new RegExp(`@${name.source}([^{]*)\\{`, 'g'))) {
    let depth = 1
    let i = m.index! + m[0].length
    while (depth && i < src.length) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0, i++
    out.push({ from: m.index!, to: i, prelude: m[1].trim() })
  }
  return out
}

function parse(css: string): Rule[] {
  const out: Rule[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  const src = css.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
  const media = blocks(src, /media/)
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const head = m[1].replace(/\s+/g, ' ').trim()
    // Keyframe steps (`from`, `50%`) are not selectors.
    if (/^(from|to|[\d.]+%)(\s*,\s*(from|to|[\d.]+%))*$/.test(head)) continue
    const at = m.index
    const cond = media.filter((b) => b.from < at && at < b.to).map((b) => b.prelude)
    out.push({ selectors: splitTop(head), body: m[2], media: cond.join(' and '), index: out.length })
  }
  return out
}

/** `@keyframes` (and `@-webkit-keyframes`) names whose steps set opacity. */
function opacityKeyframes(css: string): Set<string> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return new Set(
    blocks(src, /(?:-webkit-)?keyframes/)
      .filter((b) => /(?:^|[;{\s])opacity\s*:/.test(src.slice(b.from, b.to)))
      .map((b) => b.prelude)
  )
}

/** Split on commas (or, with `space`, on whitespace) outside parentheses. */
function splitTop(list: string, space = false): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if ((space ? /\s/.test(ch) : ch === ',') && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return space ? parts.filter(Boolean) : parts
}

/** One concrete selector: its ancestor part (verbatim, gate stripped), the subject compound's
 *  simple selectors (classes, attributes, pseudo-classes WITH their arguments) and its
 *  pseudo-element. */
interface Alt {
  anc: string
  tokens: Set<string>
  pseudo: string
}

function alternatives(selector: string): Alt[] {
  const sel = selector.replace(GATE, '').trim()
  let depth = 0
  let start = 0
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) start = i + 1
  }
  const anc = sel.slice(0, start).replace(/\s+/g, ' ').trim()
  return compoundAlts(sel.slice(start)).map((c) => ({ anc, ...c }))
}

/** A leading `:is(a, b)` lists alternatives; whatever follows it (`:hover`, `::before`) applies to each. */
function compoundAlts(compound: string): { tokens: Set<string>; pseudo: string }[] {
  if (compound.startsWith(':is(')) {
    let d = 0
    let end = 3
    while (end < compound.length && !(compound[end] === ')' && --d === 0)) if (compound[end++] === '(') d++
    const rest = compound.slice(end + 1)
    return splitTop(compound.slice(4, end)).flatMap((a) => compoundAlts(a + rest))
  }
  const tokens = new Set<string>()
  let pseudo = ''
  const re = /::?[\w-]+(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?|\.[\w-]+|\[[^\]]*\]|#[\w-]+|^[a-z][\w-]*/g
  for (const t of compound.match(re) ?? []) {
    if (t.startsWith('::')) pseudo = t.slice(2)
    else tokens.add(t)
  }
  return [{ tokens, pseudo }]
}

/** Does `b` match at least every element `s` matches? */
const covers = (b: Alt, s: Alt): boolean =>
  (b.anc === '' || b.anc === s.anc) && b.tokens.size > 0 && [...b.tokens].every((t) => s.tokens.has(t))

/** Can `a` and `b` match the same element? Either covers the other, or they share a subject class
 *  (`.sheet.is-open` and `.sheet`, `.modal .sheet` and `.sheet`). */
const overlap = (a: Alt, b: Alt): boolean =>
  covers(a, b) || covers(b, a) || [...a.tokens].some((t) => t.startsWith('.') && b.tokens.has(t))

/** The last (-webkit-)backdrop-filter declaration decides; Chromium treats the two as one property. */
function blurs(body: string): boolean {
  const decls = [...body.matchAll(/(?:^|;)\s*(?:-webkit-)?backdrop-filter\s*:([^;]*)/g)]
  const last = decls.at(-1)?.[1].trim() ?? 'none'
  return last !== 'none' && /blur/.test(last)
}

const paintsFill = (r: Rule): boolean => [...r.body.matchAll(PAINT)].some((d) => FILL.test(d[2]))
const setsBackdrop = (body: string): boolean => /(?:^|;)\s*(?:-webkit-)?backdrop-filter\s*:/.test(body)

/** Every blurred selector alternative whose blur no later unconditional rule cancels. A cancelling
 *  rule must cover the element and not lose on the gate's specificity. */
function blurredAlts(rules: Rule[]): Alt[] {
  const out: Alt[] = []
  for (const r of rules.filter((r) => blurs(r.body)))
    for (const sel of r.selectors)
      for (const a of alternatives(sel)) {
        const cancelled = rules.some(
          (k) =>
            k.index > r.index &&
            k.media === '' &&
            setsBackdrop(k.body) &&
            !blurs(k.body) &&
            k.selectors.some((ks) => (GATE.test(ks) || !GATE.test(sel)) && alternatives(ks).some((ka) => ka.pseudo === a.pseudo && covers(ka, a)))
        )
        if (!cancelled) out.push(a)
      }
  return out
}

/** Every selector that paints a glass fill without a blur of its own or a covering blur rule. */
function glassFillsWithoutBlur(css: string): string[] {
  const rules = parse(css)
  const blurred = blurredAlts(rules)
  const covered = (s: Alt): boolean =>
    blurred.some((b) => (b.pseudo === s.pseudo || b.pseudo === 'before') && covers(b, s))
  const bad: string[] = []
  for (const r of rules) {
    if (!paintsFill(r)) continue
    for (const sel of r.selectors) {
      if (Object.keys(IN_FLOW).some((k) => sel.endsWith(k))) continue
      if (!alternatives(sel).every(covered)) bad.push(sel)
    }
  }
  return bad
}

/** A `transition` shorthand item with no property name transitions `all`. */
const TIMING = /^(?:-?[\d.]+m?s|ease(?:-in|-out|-in-out)?|linear|step-start|step-end|allow-discrete|normal|(?:steps|cubic-bezier|linear)\(.*\))$/
const transitionProps = (prop: string, v: string): string[] =>
  prop === 'transition-property'
    ? splitTop(v)
    : splitTop(v).map((item) => splitTop(item, true).find((w) => !TIMING.test(w)) ?? 'all')

const MOTION_PREFS = ['reduce', 'no-preference'] as const
type MotionPref = (typeof MOTION_PREFS)[number]
const PREF_QUERY = /^\(prefers-reduced-motion:\s*(reduce|no-preference)\)$/
/** The motion preferences a rule may apply in: any other condition may hold in either. */
const mayApplyIn = (media: string): readonly MotionPref[] => {
  const p = PREF_QUERY.exec(media)?.[1] as MotionPref | undefined
  return p ? [p] : MOTION_PREFS
}
/** Does a rule surely apply in preference `p`? Only unconditional, or under exactly that query. */
const surelyAppliesIn = (media: string, p: MotionPref): boolean => media === '' || PREF_QUERY.exec(media)?.[1] === p

/** Every glass surface or scrim selector that animates or transitions opacity (see rule 2). */
function glassOpacityMotion(css: string, scrims: string[]): string[] {
  const rules = parse(css)
  const fades = opacityKeyframes(css)
  const targets: Alt[] = [
    ...rules.filter((r) => paintsFill(r) || blurs(r.body)).flatMap((r) => r.selectors.flatMap(alternatives)),
    ...scrims.flatMap(alternatives),
  ]
  // A layer's own motion fades that layer; its host's motion fades the host and every layer on it.
  const hits = (t: Alt, a: Alt): boolean => (a.pseudo === '' || a.pseudo === t.pseudo) && overlap(t, a)
  const kindsOf = (body: string): { animation?: boolean; transition?: boolean } => {
    const out: { animation?: boolean; transition?: boolean } = {}
    for (const d of body.matchAll(/(?:^|;)\s*(animation(?:-name)?|transition(?:-property)?)\s*:([^;]*)/g)) {
      const v = d[2]
      if (d[1].startsWith('animation')) out.animation = v.split(/[\s,]+/).some((w) => fades.has(w))
      else out.transition = transitionProps(d[1], v).some((p) => p === 'opacity' || p === 'all')
    }
    return out
  }
  const bad: string[] = []
  for (const r of rules) {
    const kinds = kindsOf(r.body)
    for (const kind of ['animation', 'transition'] as const) {
      if (!kinds[kind]) continue
      for (const sel of r.selectors) {
        const gated = GATE.test(sel)
        for (const a of alternatives(sel)) {
          if (!targets.some((t) => hits(t, a))) continue
          // An ungated (default-look) rule is fine when, in every motion preference it may apply
          // in, a rule re-declares that motion for the same element without opacity: a gated rule
          // (it outranks the default look) or a later default-look rule on the same selector.
          const overriddenIn = (p: MotionPref): boolean =>
            rules.some(
              (g) =>
                g !== r &&
                surelyAppliesIn(g.media, p) &&
                kindsOf(g.body)[kind] === false &&
                g.selectors.some((gs) =>
                  alternatives(gs).some(
                    (ga) =>
                      ga.pseudo === a.pseudo &&
                      (GATE.test(gs)
                        ? covers(ga, a)
                        : g.index > r.index && ga.anc === a.anc && covers(ga, a) && ga.tokens.size === a.tokens.size)
                  )
                )
            )
          if (gated || !mayApplyIn(r.media).every(overriddenIn)) bad.push(`${sel} (${kind})`)
        }
      }
    }
  }
  return [...new Set(bad)]
}

describe('Liquid Glass: no translucent fill without a blur', () => {
  const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')

  it('every glass fill in styles.css is paired with a working blur', () => {
    expect(glassFillsWithoutBlur(CSS)).toEqual([])
  })

  it('catches the pre-opt-in shape: panel tokens redefined to the fill on :root', () => {
    const tokens = `:root[data-nt-glass='on'] { --panel: var(--glass-chrome-bg); --surface-raised: var(--glass-chrome-bg); }`
    expect(glassFillsWithoutBlur(tokens)).toEqual([":root[data-nt-glass='on']"])
  })

  it('catches an unlisted surface given the fill, and accepts a listed or ::before-layered one', () => {
    const css = `
      :root[data-nt-glass='on'] :is(.menu, .drawer) { background: var(--glass-chrome-bg); backdrop-filter: var(--glass-text-blur); }
      :root[data-nt-glass='on'] .drawer:hover { background: linear-gradient(red, red), var(--glass-chrome-bg); }
      :root[data-nt-glass='on'] .host::before { background: var(--glass-chrome-bg); backdrop-filter: blur(20px); }
      :root[data-nt-glass='on'] .picker { background: var(--glass-chrome-bg); }
      :root[data-nt-glass='on'] .host { --x: var(--glass-control-bg); }
      :root[data-nt-glass='on'] .tip { background: var(--glass-chrome-bg); backdrop-filter: none; }`
    expect(glassFillsWithoutBlur(css)).toEqual([":root[data-nt-glass='on'] .picker", ":root[data-nt-glass='on'] .tip"])
  })

  it('code review 6 #5: the shapes the first version let through', () => {
    const g = ":root[data-nt-glass='on']"
    const css = `
      ${g} .a { background-image: linear-gradient(var(--glass-chrome-bg), var(--glass-chrome-bg)); }
      ${g} .b { background: var(--glass-chrome-bg); -webkit-backdrop-filter: blur(20px); backdrop-filter: none; }
      ${g} .c:hover { backdrop-filter: blur(20px); }
      ${g} .c { background: var(--glass-chrome-bg); }
      ${g} .m:not(.m--scroll)::before { backdrop-filter: blur(20px); }
      ${g} .m.m--scroll { background: var(--glass-chrome-bg); }
      ${g} .modal .menu { backdrop-filter: blur(20px); }
      ${g} .sidebar .menu { background: var(--glass-chrome-bg); }
      ${g} .modal .menu:hover { background: var(--glass-chrome-bg); }`
    expect(glassFillsWithoutBlur(css)).toEqual([`${g} .a`, `${g} .b`, `${g} .c`, `${g} .m.m--scroll`, `${g} .sidebar .menu`])
  })

  it('code review 7 #5: a later rule cancelling the blur on the same element', () => {
    const g = ":root[data-nt-glass='on']"
    const css = `
      ${g} .a { background: var(--glass-chrome-bg); backdrop-filter: blur(20px); }
      ${g} .a { backdrop-filter: none; }
      ${g} .b { background: var(--glass-chrome-bg); backdrop-filter: blur(20px); }
      .b { backdrop-filter: none; }
      ${g} .c { background: var(--glass-chrome-bg); backdrop-filter: blur(20px); }
      @media (prefers-reduced-transparency: reduce) { ${g} .c { backdrop-filter: none; } }`
    expect(glassFillsWithoutBlur(css)).toEqual([`${g} .a`])
  })

  it('the shared surface tokens are never redefined under the glass gate', () => {
    const redefined = parse(CSS)
      .filter((r) => r.selectors.some((s) => s.startsWith(":root[data-nt-glass='on']")))
      .flatMap((r) => [...r.body.matchAll(/(?:^|;)\s*(--(?:panel|panel-header|panel-2|surface-[\w-]+|tabbar-bg))\s*:/g)].map((d) => d[1]))
    expect(redefined).toEqual([])
  })
})

describe('Liquid Glass: glass never fades (visual QA round 4, N4-H1)', () => {
  const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
  const PROBE = readFileSync(join(__dirname, '../../scripts/glass-trap-probe.mjs'), 'utf8').replace(/\r\n/g, '\n')
  const SCRIMS = [...(/export const SCRIMS = \[([^\]]*)\]/.exec(PROBE)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])

  it('reads the scrim list from the live probe', () => {
    expect(SCRIMS).toContain('.palette-overlay')
    expect(SCRIMS).toContain('.kanban-modal-scrim')
  })

  it('no glass surface or scrim animates or transitions opacity under the glass gate', () => {
    expect(glassOpacityMotion(CSS, SCRIMS)).toEqual([])
  })

  it('catches opacity keyframes and transitions on glass and scrims, and accepts a gated override', () => {
    const g = ":root[data-nt-glass='on']"
    const css = `
      @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes slide { from { transform: translateY(4px); } }
      ${g} :is(.menu, .sheet) { background: var(--glass-chrome-bg); backdrop-filter: blur(20px); }
      .menu { animation: fade 0.12s ease-out; }
      ${g} .menu { animation-name: slide; }
      .sheet { animation: fade 0.12s; }
      .scrim { animation: fade 0.12s; }
      .sheet { transition: opacity 0.2s; }
      .menu__row { animation: fade 0.1s; }
      ${g} .menu:hover { transition: all 0.1s; }`
    expect(glassOpacityMotion(css, ['.scrim'])).toEqual([
      '.sheet (animation)',
      '.scrim (animation)',
      '.sheet (transition)',
      `${g} .menu:hover (transition)`,
    ])
  })

  it('code review 7 #2: an override inside a motion query counts only for that preference', () => {
    const g = ":root[data-nt-glass='on']"
    const css = `
      @keyframes fade { from { opacity: 0; } }
      @keyframes pop { from { transform: scale(0.97); } }
      ${g} :is(.modal, .sheet, .card, .tip) { background: var(--glass-chrome-bg); backdrop-filter: blur(20px); }
      .modal { animation: fade 0.16s; }
      @media (prefers-reduced-motion: no-preference) { ${g} .modal { animation-name: pop; } }
      .sheet { animation: fade 0.16s; }
      @media (prefers-reduced-motion: no-preference) { ${g} .sheet { animation-name: pop; } }
      @media (prefers-reduced-motion: reduce) { ${g} .sheet { animation: none; } }
      .card { animation: fade 0.16s; }
      @media (prefers-reduced-motion: no-preference) { ${g} .card { animation-name: pop; } }
      @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
      .tip { animation: fade 0.16s; }
      @media (max-width: 600px) { ${g} .tip { animation: none; } }`
    expect(glassOpacityMotion(css, [])).toEqual(['.modal (animation)', '.tip (animation)'])
  })

  it('code review 7 #3-#5: overlap either way, faded ::before layers, bare-timing transitions, -webkit- keyframes', () => {
    const g = ":root[data-nt-glass='on']"
    const css = `
      @-webkit-keyframes wfade { from { opacity: 0; } }
      ${g} .sheet.is-open { background: var(--glass-chrome-bg); backdrop-filter: blur(20px); }
      .sheet { animation: wfade 0.12s; }
      ${g} .modal .pane { background: var(--glass-chrome-bg); backdrop-filter: blur(20px); }
      .pane { transition: ease-out 0.2s; }
      ${g} .menu::before { content: ''; backdrop-filter: blur(20px); }
      .menu::before { transition: opacity 0.1s; }
      .menu::after { transition: opacity 0.1s; }
      .row { transition: opacity 0.1s; }
      ${g} .chip { background: var(--glass-chrome-bg); backdrop-filter: blur(20px); transition: background-color 0.1s ease-out, transform 0.1s; }`
    expect(glassOpacityMotion(css, [])).toEqual(['.sheet (animation)', '.pane (transition)', '.menu::before (transition)'])
  })

  it('a negative delay is still a timing value, not a property name (bare-timing transition)', () => {
    const g = ":root[data-nt-glass='on']"
    const css = `
      ${g} .pane { background: var(--glass-chrome-bg); backdrop-filter: blur(20px); }
      .pane { transition: 0.2s -0.05s; }`
    expect(glassOpacityMotion(css, [])).toEqual(['.pane (transition)'])
  })
})
