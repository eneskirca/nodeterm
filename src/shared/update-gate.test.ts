import { describe, expect, it } from 'vitest'
import {
  classifyUpdaterError,
  createUpdateGate,
  friendlyUpdateErrorMessage,
  isNewerVersion,
  nextDownloadRetryMs
} from './update-gate'

describe('isNewerVersion', () => {
  it.each([
    ['0.3.8', '0.3.7', true],
    ['0.3.7', '0.3.7', false],
    ['0.3.7', '0.3.8', false],
    ['1.0.0', '0.99.99', true],
    ['0.10.0', '0.9.0', true],
    ['v1.2', '1.1.9', true],
    ['1.0.0', '1.0.0-beta.2', true],
    ['1.0.0-beta.2', '1.0.0', false],
    ['1.0.0-beta.10', '1.0.0-beta.2', true],
    ['1.0.0-rc.1', '1.0.0-beta.9', true],
    ['garbage', '0.1.0', false],
    ['0.1.0', 'garbage', false]
  ])('%s newer than %s → %s', (a, b, want) => {
    expect(isNewerVersion(a, b)).toBe(want)
  })
})

describe('createUpdateGate', () => {
  it('a staged version repeating from the 6h re-check is swallowed: forwarded once, notified once', () => {
    const g = createUpdateGate()
    expect(g.onAvailable('1.1.0', { userInitiated: false })).toEqual({ forward: true, download: false })
    expect(g.onDownloaded('1.1.0')).toEqual({ forward: true, notify: true })
    expect(g.onAvailable('1.1.0', { userInitiated: false })).toEqual({ forward: false, download: false })
    expect(g.onDownloaded('1.1.0')).toEqual({ forward: false, notify: false })
    // Even a user check does not re-download the staged version.
    expect(g.onAvailable('1.1.0', { userInitiated: true })).toEqual({ forward: false, download: false })
  })

  it('a strictly newer release after staging is forwarded, downloaded on purpose and notified', () => {
    const g = createUpdateGate()
    g.onDownloaded('1.1.0')
    expect(g.onAvailable('1.2.0', { userInitiated: false })).toEqual({ forward: true, download: true })
    expect(g.onDownloaded('1.2.0')).toEqual({ forward: true, notify: true })
    expect(g.stagedVersion()).toBe('1.2.0')
    // An older straggler never replaces the staged one.
    expect(g.onDownloaded('1.1.0')).toEqual({ forward: false, notify: false })
  })

  it('a manual check while staged echoes the staged version', () => {
    const g = createUpdateGate()
    expect(g.onManualCheck()).toEqual({ echoDownloaded: null })
    g.onDownloaded('1.1.0')
    expect(g.onManualCheck()).toEqual({ echoDownloaded: '1.1.0' })
  })

  it('check-only builds (never staged) forward the first availability and swallow background repeats', () => {
    const g = createUpdateGate()
    expect(g.onAvailable('1.1.0', { userInitiated: false }).forward).toBe(true)
    expect(g.onAvailable('1.1.0', { userInitiated: false }).forward).toBe(false)
    // …but the user asking always gets the answer.
    expect(g.onAvailable('1.1.0', { userInitiated: true }).forward).toBe(true)
    expect(g.onAvailable('1.2.0', { userInitiated: false }).forward).toBe(true)
  })
})

describe('classifyUpdaterError', () => {
  it.each([
    ['auto-check', 'log'],
    ['auto-download', 'log'],
    ['manual-check', 'surface'],
    ['manual-download', 'surface'],
    ['install', 'surface']
  ] as const)('%s → %s', (origin, want) => {
    expect(classifyUpdaterError(origin)).toBe(want)
  })
})

describe('friendlyUpdateErrorMessage', () => {
  it('maps connectivity failures to a connection sentence', () => {
    for (const raw of [
      'net::ERR_INTERNET_DISCONNECTED',
      'Error: net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_NETWORK_CHANGED',
      'connect ETIMEDOUT 1.2.3.4:443',
      'read ECONNRESET'
    ])
      expect(friendlyUpdateErrorMessage(raw)).toMatch(/Couldn't reach the update server/)
  })

  it('maps feed 5xx / missing latest.yml to a server sentence', () => {
    expect(friendlyUpdateErrorMessage('HttpError: 503 Service Unavailable\n"method: GET url: …"')).toMatch(
      /temporarily unavailable/
    )
    expect(friendlyUpdateErrorMessage('HttpError: 404 \nCannot find latest-mac.yml')).toMatch(/temporarily unavailable/)
  })

  it('falls back to a trimmed first line', () => {
    expect(friendlyUpdateErrorMessage('Code signature did not pass validation\n  at x')).toBe(
      'Code signature did not pass validation'
    )
    expect(friendlyUpdateErrorMessage('')).toBe('The update could not be completed.')
    expect(friendlyUpdateErrorMessage('y'.repeat(500)).length).toBe(198)
  })
})

describe('nextDownloadRetryMs', () => {
  const MIN = 60 * 1000
  it('backs off 15/30/60/120 minutes, then hands back to the 6h tick', () => {
    expect([1, 2, 3, 4, 5].map(nextDownloadRetryMs)).toEqual([15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN, null])
  })

  it('every step is below six hours', () => {
    for (let i = 1; i <= 4; i++) expect(nextDownloadRetryMs(i)!).toBeLessThan(6 * 60 * MIN)
  })

  it('garbage counts schedule nothing', () => {
    expect(nextDownloadRetryMs(0)).toBeNull()
    expect(nextDownloadRetryMs(-1)).toBeNull()
    expect(nextDownloadRetryMs(1.5)).toBeNull()
  })
})
