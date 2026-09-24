import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fetchGrokUsage } from './grok-usage'
let home: string
const request = vi.fn()
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-diagnostics-'))
  fs.writeFileSync(path.join(home, 'auth.json'), '{"auth.x.ai":{"key":"fixture-secret"}}')
  vi.stubGlobal('fetch', request.mockReset())
})
afterEach(() => {
  expect(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).toBe('{"auth.x.ai":{"key":"fixture-secret"}}')
  fs.rmSync(home, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
it.each([401, 403, 429, 500, 418])('preserves HTTP %s for both billing views without response bodies', async (status) => {
  request.mockResolvedValue({ ok: false, status, json: async () => ({ secret: 'fixture-secret' }) })
  const result = await fetchGrokUsage(home)
  expect(result).toMatchObject({ status: 'error', diagnostics: [
    { view: 'credits', reason: 'http', httpStatus: status },
    { view: 'default', reason: 'http', httpStatus: status }
  ] })
  expect(JSON.stringify(result)).not.toContain('fixture-secret')
})
it('attempts fallback after a transport failure and preserves usable data plus the reason', async () => {
  request.mockRejectedValueOnce(new Error('fixture-secret')).mockResolvedValueOnce(ok({ creditUsagePercent: 25 }))
  const result = await fetchGrokUsage(home)
  expect(result).toMatchObject({ status: 'ok', limits: [{ usedPercent: 25 }], diagnostics: [{ view: 'credits', reason: 'network' }] })
  expect(request).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(result)).not.toContain('fixture-secret')
})
it.each([true, false])('does not call a partial failure unavailable (credits failed: %s)', async (firstFails) => {
  const fail = { ok: false, status: 503 }
  request.mockResolvedValueOnce(firstFails ? fail : ok({})).mockResolvedValueOnce(firstFails ? ok({}) : fail)
  expect(await fetchGrokUsage(home)).toMatchObject({ status: 'error', diagnostics: [{ view: firstFails ? 'credits' : 'default', reason: 'http', httpStatus: 503 }] })
})
it('keeps genuine no-quota responses unavailable', async () => {
  request.mockResolvedValue(ok({}))
  expect(await fetchGrokUsage(home)).toMatchObject({ status: 'unavailable' })
})
it('keeps the credits success fast path', async () => {
  request.mockResolvedValue(ok({ creditUsagePercent: 0 }))
  expect(await fetchGrokUsage(home)).toMatchObject({ status: 'ok', limits: [{ usedPercent: 0 }] })
  expect(request).toHaveBeenCalledTimes(1)
})
it('distinguishes malformed JSON from transport failures', async () => {
  request.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('fixture-secret') } })
  expect(await fetchGrokUsage(home)).toMatchObject({ status: 'error', diagnostics: [
    { view: 'credits', reason: 'invalid-response' }, { view: 'default', reason: 'invalid-response' }
  ] })
})
it('bounds response body reads and retains timeout reasons', async () => {
  vi.useFakeTimers()
  request.mockImplementation(async (_url, { signal }) => ({ ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('fixture-secret')))
  }) }))
  const pending = fetchGrokUsage(home)
  // Auth reads use the real filesystem before the first request starts.
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  await vi.advanceTimersByTimeAsync(16000)
  expect(await pending).toMatchObject({ status: 'error', diagnostics: [
    { view: 'credits', reason: 'timeout' }, { view: 'default', reason: 'timeout' }
  ] })
  expect(vi.getTimerCount()).toBe(0)
})

it.each([null, [], 'not an object'])('reports invalid top-level JSON: %j', async (body) => {
  request.mockResolvedValue(ok(body))
  expect(await fetchGrokUsage(home)).toMatchObject({ status: 'error', diagnostics: [
    { view: 'credits', reason: 'invalid-response' }, { view: 'default', reason: 'invalid-response' }
  ] })
})
