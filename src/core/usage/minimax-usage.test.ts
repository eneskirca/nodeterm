import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  mapMinimaxLimits,
  mapMinimaxItem,
  cookieValue,
  isUsableMinimaxCookie,
  minimaxRejected,
  fetchMinimaxUsage
} from './minimax-usage'
import { readMinimaxCookie, writeMinimaxCookie, hasMinimaxCookie } from './minimax-cookie'
import { initPlatform, resetPlatformForTests, type CorePlatform } from '../platform'
import { primaryLimit, limitLabel } from '../../shared/usage-limits'

/**
 * NOTE: not captured from a live account — no MiniMax session was available on the machine this
 * was written on. Follows the field contract orca's fetcher documents.
 */
const BODY = {
  base_resp: { status_code: 0, status_msg: 'success' },
  model_remains: [
    {
      model_name: 'MiniMax-M2',
      current_interval_remaining_percent: 35,
      start_time: 1_784_400_000_000,
      end_time: 1_784_418_000_000
    },
    {
      model_name: 'MiniMax-Text-01',
      current_interval_remaining_percent: 80,
      start_time: 1_784_400_000_000,
      end_time: 1_784_418_000_000
    }
  ]
}

describe('cookieValue', () => {
  it('extracts a named cookie from a pasted header', () => {
    expect(cookieValue('a=1; _token=abc123; b=2', '_token')).toBe('abc123')
  })

  it('does not match a name that merely ends with the target', () => {
    expect(cookieValue('x_token=nope', '_token')).toBeNull()
  })

  it('returns null for an absent or valueless cookie', () => {
    expect(cookieValue('a=1', '_token')).toBeNull()
    expect(cookieValue('_token=', '_token')).toBeNull()
  })
})

describe('isUsableMinimaxCookie', () => {
  it('requires _token, which is what actually authenticates', () => {
    // Catching this here turns a mystifying 401 into an obvious "you copied the wrong header".
    expect(isUsableMinimaxCookie('sessionid=x; other=y')).toBe(false)
    expect(isUsableMinimaxCookie('sessionid=x; _token=abc')).toBe(true)
    expect(isUsableMinimaxCookie(null)).toBe(false)
    expect(isUsableMinimaxCookie('')).toBe(false)
  })
})

describe('mapMinimaxItem', () => {
  it('inverts remaining into used and labels by model', () => {
    const l = mapMinimaxItem(BODY.model_remains[0])
    expect(l).toMatchObject({
      kind: 'session_scoped',
      usedPercent: 65,
      scopeLabel: 'MiniMax-M2',
      windowMinutes: 300
    })
  })

  it('pins the window to the contracted 5h rather than deriving it', () => {
    // The API's end-start drifts below the bucket it sells (4h, 295 min, …).
    const l = mapMinimaxItem({
      model_name: 'M',
      current_interval_remaining_percent: 50,
      start_time: 0,
      end_time: 60_000
    })
    expect(l?.windowMinutes).toBe(300)
  })

  it('accepts numeric fields as strings', () => {
    expect(mapMinimaxItem({ model_name: 'M', current_interval_remaining_percent: '25' })?.usedPercent).toBe(75)
  })

  it('drops an entry with no model or no percentage', () => {
    expect(mapMinimaxItem({ current_interval_remaining_percent: 10 })).toBeNull()
    expect(mapMinimaxItem({ model_name: 'M' })).toBeNull()
    expect(mapMinimaxItem(null)).toBeNull()
  })

  it('reports no severity', () => {
    expect(mapMinimaxItem(BODY.model_remains[0])?.severity).toBeNull()
  })
})

describe('mapMinimaxLimits', () => {
  it('emits EVERY model, not one preferred pick', () => {
    // Orca selects a single model because its shape has one session slot; ours carries a list.
    const limits = mapMinimaxLimits(BODY)
    expect(limits.map((l) => l.scopeLabel)).toEqual(['MiniMax-M2', 'MiniMax-Text-01'])
  })

  it('labels rows by model without the UI knowing anything about MiniMax', () => {
    expect(limitLabel('session_scoped', 'MiniMax-M2')).toBe('MiniMax-M2')
  })

  it('leads with the most constrained model', () => {
    expect(primaryLimit(mapMinimaxLimits(BODY))?.scopeLabel).toBe('MiniMax-M2')
  })

  it('returns nothing for a junk body', () => {
    expect(mapMinimaxLimits(null)).toEqual([])
    expect(mapMinimaxLimits({})).toEqual([])
    expect(mapMinimaxLimits({ model_remains: 'nope' })).toEqual([])
  })
})

describe('minimaxRejected', () => {
  it('detects a failure reported inside an HTTP 200', () => {
    // An expired session shows up this way, not as a 401 — the usual stale-cookie path.
    expect(minimaxRejected({ base_resp: { status_code: 1004 } })).toBe(true)
    expect(minimaxRejected(BODY)).toBe(false)
    expect(minimaxRejected({})).toBe(false)
  })
})

describe('fetchMinimaxUsage', () => {
  it('reports unavailable without touching the network when no cookie is configured', async () => {
    await expect(fetchMinimaxUsage(null)).resolves.toMatchObject({
      provider: 'minimax',
      status: 'unavailable',
      limits: []
    })
  })

  it('reports unavailable for a cookie missing _token', async () => {
    await expect(fetchMinimaxUsage('a=1; b=2')).resolves.toMatchObject({ status: 'unavailable' })
  })
})

describe('minimax cookie storage', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-minimax-'))
    initPlatform({ userDataDir: dir } as unknown as CorePlatform)
  })

  afterEach(() => {
    resetPlatformForTests()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a cookie', async () => {
    await writeMinimaxCookie('_token=abc')
    await expect(readMinimaxCookie()).resolves.toBe('_token=abc')
    await expect(hasMinimaxCookie()).resolves.toBe(true)
  })

  it('stores it OUTSIDE settings.json, readable only by the owner', async () => {
    // The whole reason this is a separate file: settings.json is written with default
    // permissions, and this value is a live bearer credential, not config.
    await writeMinimaxCookie('_token=abc')
    const mode = fs.statSync(path.join(dir, 'minimax-cookie.json')).mode & 0o777
    expect(mode).toBe(0o600)
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false)
  })

  it('clears the stored cookie, leaving no file behind', async () => {
    await writeMinimaxCookie('_token=abc')
    await writeMinimaxCookie('')
    await expect(readMinimaxCookie()).resolves.toBeNull()
    await expect(hasMinimaxCookie()).resolves.toBe(false)
    expect(fs.existsSync(path.join(dir, 'minimax-cookie.json'))).toBe(false)
  })

  it('treats a whitespace-only paste as clearing, not as a cookie', async () => {
    await writeMinimaxCookie('   ')
    await expect(hasMinimaxCookie()).resolves.toBe(false)
  })

  it('reports no cookie rather than throwing on a corrupt file', async () => {
    fs.writeFileSync(path.join(dir, 'minimax-cookie.json'), '{{{')
    await expect(readMinimaxCookie()).resolves.toBeNull()
  })

  it('leaves no temp file behind after a write', async () => {
    await writeMinimaxCookie('_token=abc')
    expect(fs.readdirSync(dir)).toEqual(['minimax-cookie.json'])
  })
})
