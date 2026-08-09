import { describe, expect, it } from 'vitest'
import { GitHubAvatarFetcher } from './avatar-fetcher'

const users = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: index + 1,
  login: `user-${index + 1}`,
  avatarUrl: `https://avatars.githubusercontent.com/u/${index + 1}?v=4`
}))

describe('GitHubAvatarFetcher', () => {
  it('fetches only the validated avatar host without redirects', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher = new GitHubAvatarFetcher({
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      }
    })
    const result = await fetcher.forPage(users(1))
    expect(result.dataUrls.get(1)).toBe('data:image/png;base64,AQID')
    expect(calls[0].init.redirect).toBe('manual')

    const blocked = await fetcher.forPage([{ id: 9, login: 'bad', avatarUrl: 'https://example.com/a.png' }])
    expect(blocked.dataUrls.size).toBe(0)
  })

  it('rejects redirects, unsupported MIME types, and images above 128 KiB', async () => {
    const replies = [
      new Response(null, { status: 302, headers: { location: 'https://avatars.githubusercontent.com/other' } }),
      new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/svg+xml' } }),
      new Response(new Uint8Array(128 * 1024 + 1), { headers: { 'content-type': 'image/png' } })
    ]
    const fetcher = new GitHubAvatarFetcher({ fetch: async () => replies.shift()! })
    expect((await fetcher.forPage(users(3))).dataUrls.size).toBe(0)
  })

  it('stops at the 512 KiB aggregate page budget', async () => {
    const bytes = new Uint8Array(120 * 1024)
    const fetcher = new GitHubAvatarFetcher({
      fetch: async () => new Response(bytes, { headers: { 'content-type': 'image/webp' } })
    })
    const result = await fetcher.forPage(users(6))
    expect(result.dataUrls.size).toBe(4)
    expect(result.truncated).toBe(true)
  })
})
