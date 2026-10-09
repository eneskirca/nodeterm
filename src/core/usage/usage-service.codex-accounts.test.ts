// Per-account Codex usage aggregation (S6 §4.3, Property 9): each managed account's usage is
// fetched against its OWN home and stamped with its OWN accountId, and the rows are NEVER merged
// or de-duplicated in the service — so one account's numbers can never collapse into, or be
// attributed to, another. Ambiguity / a read error fails closed to an EMPTY row for that account,
// never a fabricated account and never another account's numbers.
//
// fetchCodexUsage is mocked so these tests exercise the SERVICE's fan-out, keying and cache
// fingerprint — not the HTTP/app-server transports (those are covered in codex-usage.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { ProviderUsage } from '../../shared/types'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform, type FakePlatform } from '../platform-fake'

const { fetchCodexUsage } = vi.hoisted(() => ({
  fetchCodexUsage: vi.fn(
    async (
      home?: string,
      identity?: { id?: string; label?: string | null; email?: string | null }
    ): Promise<ProviderUsage> => ({
      provider: 'codex',
      accountId: identity?.id,
      account: identity?.email ?? identity?.label ?? null,
      limits: [],
      updatedAt: Date.now(),
      status: 'ok'
    })
  )
}))

vi.mock('./codex-usage', () => ({ fetchCodexUsage }))
vi.mock('./cursor-usage', () => ({ fetchCursorUsage: async () => unavailableRow('cursor') }))
vi.mock('./gemini-usage', () => ({ fetchGeminiUsage: async () => unavailableRow('gemini') }))
vi.mock('./grok-usage', () => ({ fetchGrokUsage: async () => unavailableRow('grok') }))
vi.mock('./kimi-usage', () => ({ fetchKimiUsage: async () => unavailableRow('kimi') }))
vi.mock('./minimax-usage', () => ({ fetchMinimaxUsage: async () => unavailableRow('minimax') }))
vi.mock('./opencode-usage', () => ({ fetchOpencodeUsage: async () => unavailableRow('opencode') }))

import { startUsageService, type UsageService } from './usage-service'

function unavailableRow(provider: string): ProviderUsage {
  return { provider, account: null, limits: [], updatedAt: 0, status: 'unavailable' }
}

function codexRows(rows: ProviderUsage[]): ProviderUsage[] {
  return rows.filter((row) => row.provider === 'codex')
}

let platform: FakePlatform
let service: UsageService | undefined

beforeEach(() => {
  resetPlatformForTests()
  platform = fakePlatform()
  initPlatform(platform)
  fetchCodexUsage.mockClear()
})

afterEach(() => {
  service?.dispose()
  service = undefined
  resetPlatformForTests()
})

describe('Codex multi-account usage', () => {
  it('returns the system identity and two managed account rows independently', async () => {
    const accounts = [
      { id: 'a', home: '/isolated/a', label: 'Work', email: 'work@example.com' },
      { id: 'b', home: '/isolated/b', label: 'Personal', email: 'me@example.com' }
    ]
    service = startUsageService({ shouldPoll: () => false, codexAccounts: () => accounts })

    const rows = (await platform.handlers[IPC.usageProviders]()) as ProviderUsage[]
    // System row first (un-owned ⇒ accountId undefined), then one row per account keyed by its
    // own id — three DISTINCT rows, never merged into one.
    expect(codexRows(rows).map((row) => row.accountId)).toEqual([undefined, 'a', 'b'])
    // Each managed account is read against its OWN home + identity — never the system home.
    expect(fetchCodexUsage).toHaveBeenNthCalledWith(1)
    expect(fetchCodexUsage).toHaveBeenNthCalledWith(2, '/isolated/a', accounts[0])
    expect(fetchCodexUsage).toHaveBeenNthCalledWith(3, '/isolated/b', accounts[1])
  })

  it('invalidates the provider cache when an account is added', async () => {
    let accounts = [{ id: 'a', home: '/isolated/a', label: 'Work' }]
    service = startUsageService({ shouldPoll: () => false, codexAccounts: () => accounts })

    await platform.handlers[IPC.usageProviders]()
    // First sweep: system + account a.
    expect(fetchCodexUsage).toHaveBeenCalledTimes(2)

    // Adding an account changes the fingerprint, which must bust the debounce cache — otherwise
    // the popover would keep serving the two-row snapshot and the new account would never appear.
    accounts = [...accounts, { id: 'b', home: '/isolated/b', label: 'Personal' }]
    const rows = (await platform.handlers[IPC.usageProviders]()) as ProviderUsage[]
    expect(codexRows(rows).map((row) => row.accountId)).toEqual([undefined, 'a', 'b'])
    // 2 (first sweep) + 3 (second sweep after the bust) = 5. A stale cache would leave this at 2.
    expect(fetchCodexUsage).toHaveBeenCalledTimes(5)
  })

  it('serves the cache within the debounce while the account set is unchanged', async () => {
    const accounts = [{ id: 'a', home: '/isolated/a', label: 'Work' }]
    service = startUsageService({ shouldPoll: () => false, codexAccounts: () => accounts })

    await platform.handlers[IPC.usageProviders]()
    await platform.handlers[IPC.usageProviders]()
    // Same fingerprint ⇒ the second call is served from cache, not a re-fetch (2 + 2 would mean
    // the fingerprint check wrongly busts an unchanged set).
    expect(fetchCodexUsage).toHaveBeenCalledTimes(2)
  })

  it('a throwing codexAccounts() yields system-only, never a fabricated account', async () => {
    service = startUsageService({
      shouldPoll: () => false,
      codexAccounts: () => {
        throw new Error('settings read blew up')
      }
    })

    const rows = (await platform.handlers[IPC.usageProviders]()) as ProviderUsage[]
    // Fail closed: only the un-owned system row, no guessed / invented account.
    expect(codexRows(rows).map((row) => row.accountId)).toEqual([undefined])
    expect(fetchCodexUsage).toHaveBeenCalledTimes(1)
    expect(fetchCodexUsage).toHaveBeenNthCalledWith(1)
  })

  it('a read error for one account stays empty for THAT account — never another account’s numbers', async () => {
    const accounts = [
      { id: 'a', home: '/isolated/a', label: 'Work' },
      { id: 'b', home: '/isolated/b', label: 'Personal' }
    ]
    // Account a's read throws; account b returns real limits. The failure must fail closed to an
    // EMPTY row keyed to a — never adopt b's numbers and never drop a's id (which would fold it
    // into the un-owned system row).
    fetchCodexUsage.mockImplementation(async (home?: string, identity?: { id?: string }) => {
      if (identity?.id === 'a') throw new Error('auth.json unreadable')
      if (identity?.id === 'b') {
        return {
          provider: 'codex',
          accountId: 'b',
          account: null,
          limits: [
            {
              kind: 'session',
              group: 'session',
              usedPercent: 42,
              severity: null,
              resetsAt: null,
              windowMinutes: 300,
              scopeLabel: null,
              isActive: false
            }
          ],
          updatedAt: Date.now(),
          status: 'ok' as const
        }
      }
      return unavailableRow('codex')
    })
    service = startUsageService({ shouldPoll: () => false, codexAccounts: () => accounts })

    const rows = codexRows((await platform.handlers[IPC.usageProviders]()) as ProviderUsage[])
    const rowA = rows.find((r) => r.accountId === 'a')
    const rowB = rows.find((r) => r.accountId === 'b')

    expect(rowA).toBeDefined()
    expect(rowA?.status).toBe('error')
    expect(rowA?.limits).toEqual([]) // empty, NOT b's [42%] window
    expect(rowB?.status).toBe('ok')
    expect(rowB?.limits).toHaveLength(1)
    // The failing account never collapsed into the un-owned system row.
    expect(rows.filter((r) => r.accountId === undefined)).toHaveLength(1)
  })
})
