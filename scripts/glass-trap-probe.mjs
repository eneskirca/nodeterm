#!/usr/bin/env node

/**
 * Liquid Glass trap probe: finds surfaces that are see-through WITHOUT a working blur.
 *
 * A translucent fill only reads as glass when the content behind it is blurred. It is a TRAP when:
 *   - it has no blur of its own and no blurred ancestor behind it, or
 *   - it floats (absolute/fixed/sticky) over the nearest blurred or solid ancestor's content —
 *     that content is sharp, and a blur inside a blurred ancestor samples only its pixels, or
 *   - it has its own blur but sits inside a BACKDROP ROOT (an ancestor with backdrop-filter, filter,
 *     opacity < 1, mask, mask-border, clip-path or a blend mode) and either reaches outside that
 *     root's box, or the root paints no blur of its own and nothing opaque lies between them: the
 *     blur then samples only the root's own pixels, and the page behind the root reads sharp
 *     through it (visual QA round 4, N4-H1: a scrim fading its opacity turned the palette inside it
 *     into clear glass for the whole fade).
 * `transform` and `isolation` are not backdrop roots (the React Flow viewport, `.dock`).
 * A fill is the background colour or any colour in a gradient `background-image`; `::before` and
 * `::after` layers are checked like elements.
 *
 * Two passes, both by default:
 *   - at rest: what is on screen now;
 *   - mid-animation: every finite CSS animation on the page is restarted and every finite RUNNING
 *     animation is set to half its duration, the page is scanned, and everything is put back. The
 *     open animations of overlays are 120–160 ms long; a probe that only looks at rest never sees
 *     them (QA round 4: both probes reported 0 with the palette scrim at opacity 0.17).
 *     It never calls pause()/play() (code review 7 #6: on a CSS animation they install a play-state
 *     override, and an infinite animation then stops obeying the idle gate, `--nt-anim-state`). The
 *     whole pass is one synchronous task, so the timeline cannot advance while it scans: seeking
 *     `currentTime` is enough to freeze a frame, and seeking back restores it exactly. Restarted
 *     elements get their `animation-name` re-set once more afterwards (a fresh animation, no API
 *     call on it ever) and lose the `style` attribute if they had none. The pass checks its own
 *     restoration — style attributes, and each untouched animation's play state and time — and
 *     the script exits 2 if anything was left behind.
 *
 * Usage (a dev build with remote debugging, e.g. `--remote-debugging-port=9333`):
 *   node scripts/glass-trap-probe.mjs [--port 9333 | --ws ws://…] [--rest | --mid-anim] [--json]
 * Open the overlay under test first; the probe checks what is on screen. Exits 1 on any trap, 2
 * when it could not check anything (no page, no answer within 20 s, Liquid Glass off, nothing
 * scanned) or failed its own restoration check — never a silent 0. It only reads computed styles
 * and replays animations the page already declares; it never clicks or types. That replay is not
 * fully inert, though: restarting an animation fires animationcancel/animationend on the page, and
 * the app can react to those the same as it would to a real one (e.g. the drawer refits maximized
 * nodes and marks the workspace dirty when one fires).
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Intentional full-window dims behind a modal, not glass. `styles.glass-traps.test.ts` reads this
 *  list too: a scrim around glass may fade its colour, never its opacity. */
export const SCRIMS = [
  '.palette-overlay',
  '.drawer-overlay',
  '.kanban-modal-scrim',
  '.confirm-overlay',
  '.sc-overlay',
  '.pubdlg-overlay',
  '.consent-overlay',
  '.mlaunch__backdrop',
  '.label-picker__scrim',
  '.phone-pair__backdrop',
  '.tab-backdrop',
  '.ctx-backdrop',
  '.dock-backdrop',
]

// Runs in the page (serialised with toString). Keep it self-contained.
export function glassTrapProbe(SCRIMS, midAnim) {
  const MIN_AREA = 300
  const alphaOf = (c) => {
    if (!c || c === 'transparent') return 0
    const slash = c.match(/\/\s*([\d.]+%?)\s*\)$/)
    if (slash) return slash[1].endsWith('%') ? parseFloat(slash[1]) / 100 : parseFloat(slash[1])
    const m = c.match(/^rgba\(([^)]+)\)$/)
    if (m) return parseFloat(m[1].split(',')[3])
    return 1
  }
  // A gradient fill counts like a colour: its most opaque stop (an image `url()` is content, not glass).
  const fillAlpha = (cs) => {
    let a = alphaOf(cs.backgroundColor)
    const img = cs.backgroundImage || 'none'
    if (img !== 'none' && !/url\(/.test(img))
      for (const c of img.match(/rgba?\([^)]*\)/g) || []) a = Math.max(a, alphaOf(c))
    return a
  }
  const blurs = (cs) => !!cs && /blur\(/.test(cs.backdropFilter || cs.webkitBackdropFilter || '')
  const pseudoOf = (el, p) => {
    const b = getComputedStyle(el, p)
    return b.content && b.content !== 'none' && b.display !== 'none' ? b : null
  }
  const none = (v) => !v || v === 'none'
  const isRoot = (el) => {
    const cs = getComputedStyle(el)
    return (
      !none(cs.backdropFilter) ||
      !none(cs.filter) ||
      parseFloat(cs.opacity) < 1 ||
      !none(cs.maskImage) ||
      !none(cs.webkitMaskImage) ||
      !none(cs.maskBorderSource) ||
      !none(cs.webkitMaskBoxImageSource) ||
      !none(cs.clipPath) ||
      cs.mixBlendMode !== 'normal' ||
      /filter|opacity|mask|clip-path|mix-blend/.test(cs.willChange)
    )
  }
  // Static frost (src/renderer/lib/glassFrost.ts): a glass terminal paints an opaque, blurred copy
  // of the wallpaper on a `.term-node__frost` child under its content instead of carrying a
  // backdrop-filter of its own. That layer is what shows behind the node's header and body.
  const frosted = (el) => {
    const f = el.querySelector(':scope > .term-node__frost')
    return !!f && getComputedStyle(f).display !== 'none' && /blur\(/.test(getComputedStyle(f, '::before').filter || '')
  }
  const hasBlur = (el) => blurs(getComputedStyle(el)) || blurs(pseudoOf(el, '::before')) || frosted(el)
  const floats = (el) => /absolute|fixed|sticky/.test(getComputedStyle(el).position)
  const opaque = (e) => alphaOf(getComputedStyle(e).backgroundColor) >= 0.9
  const inside = (a, b) => a.left >= b.left - 1 && a.top >= b.top - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1
  const name = (el) =>
    el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '')
  const visible = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false
    }
    return true
  }

  // Mid-animation: replay every finite animation the page declares, seek every finite running
  // animation to half way (no pause()/play() — see the header).
  const styleAttrs = () => new Map([...document.querySelectorAll('[style]')].map((e) => [e, e.getAttribute('style')]))
  const stylesBefore = midAnim ? styleAttrs() : null
  const untouched = midAnim ? document.getAnimations().map((a) => ({ a, state: a.playState, time: a.currentTime })) : []
  const replayed = []
  const frozen = []
  // The element's own CSS animations are replaced when its animation-name is re-set.
  const wasRestarted = (a) =>
    a instanceof CSSAnimation && !a.effect?.pseudoElement && replayed.some((r) => r.el === a.effect?.target)
  const restart = (el, prev) => {
    el.style.animationName = 'none'
    void getComputedStyle(el).animationName
    el.style.animationName = prev
  }
  const vw = innerWidth
  const vh = innerHeight
  const traps = []
  let checked = 0
  const check = (el, pseudo) => {
    if (SCRIMS.some((s) => el.matches(s))) return
    const cs = pseudo ? pseudoOf(el, pseudo) : getComputedStyle(el)
    if (!cs) return
    const a = fillAlpha(cs)
    if (a < 0.02 || a >= 0.9) return
    // What shows is the box clipped by scrolling/clipping ancestors (a long settings list scrolls
    // inside its sheet; the part past the sheet's edge is not painted).
    const b = el.getBoundingClientRect()
    const r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom }
    for (let e = el.parentElement; e; e = e.parentElement) {
      if (getComputedStyle(e).overflow === 'visible') continue
      const c = e.getBoundingClientRect()
      r.left = Math.max(r.left, c.left)
      r.top = Math.max(r.top, c.top)
      r.right = Math.min(r.right, c.right)
      r.bottom = Math.min(r.bottom, c.bottom)
    }
    const w = Math.min(r.right, vw) - Math.max(r.left, 0)
    const h = Math.min(r.bottom, vh) - Math.max(r.top, 0)
    if (w <= 0 || h <= 0 || w * h < MIN_AREA || !visible(el)) return
    checked++
    // A pseudo layer paints inside its element: its ancestor chain starts at the element itself.
    const chain = []
    for (let e = pseudo ? el : el.parentElement; e && e !== document.documentElement; e = e.parentElement) chain.push(e)
    const own = pseudo ? blurs(cs) : hasBlur(el)
    let why = null
    if (own) {
      const rootIdx = chain.findIndex(isRoot)
      const root = chain[rootIdx]
      // Its own opacity below 1 lays the page, sharp, under its blurred pixels.
      if (!pseudo && parseFloat(cs.opacity) < 0.99) why = `blurred surface fades its own opacity (${cs.opacity})`
      else if (root && !inside(r, root.getBoundingClientRect())) why = `blur escapes backdrop root ${name(root)}`
      else if (root && !blurs(getComputedStyle(root))) {
        // The root paints no blurred backdrop, so this blur sees only the root's own pixels: unless
        // something opaque lies under it inside the root, the page behind the root reads sharp.
        const between = chain.slice(pseudo ? 1 : 0, rootIdx + 1)
        if (!between.some((e) => opaque(e) && inside(r, e.getBoundingClientRect())))
          why = `blur inside see-through backdrop root ${name(root)} (opacity ${getComputedStyle(root).opacity})`
      }
    } else {
      // The nearest ancestor that paints something solid or blurred is what shows behind an
      // in-flow piece. A piece that FLOATS above that ancestor covers its content instead.
      const backIdx = chain.findIndex((e) => hasBlur(e) || opaque(e))
      if (backIdx < 0) why = 'no blur behind it'
      else {
        const back = chain[backIdx]
        const between = [el, ...chain.slice(0, backIdx)]
        if (!pseudo && between.some(floats)) why = `floats over ${name(back)}'s content`
        else if (!inside(r, back.getBoundingClientRect())) why = `outside ${name(back)}`
      }
    }
    if (why)
      traps.push({
        el: name(el) + (pseudo || ''),
        bg: cs.backgroundColor,
        why,
        box: [b.x, b.y, b.width, b.height].map(Math.round),
      })
  }
  try {
    if (midAnim) {
      for (const el of document.body.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        if (none(cs.animationName) || /infinite/.test(cs.animationIterationCount) || /paused/.test(cs.animationPlayState) || cs.display === 'none') continue
        const prev = el.style.animationName
        restart(el, prev)
        replayed.push({ el, prev, hadStyle: stylesBefore.has(el), before: stylesBefore.get(el) })
      }
      void document.body.offsetWidth
      for (const a of document.getAnimations()) {
        const t = a.effect?.getTiming?.()
        if (!t || t.iterations === Infinity || a.playState !== 'running') continue
        const d = typeof t.duration === 'number' ? t.duration : a.effect.getComputedTiming().duration
        frozen.push({ a, time: a.currentTime })
        a.currentTime = (t.delay || 0) + (d || 0) / 2
      }
    }
    for (const el of document.body.querySelectorAll('*')) {
      check(el, null)
      check(el, '::before')
      check(el, '::after')
    }
  } finally {
    // Restarted elements: a fresh animation replaces the seeked one (it plays its entrance once
    // more, as when the overlay opened). Everything else: seek back to where it was.
    for (const { a, time } of frozen) if (!wasRestarted(a)) a.currentTime = time
    // An element that already had a style attribute is restored to that EXACT attribute (not by
    // poking el.style.animationName again, which only ever touched that one property and can drift
    // from what was actually there); one that had none simply loses the attribute the probe put on.
    for (const { el, prev, hadStyle, before } of replayed) {
      restart(el, prev)
      if (hadStyle) el.setAttribute('style', before)
      else el.removeAttribute('style')
    }
  }
  // Self-check: nothing left behind.
  const leftovers = []
  if (midAnim) {
    const after = styleAttrs()
    for (const [e, v] of after) if (stylesBefore.get(e) !== v) leftovers.push(`style changed on ${name(e)}`)
    for (const [e] of stylesBefore) if (!after.has(e)) leftovers.push(`style removed from ${name(e)}`)
    const same = (x, y) => x === y || (x != null && y != null && Math.abs(x - y) < 0.01)
    for (const { a, state, time } of untouched) {
      if (wasRestarted(a)) continue
      if (a.playState !== state || !same(a.currentTime, time)) leftovers.push(`animation ${a.animationName || a.id || '?'} on ${a.effect?.target ? name(a.effect.target) : '?'} not restored`)
    }
  }
  return {
    glass: document.documentElement.dataset.ntGlass === 'on',
    pass: midAnim ? 'mid-animation' : 'rest',
    checked,
    animations: frozen.length,
    traps,
    leftovers,
  }
}

async function evaluate(ws, expression, ms = 20000) {
  const sock = new WebSocket(ws)
  return new Promise((resolve, reject) => {
    // A page that never answers (paused in a debugger, hung renderer) is "could not check": exit 2.
    const timer = setTimeout(() => {
      reject(new Error(`no answer from ${ws} within ${ms / 1000}s`))
      sock.close()
    }, ms)
    sock.onclose = () => clearTimeout(timer)
    sock.onerror = () => reject(new Error(`cannot connect to ${ws}`))
    sock.onopen = () => sock.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    sock.onmessage = (m) => {
      const r = JSON.parse(m.data)
      if (r.id !== 1) return
      sock.close()
      if (r.result?.exceptionDetails) reject(new Error(r.result.exceptionDetails.exception?.description))
      else resolve(r.result.result.value)
    }
  })
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
  let ws = opt('--ws')
  if (!ws) {
    const port = opt('--port') ?? '9333'
    const pages = await (await fetch(`http://localhost:${port}/json`, { signal: AbortSignal.timeout(5000) })).json()
    ws = pages.find((p) => p.type === 'page' && !p.url.includes('hud'))?.webSocketDebuggerUrl
    if (!ws) throw new Error(`no app page on port ${port}`)
  }
  // Everything printed below comes back from the page over CDP. Strip line breaks and other control
  // characters so a value cannot forge extra log lines or terminal escapes.
  const clean = (v) => String(v).replace(/[\r\n]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '')
  const passes = args.includes('--rest') ? [false] : args.includes('--mid-anim') ? [true] : [false, true]
  const results = []
  for (const mid of passes)
    results.push(await evaluate(ws, `(${glassTrapProbe.toString()})(${JSON.stringify(SCRIMS)}, ${mid})`))
  if (args.includes('--json')) console.log(JSON.stringify(results))
  let traps = 0
  let blind = false
  for (const r of results) {
    traps += r.traps.length
    if (!r.glass || r.checked === 0 || r.leftovers.length) blind = true
    for (const l of r.leftovers) console.error(`probe left state behind: ${clean(l)}`)
    if (args.includes('--json')) continue
    if (!r.glass) console.log('Liquid Glass is not on (data-nt-glass) — nothing glass to check')
    console.log(`${clean(r.pass)}: ${clean(r.traps.length)} trap(s) in ${clean(r.checked)} translucent surface(s)${r.pass === 'mid-animation' ? `, ${clean(r.animations)} animation(s) seeked to 50%, restored` : ''}`)
    for (const t of r.traps) console.log(`  ${clean(t.el)}  ${clean(t.bg)}  ${clean(t.why)}  [${clean(t.box.join(','))}]`)
  }
  process.exit(traps ? 1 : blind ? 2 : 0)
}

// Run only as a script — resolved through symlinks, so a linked or URL-encoded path is still
// recognised (a false "not main" used to exit 0 without checking anything).
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain)
  main().catch((e) => {
    console.error(String(e?.message ?? e).replace(/[\r\n]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ''))
    process.exit(2)
  })
