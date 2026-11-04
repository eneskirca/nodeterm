import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakePlatform } from './platform-fake'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const WEBP = Buffer.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), 1, 2, 3])
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

describe('fetchPopupImage', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  // A fresh module per load: API_BASE and the kept picture are module state.
  const load = async () => {
    vi.resetModules()
    ;(await import('./platform')).initPlatform(fakePlatform())
    return import('./check')
  }

  beforeEach(() => {
    vi.doMock('./license', () => ({ isPremium: () => false }))
    vi.doMock('./device-id', () => ({ getDeviceId: () => '33333333-3333-3333-3333-333333333333' }))
    vi.stubEnv('NODETERM_API_BASE', 'http://api.test')
    vi.stubEnv('DO_NOT_TRACK', '')
    vi.stubEnv('NODETERM_TELEMETRY_DISABLED', '')
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.doUnmock('./license')
    vi.doUnmock('./device-id')
  })

  it('fetches from our own API by hash, with no install id, and returns a data URL', async () => {
    fetchMock.mockResolvedValue(new Response(PNG))
    const { fetchPopupImage } = await load()
    await expect(fetchPopupImage(sha(PNG))).resolves.toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`http://api.test/v1/message-image/${sha(PNG)}`)
    expect(init.redirect).toBe('error')
  })

  it('names the type from the bytes, not the reply', async () => {
    const { fetchPopupImage } = await load()
    for (const [bytes, mime] of [
      [JPEG, 'image/jpeg'],
      [WEBP, 'image/webp']
    ] as const) {
      fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }))
      await expect(fetchPopupImage(sha(bytes))).resolves.toMatch(new RegExp(`^data:${mime};base64,`))
    }
  })

  it('refuses bytes that do not match the hash', async () => {
    fetchMock.mockResolvedValue(new Response(PNG))
    const { fetchPopupImage } = await load()
    await expect(fetchPopupImage('a'.repeat(64))).resolves.toBeNull()
  })

  it('refuses a matching hash over bytes that are not an image', async () => {
    const html = '<script>alert(1)</script>'
    fetchMock.mockResolvedValue(new Response(html))
    const { fetchPopupImage } = await load()
    await expect(fetchPopupImage(sha(html))).resolves.toBeNull()
  })

  it('stops reading past the limit, whatever the reply claimed', async () => {
    const chunk = Buffer.alloc(512 * 1024)
    PNG.copy(chunk)
    const cancel = vi.fn()
    // A body that never ends: only the limit can stop this read.
    const body = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(chunk), cancel })
    fetchMock.mockResolvedValue(new Response(body, { headers: { 'content-length': '10' } }))
    const { fetchPopupImage } = await load()
    await expect(fetchPopupImage('a'.repeat(64))).resolves.toBeNull()
    expect(cancel).toHaveBeenCalled()
  })

  it('takes exactly the limit', async () => {
    const full = Buffer.alloc(2 * 1024 * 1024)
    PNG.copy(full)
    fetchMock.mockResolvedValue(new Response(full))
    const { fetchPopupImage } = await load()
    await expect(fetchPopupImage(sha(full))).resolves.toMatch(/^data:image\/png/)
  })

  it('never asks for something that is not a hash', async () => {
    const { fetchPopupImage } = await load()
    for (const bad of ['', 'A'.repeat(64), `../../${'a'.repeat(58)}`, `${'a'.repeat(64)}/x`, `https://evil.test/${'a'.repeat(46)}`]) {
      await expect(fetchPopupImage(bad)).resolves.toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honours the same opt-outs as the feed', async () => {
    vi.stubEnv('DO_NOT_TRACK', '1')
    const { fetchPopupImage } = await load()
    await expect(fetchPopupImage(sha(PNG))).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers null on a failed read, and tries again next time', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('gone', { status: 404 }))
      .mockResolvedValue(new Response(PNG))
    const { fetchPopupImage } = await load()
    await expect(fetchPopupImage(sha(PNG))).resolves.toBeNull()
    await expect(fetchPopupImage(sha(PNG))).resolves.toBeNull()
    await expect(fetchPopupImage(sha(PNG))).resolves.toMatch(/^data:image\/png/)
  })

  // A popup waiting its turn re-reads the feed every five minutes.
  it('fetches a picture once', async () => {
    fetchMock.mockImplementation(async () => new Response(PNG))
    const { fetchPopupImage } = await load()
    const first = await fetchPopupImage(sha(PNG))
    await expect(fetchPopupImage(sha(PNG))).resolves.toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
