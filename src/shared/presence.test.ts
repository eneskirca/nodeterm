import { describe, it, expect } from 'vitest'
import {
  BIDI_CONTROL_CHARS,
  PRESENCE_COLORS,
  capCodePoints,
  defaultNameFor,
  nextFreeColor,
  peersOnProject,
  sanitizeIdentity,
  sanitizeDinoPayload,
  DINO_MAX_OBSTACLES,
  REF_MAX_LEN,
  CHAT_MAX_LEN,
  NAME_MAX_LEN,
  type PeerDiff,
  type PeerState
} from './presence'

function peer(clientId: number, projectId: string | null): PeerState {
  return {
    clientId,
    name: `P${clientId}`,
    color: PRESENCE_COLORS[0],
    cursor: { x: 0, y: 0 },
    focus: null,
    chat: null,
    typing: null,
    projectId,
    dino: null,
    kind: 'browser'
  }
}

describe('presence palette', () => {
  it('hands out the first unused color, then wraps around when the palette is exhausted', () => {
    expect(nextFreeColor([])).toBe(PRESENCE_COLORS[0])
    expect(nextFreeColor([PRESENCE_COLORS[0]])).toBe(PRESENCE_COLORS[1])
    expect(nextFreeColor([PRESENCE_COLORS[1]])).toBe(PRESENCE_COLORS[0])
  })

  it('wraps by taken-count once every color is in use (the exact documented rule)', () => {
    // Every color taken → the (n+1)-th peer reuses PRESENCE_COLORS[taken.length % length]
    // rather than going colorless. Pin the exact color: "some palette color" would also pass
    // for a random-color implementation.
    const all = [...PRESENCE_COLORS]
    expect(nextFreeColor(all)).toBe(PRESENCE_COLORS[all.length % PRESENCE_COLORS.length])
    expect(nextFreeColor(all)).toBe(PRESENCE_COLORS[0])
    expect(nextFreeColor([...all, PRESENCE_COLORS[0]])).toBe(PRESENCE_COLORS[1])
    expect(nextFreeColor([...all, PRESENCE_COLORS[0], PRESENCE_COLORS[1]])).toBe(PRESENCE_COLORS[2])
  })

  it('is a readonly palette (no consumer can corrupt color assignment app-wide)', () => {
    // @ts-expect-error PRESENCE_COLORS is readonly — pushing into it must not typecheck.
    expect(() => PRESENCE_COLORS.push('#000000')).toBeDefined()
    // Callers stay unconstrained: a mutable array is still an acceptable `taken` argument.
    const mutable: string[] = [PRESENCE_COLORS[0]]
    expect(nextFreeColor(mutable)).toBe(PRESENCE_COLORS[1])
  })
})

describe('PeerDiff (wire contract)', () => {
  it('cannot rewrite the identity key through an update patch', () => {
    const ok: PeerDiff = { op: 'update', clientId: 3, patch: { focus: 'n1', chat: 'hi' } }
    expect(ok.op).toBe('update')
    // @ts-expect-error an update patch must not be able to reassign clientId.
    const bad: PeerDiff = { op: 'update', clientId: 3, patch: { clientId: 7 } }
    expect(bad).toBeDefined()
  })
})

describe('defaultNameFor', () => {
  it('names a phone "Phone" and anything else "Someone" until presence:hello arrives', () => {
    expect(defaultNameFor('phone')).toBe('Phone')
    expect(defaultNameFor('browser')).toBe('Someone')
    expect(defaultNameFor('desktop')).toBe('Someone')
  })
})

describe('sanitizeIdentity', () => {
  const fallback = { name: 'Someone', color: PRESENCE_COLORS[0] }

  it('trims and caps the name, and keeps a palette color', () => {
    expect(sanitizeIdentity({ name: '  Enes  ', color: PRESENCE_COLORS[2] }, fallback)).toEqual({
      name: 'Enes',
      color: PRESENCE_COLORS[2]
    })
    const long = 'x'.repeat(200)
    expect(sanitizeIdentity({ name: long, color: PRESENCE_COLORS[1] }, fallback).name).toHaveLength(
      NAME_MAX_LEN
    )
  })

  it('falls back on junk: non-object, empty name, off-palette or non-string color', () => {
    expect(sanitizeIdentity(null, fallback)).toEqual(fallback)
    expect(sanitizeIdentity({ name: '   ', color: PRESENCE_COLORS[1] }, fallback).name).toBe(
      fallback.name
    )
    expect(sanitizeIdentity({ name: 'Enes', color: 'javascript:alert(1)' }, fallback).color).toBe(
      fallback.color
    )
    expect(sanitizeIdentity({ name: 'Enes', color: 42 }, fallback).color).toBe(fallback.color)
  })

  it('caps by code point, never splitting an astral-plane character in half', () => {
    // 31 ASCII + 2 emoji: the cap lands mid-emoji. Cutting by UTF-16 code unit would leave a
    // lone surrogate, which every peer's facepile renders as "�".
    const name = 'x'.repeat(NAME_MAX_LEN - 1) + '😀😀'
    const out = sanitizeIdentity({ name, color: PRESENCE_COLORS[0] }, fallback).name
    expect(out).toBe('x'.repeat(NAME_MAX_LEN - 1) + '😀')
    expect([...out]).toHaveLength(NAME_MAX_LEN)
    expect(out).not.toMatch(/[\uD800-\uDFFF]/u) // no unpaired surrogate survived
    expect(out).not.toContain('�')
  })

  // Names are unverified BY DESIGN (anyone may claim any name), but they must not be able to
  // MISRENDER: this is the one untrusted-input door into every peer's facepile and cursor label.
  // The hostile characters are written as escapes on purpose - pasted raw, they would reorder this
  // very source file in your editor, which is exactly the attack.
  it('strips control characters, newlines and bidi overrides (no visual name spoofing)', () => {
    const RLO = '‮' // RIGHT-TO-LEFT OVERRIDE: displays everything after it backwards
    // Stored as "Ada" + RLO + "gnihsihp", this DISPLAYS as "Adaphishing" in every facepile.
    expect(
      sanitizeIdentity({ name: `Ada${RLO}gnihsihp`, color: PRESENCE_COLORS[0] }, fallback).name
    ).toBe('Adagnihsihp')

    // The whole bidi family - marks, embeddings, overrides, isolates - plus the zero-width space
    // and the BOM.
    const bidi = 'A​‎‏‪‫‬‭‮B⁦⁧⁨⁩C﻿'
    expect(sanitizeIdentity({ name: bidi, color: PRESENCE_COLORS[0] }, fallback).name).toBe('ABC')

    // C0/C1 controls and newlines (a multi-line name would break out of its one-line chip).
    // Ordinary spaces INSIDE the name survive - only the control characters go.
    expect(
      sanitizeIdentity({ name: 'Ada\n\r\tLove lace', color: PRESENCE_COLORS[0] }, fallback).name
    ).toBe('AdaLove lace')

    // Nothing left after stripping -> the fallback, never an empty label.
    expect(
      sanitizeIdentity({ name: `${RLO}​\n`, color: PRESENCE_COLORS[0] }, fallback).name
    ).toBe(fallback.name)

    // Legitimate names (spaces, accents, CJK, emoji) are untouched.
    const real = 'Enes Kırca 库 🐙'
    expect(sanitizeIdentity({ name: real, color: PRESENCE_COLORS[0] }, fallback).name).toBe(real)
  })

  it('strips the Arabic letter mark too (U+061C, a bidi control), and only bidi from BIDI_CONTROL_CHARS', () => {
    expect(sanitizeIdentity({ name: 'Ada\u061cLove', color: PRESENCE_COLORS[0] }, fallback).name).toBe('AdaLove')
    const text = 'a\u061cb\u200ec\u202ed\u2069e \u{1F468}\u200d\u{1F469}\u200b'
    expect(text.replace(BIDI_CONTROL_CHARS, '')).toBe('abcde \u{1F468}\u200d\u{1F469}\u200b')
  })

  it('trims after truncating, so a cap landing on a space leaves no trailing space', () => {
    const name = 'a'.repeat(NAME_MAX_LEN - 1) + ' tail'
    const out = sanitizeIdentity({ name, color: PRESENCE_COLORS[0] }, fallback).name
    expect(out).toBe('a'.repeat(NAME_MAX_LEN - 1))
  })
})

describe('capCodePoints (the one truncation rule — and the one untrusted-length door)', () => {
  it('caps by code point and leaves a short string alone', () => {
    expect(capCodePoints('hello', 10)).toBe('hello')
    expect(capCodePoints('hello', 3)).toBe('hel')
    expect(capCodePoints('', 3)).toBe('')
    expect(capCodePoints('abc', 0)).toBe('')
  })

  it('never cuts a surrogate pair in half, wherever the cap lands', () => {
    // Every code point is astral: the cap in code UNITS would be 2× the cap in code POINTS, so an
    // implementation that bounds the input by code units must still not hand back half a pair.
    const emoji = '😀'.repeat(500)
    const out = capCodePoints(emoji, 200)
    expect([...out]).toHaveLength(200)
    expect(out).toBe('😀'.repeat(200))
    expect(out).not.toMatch(/[\uD800-\uDFFF]/u)

    // A pair straddling the max*2 code-unit boundary of a bounded implementation.
    const straddle = 'a' + '😀'.repeat(500)
    const cut = capCodePoints(straddle, 200)
    expect([...cut]).toHaveLength(200)
    expect(cut).toBe('a' + '😀'.repeat(199))
    expect(cut).not.toMatch(/[\uD800-\uDFFF]/u)
  })

  it('caps a huge hostile string WITHOUT materializing it (cost is O(max), not O(input))', () => {
    // A client can cast a `presence:chat` of whatever size the socket accepts. The old
    // `[...text].slice(0, max)` spread the WHOLE string into an array of code points first: for a
    // 40 MB frame that is ~20M array elements — seconds of blocked event loop and ~1 GB of heap,
    // i.e. a trivial remote DoS on the shared Server Edition process. Bounding the input first
    // makes the work proportional to `max`, so this is milliseconds.
    const hostile = 'a'.repeat(40_000_000)
    const started = performance.now()
    const out = capCodePoints(hostile, CHAT_MAX_LEN)
    const elapsed = performance.now() - started
    expect(out).toBe('a'.repeat(CHAT_MAX_LEN))
    // Generous by two orders of magnitude: the bounded implementation runs in µs, while the
    // spreading one cannot get near this even on a fast machine.
    expect(elapsed).toBeLessThan(200)
  })
})

describe('peersOnProject (the one project filter: cursors, bubbles, node chips)', () => {
  const peers = [peer(1, 'web'), peer(2, 'api'), peer(3, null), peer(4, 'web')]

  it('keeps only the peers on the same canvas', () => {
    expect(peersOnProject(peers, 'web').map((p) => p.clientId)).toEqual([1, 4])
    expect(peersOnProject(peers, 'api').map((p) => p.clientId)).toEqual([2])
  })

  it('draws nothing when no project is open (welcome screen) and never matches a null peer', () => {
    expect(peersOnProject(peers, null)).toEqual([])
    // A peer with no project open must not leak onto anyone's canvas.
    expect(peersOnProject(peers, 'web').some((p) => p.projectId === null)).toBe(false)
  })
})

describe('sanitizeDinoPayload (the one door for an untrusted dino cast)', () => {
  const validSnap = {
    y: -10,
    ducking: false,
    crashed: false,
    started: true,
    score: 7,
    speed: 6,
    groundScroll: 33,
    obstacles: [{ kind: 'cactus', x: 200, y: 0, sx: 4, sw: 20, sh: 40, flap: 0 }]
  }

  it('passes a well-formed payload through, capping the nodeId', () => {
    const out = sanitizeDinoPayload({ nodeId: 'dino-a', snap: validSnap })
    expect(out).toEqual({ nodeId: 'dino-a', snap: validSnap })
    // The nodeId is a reflected ref like focus → capped at REF_MAX_LEN.
    const long = sanitizeDinoPayload({ nodeId: 'n'.repeat(REF_MAX_LEN + 500), snap: validSnap })
    expect(long?.nodeId).toBe('n'.repeat(REF_MAX_LEN))
  })

  it('clamps obstacles to the first DINO_MAX_OBSTACLES', () => {
    const many = Array.from({ length: DINO_MAX_OBSTACLES + 10 }, (_, i) => ({
      kind: 'bird' as const,
      x: i,
      y: 0,
      sx: 0,
      sw: 1,
      sh: 1,
      flap: 0
    }))
    const out = sanitizeDinoPayload({ nodeId: 'd', snap: { ...validSnap, obstacles: many } })
    expect(out?.snap.obstacles).toHaveLength(DINO_MAX_OBSTACLES)
    expect(out?.snap.obstacles.map((o) => o.x)).toEqual(
      Array.from({ length: DINO_MAX_OBSTACLES }, (_, i) => i)
    )
  })

  it('coerces non-finite numbers to 0 and booleans, for the snap and each obstacle', () => {
    const out = sanitizeDinoPayload({
      nodeId: 'd',
      snap: {
        y: Number.NaN,
        ducking: 'yes',
        crashed: 0,
        started: 1,
        score: Number.POSITIVE_INFINITY,
        speed: '6',
        groundScroll: null,
        obstacles: [{ kind: 'cactus', x: 'oops', y: Number.NaN, sx: 1, sw: 2, sh: 3, flap: 4 }]
      }
    })
    expect(out?.snap).toMatchObject({
      y: 0,
      ducking: true,
      crashed: false,
      started: true,
      score: 0,
      speed: 6, // Number('6') → 6
      groundScroll: 0
    })
    expect(out?.snap.obstacles[0]).toEqual({ kind: 'cactus', x: 0, y: 0, sx: 1, sw: 2, sh: 3, flap: 4 })
  })

  it('drops an obstacle whose kind is not cactus|bird', () => {
    const out = sanitizeDinoPayload({
      nodeId: 'd',
      snap: {
        ...validSnap,
        obstacles: [
          { kind: 'ufo', x: 1, y: 0, sx: 0, sw: 1, sh: 1, flap: 0 },
          { kind: 'bird', x: 2, y: 0, sx: 0, sw: 1, sh: 1, flap: 0 },
          { x: 3, y: 0, sx: 0, sw: 1, sh: 1, flap: 0 } // no kind
        ]
      }
    })
    expect(out?.snap.obstacles).toEqual([{ kind: 'bird', x: 2, y: 0, sx: 0, sw: 1, sh: 1, flap: 0 }])
  })

  it('returns null for anything malformed (missing/empty nodeId, non-object, missing snap)', () => {
    expect(sanitizeDinoPayload(null)).toBeNull()
    expect(sanitizeDinoPayload('nope')).toBeNull()
    expect(sanitizeDinoPayload(42)).toBeNull()
    expect(sanitizeDinoPayload({})).toBeNull()
    expect(sanitizeDinoPayload({ snap: validSnap })).toBeNull() // no nodeId
    expect(sanitizeDinoPayload({ nodeId: '', snap: validSnap })).toBeNull() // empty nodeId
    expect(sanitizeDinoPayload({ nodeId: 5, snap: validSnap })).toBeNull() // non-string nodeId
    expect(sanitizeDinoPayload({ nodeId: 'd' })).toBeNull() // no snap
    expect(sanitizeDinoPayload({ nodeId: 'd', snap: null })).toBeNull() // null snap
    expect(sanitizeDinoPayload({ nodeId: 'd', snap: 'bad' })).toBeNull() // non-object snap
  })

  it('tolerates a missing/non-array obstacles field (empty list, not null)', () => {
    expect(sanitizeDinoPayload({ nodeId: 'd', snap: { ...validSnap, obstacles: undefined } })?.snap.obstacles).toEqual([])
    expect(sanitizeDinoPayload({ nodeId: 'd', snap: { ...validSnap, obstacles: 'x' } })?.snap.obstacles).toEqual([])
  })
})
