import { describe, it, expect } from 'vitest'
import { mapCodexWindow, mapCodexLimits, readCodexAuth, codexHome } from './codex-usage'
import { primaryLimit, limitShortLabel } from '../../shared/usage-limits'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * The ChatGPT backend's `wham/usage` rate_limit block, matching Codex's own
 * RateLimitStatusPayload: `used_percent`, `limit_window_seconds` (the bucket's real duration)
 * and `reset_at` as Unix SECONDS.
 *
 * NOTE: unlike the Claude fixtures, this was NOT captured from a live account — no Codex
 * install or credentials were available on the machine this was written on. It follows the
 * field contract Codex's client uses; the numbers are illustrative.
 */
const BACKEND_RATE_LIMIT = {
  primary_window: { used_percent: 42.5, limit_window_seconds: 18_000, reset_at: 1_784_436_069 },
  secondary_window: { used_percent: 71, limit_window_seconds: 604_800, reset_at: 1_784_800_000 }
}

/** The app-server JSON-RPC shape: same facts, camelCase keys. */
const RPC_RATE_LIMITS = {
  primary: { usedPercent: 42.5, limitWindowSeconds: 18_000, resetsAt: 1_784_436_069 },
  secondary: { usedPercent: 71, limitWindowSeconds: 604_800, resetsAt: 1_784_800_000 }
}

describe('mapCodexLimits', () => {
  it('maps the backend snake_case payload', () => {
    const limits = mapCodexLimits(BACKEND_RATE_LIMIT)
    expect(limits.map((l) => l.kind)).toEqual(['session', 'weekly_all'])
    expect(limits[0].usedPercent).toBe(42.5)
    expect(limits[1].usedPercent).toBe(71)
  })

  it('maps the app-server camelCase payload identically', () => {
    // Both transports must normalize to the same thing, or which tier answered would leak
    // into the UI as a different-looking row.
    expect(mapCodexLimits(RPC_RATE_LIMITS)).toEqual(mapCodexLimits(BACKEND_RATE_LIMIT))
  })

  it('promotes Unix-seconds reset stamps to ms', () => {
    // Codex sends seconds; rendering them raw would put every reset in January 1970.
    expect(mapCodexLimits(BACKEND_RATE_LIMIT)[0].resetsAt).toBe(1_784_436_069_000)
  })

  it('takes the window duration from the payload, not from position', () => {
    // 18000s = 5h, 604800s = 7d.
    const limits = mapCodexLimits(BACKEND_RATE_LIMIT)
    expect(limits[0].windowMinutes).toBe(300)
    expect(limits[1].windowMinutes).toBe(10_080)
  })

  it('honours a non-standard bucket duration instead of assuming 5h', () => {
    // The backend varies this by plan; labelling a 7h window "5h" would be a lie.
    const limits = mapCodexLimits({
      primary_window: { used_percent: 10, limit_window_seconds: 25_200 }
    })
    expect(limits[0].windowMinutes).toBe(420)
  })

  it('rounds a partial minute up, matching Codex window_minutes_from_seconds', () => {
    const limits = mapCodexLimits({ primary_window: { used_percent: 1, limit_window_seconds: 90 } })
    expect(limits[0].windowMinutes).toBe(2)
  })

  it('falls back to the standard durations when the payload omits them', () => {
    const limits = mapCodexLimits({
      primary_window: { used_percent: 5 },
      secondary_window: { used_percent: 6 }
    })
    expect(limits[0].windowMinutes).toBe(300)
    expect(limits[1].windowMinutes).toBe(10_080)
  })

  it('reports NO severity so the bar falls back to percentage thresholds', () => {
    // Codex ships no severity. Defaulting it to 'normal' would paint an exhausted window green.
    for (const l of mapCodexLimits(BACKEND_RATE_LIMIT)) expect(l.severity).toBeNull()
  })

  it('drops a window with no usable percentage rather than emitting NaN', () => {
    const limits = mapCodexLimits({
      primary_window: { limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 50 }
    })
    expect(limits).toHaveLength(1)
    expect(limits[0].kind).toBe('weekly_all')
  })

  it('clamps out-of-range percentages', () => {
    expect(mapCodexLimits({ primary_window: { used_percent: 130 } })[0].usedPercent).toBe(100)
    expect(mapCodexLimits({ primary_window: { used_percent: -5 } })[0].usedPercent).toBe(0)
  })

  it('returns nothing for a junk block', () => {
    expect(mapCodexLimits(null)).toEqual([])
    expect(mapCodexLimits('nope')).toEqual([])
    expect(mapCodexLimits({})).toEqual([])
  })
})

describe('mapCodexWindow', () => {
  it('marks no window as gating, since Codex does not say', () => {
    const l = mapCodexWindow({ used_percent: 99 }, 'session', 'session', 300)
    expect(l?.isActive).toBe(false)
  })

  it('carries no scope label — Codex has no per-model caps', () => {
    const l = mapCodexWindow({ used_percent: 10 }, 'session', 'session', 300)
    expect(l?.scopeLabel).toBeNull()
  })
})

describe('shared helpers over Codex limits', () => {
  it('picks the worst window, since none is flagged active', () => {
    const picked = primaryLimit(mapCodexLimits(BACKEND_RATE_LIMIT))
    expect(picked?.kind).toBe('weekly_all')
    expect(picked?.usedPercent).toBe(71)
  })

  it('labels Codex windows with the same vocabulary as Claude', () => {
    const limits = mapCodexLimits(BACKEND_RATE_LIMIT)
    expect(limitShortLabel(limits[0].kind, limits[0].scopeLabel)).toBe('5h')
    expect(limitShortLabel(limits[1].kind, limits[1].scopeLabel)).toBe('wk')
  })
})

describe('readCodexAuth', () => {
  it('reads the access token and account id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-'))
    fs.writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'tok-abc', account_id: 'acct-1' } })
    )
    await expect(readCodexAuth(dir)).resolves.toEqual({
      accessToken: 'tok-abc',
      accountId: 'acct-1'
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns nulls for a missing or malformed file rather than throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-'))
    await expect(readCodexAuth(dir)).resolves.toEqual({ accessToken: null, accountId: null })
    fs.writeFileSync(path.join(dir, 'auth.json'), 'not json')
    await expect(readCodexAuth(dir)).resolves.toEqual({ accessToken: null, accountId: null })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('codexHome', () => {
  it('honours CODEX_HOME over the default', () => {
    const prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = '/tmp/custom-codex'
    expect(codexHome()).toBe('/tmp/custom-codex')
    process.env.CODEX_HOME = ''
    expect(codexHome()).toBe(path.join(os.homedir(), '.codex'))
    if (prev === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prev
  })
})
