import { describe, expect, it } from 'vitest'
import { INITIAL_CARD_STATE, cardVisible, nextCardState, type CardEvent, type CardState } from './updateCardState'

const run = (...events: CardEvent[]): CardState => events.reduce(nextCardState, INITIAL_CARD_STATE)

describe('automatic checks are quiet until downloaded', () => {
  it('an automatic available renders nothing, but is tracked', () => {
    const s = run({ type: 'available', version: '1.1.0' }, { type: 'progress', percent: 40 })
    expect(s.status).toEqual({ kind: 'available', version: '1.1.0', percent: 40, notes: undefined })
    expect(cardVisible(s)).toBe(false)
  })

  it('the download finishing opens the ready card', () => {
    const s = run({ type: 'available', version: '1.1.0' }, { type: 'downloaded', version: '1.1.0' })
    expect(s.status.kind).toBe('downloaded')
    expect(cardVisible(s)).toBe(true)
    expect(s.minimized).toBe(false)
  })

  it('a user check shows progress; closing it drops back to quiet tracking', () => {
    let s = run({ type: 'checking' }, { type: 'available', version: '1.1.0' })
    expect(cardVisible(s)).toBe(true)
    s = nextCardState(s, { type: 'dismiss' })
    expect(cardVisible(s)).toBe(false)
    expect(s.status.kind).toBe('available')
    s = nextCardState(s, { type: 'downloaded', version: '1.1.0' })
    expect(cardVisible(s)).toBe(true)
  })

  it('a user check during a quiet download reveals the progress card at its current percent', () => {
    const s = run({ type: 'available', version: '1.1.0' }, { type: 'progress', percent: 63 }, { type: 'checking' })
    expect(cardVisible(s)).toBe(true)
    expect(s.status).toMatchObject({ kind: 'available', percent: 63 })
  })

  it('an automatic "not available" says nothing; a user check gets its answer', () => {
    expect(run({ type: 'notAvailable' }).status.kind).toBe('idle')
    expect(run({ type: 'checking' }, { type: 'notAvailable' }).status.kind).toBe('upToDate')
  })
})

describe('never downgrade a staged update', () => {
  const staged = (): CardState => run({ type: 'available', version: '1.1.0' }, { type: 'downloaded', version: '1.1.0' })

  it('a repeat available for the same version keeps "ready"', () => {
    expect(nextCardState(staged(), { type: 'available', version: '1.1.0' }).status.kind).toBe('downloaded')
  })

  it('a newer release downloading behind it keeps "ready" until that one is ready', () => {
    let s = nextCardState(staged(), { type: 'available', version: '1.2.0' })
    expect(s.status).toMatchObject({ kind: 'downloaded', version: '1.1.0' })
    s = nextCardState(s, { type: 'downloaded', version: '1.2.0' })
    expect(s.status).toMatchObject({ kind: 'downloaded', version: '1.2.0' })
  })

  it('a minimized ready card stays minimized on a repeat', () => {
    const s = nextCardState(nextCardState(staged(), { type: 'minimize' }), { type: 'downloaded', version: '1.1.0' })
    expect(s.minimized).toBe(true)
  })

  it('a dismissed version is not resurrected by a background repeat, but is by a user check', () => {
    let s = nextCardState(staged(), { type: 'dismiss' })
    expect(s.status.kind).toBe('idle')
    s = nextCardState(s, { type: 'downloaded', version: '1.1.0' })
    expect(s.status.kind).toBe('idle')
    s = nextCardState(s, { type: 'available', version: '1.1.0' })
    expect(s.status.kind).toBe('idle')
    s = nextCardState(nextCardState(s, { type: 'checking' }), { type: 'downloaded', version: '1.1.0' })
    expect(s.status.kind).toBe('downloaded')
  })

  it('a newer version than the dismissed one still surfaces', () => {
    const s = run({ type: 'downloaded', version: '1.1.0' }, { type: 'dismiss' }, { type: 'downloaded', version: '1.2.0' })
    expect(s.status).toMatchObject({ kind: 'downloaded', version: '1.2.0' })
  })

  it('errors never overwrite ready or required', () => {
    expect(nextCardState(staged(), { type: 'error', message: 'x' }).status.kind).toBe('downloaded')
    const req = run({ type: 'policy', policy: { mandatory: true, minSupported: '0.9.0' } })
    expect(nextCardState(req, { type: 'error', message: 'x' }).status.kind).toBe('required')
  })
})

describe('restart feedback', () => {
  const staged = (): CardState => run({ type: 'downloaded', version: '1.1.0' })

  it('a click is preparing at once; main moves it to restarting', () => {
    let s = nextCardState(staged(), { type: 'restartClicked' })
    expect(s.status).toEqual({ kind: 'preparing', version: '1.1.0' })
    s = nextCardState(s, { type: 'installing', phase: 'preparing', version: '1.1.0' })
    s = nextCardState(s, { type: 'restartStalled' })
    expect(s.status.kind).toBe('preparing') // acknowledged: not stalled
    s = nextCardState(s, { type: 'installing', phase: 'restarting', version: '1.1.0' })
    expect(s.status).toEqual({ kind: 'restarting', version: '1.1.0' })
  })

  it('an unacknowledged click gives the button back', () => {
    const s = nextCardState(nextCardState(staged(), { type: 'restartClicked' }), { type: 'restartStalled' })
    expect(s.status.kind).toBe('downloaded')
  })

  it('an install failure returns to the ready card with the reason', () => {
    let s = nextCardState(staged(), { type: 'installing', phase: 'preparing', version: '1.1.0' })
    s = nextCardState(s, { type: 'error', message: 'signature' })
    expect(s.status).toEqual({ kind: 'downloaded', version: '1.1.0', installError: 'signature' })
  })

  it('a tray restart while the card is closed shows the phase', () => {
    const s = nextCardState(run({ type: 'downloaded', version: '1.1.0' }, { type: 'dismiss' }), {
      type: 'installing',
      phase: 'restarting',
      version: '1.1.0'
    })
    expect(cardVisible(s)).toBe(true)
  })
})

describe('the mandatory policy', () => {
  it('requires from idle / checking / error, and carries a quiet download\'s progress', () => {
    expect(run({ type: 'policy', policy: { mandatory: true, minSupported: '1.0.0' } }).status).toEqual({
      kind: 'required',
      minSupported: '1.0.0',
      percent: null
    })
    const s = run({ type: 'available', version: '1.1.0' }, { type: 'progress', percent: 20 }, {
      type: 'policy',
      policy: { mandatory: true, minSupported: '1.0.0' }
    })
    expect(s.status).toEqual({ kind: 'required', minSupported: '1.0.0', percent: 20 })
    expect(nextCardState(s, { type: 'progress', percent: 70 }).status).toMatchObject({ percent: 70 })
  })

  it('never overrides ready or the manual download card', () => {
    const p = { type: 'policy', policy: { mandatory: true, minSupported: '1.0.0' } } as const
    expect(run({ type: 'downloaded', version: '1.1.0' }, p).status.kind).toBe('downloaded')
    expect(run({ type: 'available', version: '1.1.0', manual: true }, p).status.kind).toBe('manual')
  })

  it('a real non-mandatory answer clears it; an empty read does not', () => {
    const req = run({ type: 'policy', policy: { mandatory: true, minSupported: '1.0.0' } })
    expect(nextCardState(req, { type: 'policy', policy: { mandatory: false, minSupported: null } }).status.kind).toBe(
      'required'
    )
    expect(nextCardState(req, { type: 'policy', policy: { mandatory: false, minSupported: '0.1.0' } }).status.kind).toBe(
      'idle'
    )
  })

  it('cannot be dismissed', () => {
    const req = run({ type: 'policy', policy: { mandatory: true, minSupported: '1.0.0' } })
    expect(nextCardState(req, { type: 'dismiss' }).status.kind).toBe('required')
  })
})

describe('manual (check-only) delivery', () => {
  it('opens its card on an automatic check — it is the only signal there is', () => {
    const s = run({ type: 'available', version: '1.1.0', manual: true })
    expect(cardVisible(s)).toBe(true)
  })

  it('a repeat does not un-minimize it', () => {
    const s = run({ type: 'available', version: '1.1.0', manual: true }, { type: 'minimize' }, {
      type: 'available',
      version: '1.1.0',
      manual: true
    })
    expect(s.minimized).toBe(true)
  })
})

describe('updated note', () => {
  it('shows only over an idle card and expires', () => {
    let s = run({ type: 'updated', version: '1.1.0' })
    expect(s.status).toEqual({ kind: 'updated', version: '1.1.0' })
    s = nextCardState(s, { type: 'updatedExpired' })
    expect(s.status.kind).toBe('idle')
    expect(run({ type: 'checking' }, { type: 'updated', version: '1.1.0' }).status.kind).toBe('checking')
  })
})
