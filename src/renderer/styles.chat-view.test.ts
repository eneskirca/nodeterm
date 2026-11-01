import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Same idiom as styles.kanban.test.ts: read the checked-in stylesheet (CRLF-normalized, comments
// stripped so a rule's own comment cannot satisfy — or break — the match) and pin the declarations
// a layout depends on.
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** The body of the FIRST rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = CSS.match(new RegExp(`(?:^|\\n)${esc}\\s*{([^}]*)}`))
  expect(m, `rule not found: ${selector}`).toBeTruthy()
  return m![1]
}

describe('⌘M chat tool row layout (tool name rendered one letter per line)', () => {
  it('the summary row is a flex row — the reason the two children below must be sized explicitly', () => {
    expect(ruleBody('.term-chat__tool summary')).toMatch(/display:\s*flex;/)
  })

  it('never shrinks or wraps the tool NAME, however long the argument beside it', () => {
    const name = ruleBody('.term-chat__tool-name')
    expect(name).toMatch(/flex:\s*0 0 auto;/)
    expect(name).toMatch(/white-space:\s*nowrap;/)
  })

  it('lets the ARGUMENT shrink below its content width, so its own ellipsis does the truncating', () => {
    const arg = ruleBody('.term-chat__tool-arg')
    expect(arg).toMatch(/flex:\s*1 1 auto;/)
    expect(arg).toMatch(/min-width:\s*0;/)
    expect(arg).toMatch(/text-overflow:\s*ellipsis;/)
    expect(arg).toMatch(/white-space:\s*nowrap;/)
  })
})

describe('nt-spinner', () => {
  it('spins with a CSS keyframe (no dependency) that honours the app-wide animation pause', () => {
    const body = ruleBody('.nt-spinner')
    expect(body).toMatch(/animation:\s*nt-spinner-rotate\b[^;]*infinite;/)
    expect(body).toMatch(/animation-play-state:\s*var\(--nt-anim-state\);/)
    expect(CSS).toMatch(/@keyframes nt-spinner-rotate\s*{/)
  })

  it('is a STATIC indicator under prefers-reduced-motion — still visible, no rotation', () => {
    const blocks = [...CSS.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*{([\s\S]*?)\n}/g)].map((m) => m[1])
    const mine = blocks.find((b) => /\.nt-spinner\s*{/.test(b))
    expect(mine, 'no reduced-motion rule for .nt-spinner').toBeTruthy()
    expect(mine).toMatch(/\.nt-spinner\s*{[^}]*animation:\s*none;/)
    // Not hidden: a frozen ring still says "working", an absent one says nothing.
    expect(mine).not.toMatch(/\.nt-spinner\s*{[^}]*(display:\s*none|visibility:\s*hidden|opacity:\s*0;)/)
  })
})

describe('⌘M thread: claude.ai look', () => {
  it('the user message is a neutral rounded bubble on the right — not the blue accent', () => {
    const user = ruleBody('.term-chat__msg--user')
    expect(user).toMatch(/align-self:\s*flex-end;/)
    expect(user).not.toMatch(/--accent/)
    expect(user).toMatch(/max-width:\s*80%;/)
    expect(user).toMatch(/border-radius:\s*\d+px;/)
    expect(user).toMatch(/background:/)
  })

  it('the assistant message has no bubble: full width, no fill, roomy line height', () => {
    const a = ruleBody('.term-chat__msg--assistant')
    expect(a).toMatch(/max-width:\s*none;/)
    expect(a).toMatch(/background:\s*none;/)
    expect(a).toMatch(/line-height:\s*1\.6/)
  })

  it('the action row is hidden until hover/focus, and always shown on the latest turn', () => {
    expect(ruleBody('.term-chat__actions')).toMatch(/opacity:\s*0;/)
    expect(CSS).toMatch(/\.term-chat__msg:hover \.term-chat__actions,\s*\n?\s*\.term-chat__actions:focus-within,\s*\n?\s*\.term-chat__actions--latest\s*{[^}]*opacity:\s*1;/)
  })

  it('a folded message collapses to its action row', () => {
    const folded = ruleBody('.term-chat__msg--folded')
    expect(folded).toMatch(/padding:\s*0;/)
    expect(folded).toMatch(/min-height:\s*0;/)
  })
})

describe('the shared .term-chat__input (plan "Revise…", question "Other") keeps a visible field', () => {
  it('the base rule is a bordered, padded, tinted field', () => {
    const base = ruleBody('.term-chat__input')
    expect(base).toMatch(/padding:\s*8px;/)
    expect(base).toMatch(/border:\s*1px solid/)
    expect(base).toMatch(/border-radius:\s*8px;/)
    expect(base).toMatch(/background:\s*rgba\(var\(--tint-rgb\)/)
  })

  it('it shows focus (the accent border) — a borderless reset here was an a11y regression', () => {
    expect(ruleBody('.term-chat__input:focus')).toMatch(/border-color:\s*var\(--accent\);/)
  })

  it('only the COMPOSER textarea drops its border (the box around it owns the focus ring)', () => {
    const composer = ruleBody('.term-chat__composer-input')
    expect(composer).toMatch(/border:\s*none;/)
    expect(composer).toMatch(/background:\s*transparent;/)
    expect(ruleBody('.term-chat__composer:focus-within')).toMatch(/border-color:\s*var\(--accent\);/)
  })

  it('the last paragraph of an assistant message has no trailing margin (specificity over the generic rule)', () => {
    expect(ruleBody('.term-chat__msg--assistant .term-chat__text > p:last-child')).toMatch(/margin-bottom:\s*0;/)
  })
})

describe('⌘M code block syntax colors', () => {
  it('a colored block keeps its whitespace: the code is split across token spans', () => {
    expect(ruleBody('.term-chat__text pre code[data-highlighted]')).toMatch(/white-space:\s*pre;/)
  })
})
