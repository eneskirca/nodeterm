import { describe, expect, it } from 'vitest'
import type { Project } from '../../shared/types'
import { fetchAvatarDataUrl } from './avatar-fetcher'
import { resolveProjectAvatarDataUrl, resolveProjectAvatarForProject } from './project-avatar'

const AVATAR = 'https://avatars.githubusercontent.com/u/1?v=4'

describe('fetchAvatarDataUrl', () => {
  it('fetches the validated avatar host with redirect:manual and returns a data URL', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const result = await fetchAvatarDataUrl(AVATAR, async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    })
    expect(result).toEqual({ dataUrl: 'data:image/png;base64,AQID', bytes: 3 })
    expect(calls[0].init.redirect).toBe('manual')
    expect(new URL(calls[0].url).hostname).toBe('avatars.githubusercontent.com')
  })

  it('rejects a non-avatar host (SSRF guard)', async () => {
    let called = false
    const result = await fetchAvatarDataUrl('https://example.com/a.png', async () => {
      called = true
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
    })
    expect(result).toBeNull()
    expect(called).toBe(false)
  })

  it('rejects credentials embedded in the URL', async () => {
    const result = await fetchAvatarDataUrl(
      'https://user:pass@avatars.githubusercontent.com/u/1',
      async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
    )
    expect(result).toBeNull()
  })

  it('rejects redirects, unsupported MIME types, and images above 128 KiB', async () => {
    const redirect = await fetchAvatarDataUrl(AVATAR, async () =>
      new Response(null, { status: 302, headers: { location: 'https://avatars.githubusercontent.com/x' } }))
    expect(redirect).toBeNull()
    const svg = await fetchAvatarDataUrl(AVATAR, async () =>
      new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/svg+xml' } }))
    expect(svg).toBeNull()
    const oversized = await fetchAvatarDataUrl(AVATAR, async () =>
      new Response(new Uint8Array(128 * 1024 + 1), { headers: { 'content-type': 'image/png' } }))
    expect(oversized).toBeNull()
  })

  it('returns null when the fetch itself throws', async () => {
    const result = await fetchAvatarDataUrl(AVATAR, async () => { throw new Error('network') })
    expect(result).toBeNull()
  })
})

describe('resolveProjectAvatarDataUrl', () => {
  const userJson = (avatarUrl: unknown) =>
    new Response(JSON.stringify({ login: 'acme', avatar_url: avatarUrl }), {
      headers: { 'content-type': 'application/json' }
    })

  it('resolves owner -> avatar_url -> data URL', async () => {
    const seen: string[] = []
    const dataUrl = await resolveProjectAvatarDataUrl({
      owner: 'acme',
      token: 'tkn',
      fetchImpl: async (url, init) => {
        const href = String(url)
        seen.push(href)
        if (href === 'https://api.github.com/users/acme') {
          expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tkn')
          expect(init?.redirect).toBe('manual')
          return userJson(AVATAR)
        }
        return new Response(new Uint8Array([9, 9]), { headers: { 'content-type': 'image/png' } })
      }
    })
    expect(dataUrl).toBe('data:image/png;base64,CQk=')
    expect(seen[0]).toBe('https://api.github.com/users/acme')
  })

  it('works without a token (unauthenticated)', async () => {
    const dataUrl = await resolveProjectAvatarDataUrl({
      owner: 'acme',
      fetchImpl: async (url) => {
        if (String(url) === 'https://api.github.com/users/acme') {
          return userJson(AVATAR)
        }
        return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
      }
    })
    expect(dataUrl).toBe('data:image/png;base64,AQ==')
  })

  it('refuses an owner GitHub could not have issued, before any request', async () => {
    let fetched = false
    for (const owner of ['-acme', 'x'.repeat(40), '../x', 'a/b', 'a?b']) {
      expect(await resolveProjectAvatarDataUrl({
        owner,
        fetchImpl: async () => { fetched = true; return userJson(AVATAR) }
      })).toBeNull()
    }
    expect(fetched).toBe(false)
  })

  it('returns null when avatar_url is missing', async () => {
    const dataUrl = await resolveProjectAvatarDataUrl({
      owner: 'acme',
      fetchImpl: async () => userJson(undefined)
    })
    expect(dataUrl).toBeNull()
  })

  it('returns null when the user request is not ok', async () => {
    const dataUrl = await resolveProjectAvatarDataUrl({
      owner: 'acme',
      fetchImpl: async () => new Response('nope', { status: 404 })
    })
    expect(dataUrl).toBeNull()
  })

  it('never throws and returns null on a rejecting fetch', async () => {
    const dataUrl = await resolveProjectAvatarDataUrl({
      owner: 'acme',
      fetchImpl: async () => { throw new Error('boom') }
    })
    expect(dataUrl).toBeNull()
  })

  it('bounds the users request with an abort signal (hung connection can never hang forever)', async () => {
    let seenSignal: unknown
    await resolveProjectAvatarDataUrl({
      owner: 'acme',
      fetchImpl: async (_url, init) => {
        seenSignal = init?.signal
        return userJson(AVATAR)
      }
    })
    expect(seenSignal).toBeInstanceOf(AbortSignal)
  })

  it('rejects an owner that would escape the users path', async () => {
    let called = false
    const dataUrl = await resolveProjectAvatarDataUrl({
      owner: '../repos/secret',
      fetchImpl: async () => { called = true; return userJson(AVATAR) }
    })
    expect(dataUrl).toBeNull()
    expect(called).toBe(false)
  })
})

describe('resolveProjectAvatarForProject', () => {
  const project = (overrides: Partial<Project> = {}): Project =>
    ({ id: 'p1', name: 'p', ...overrides }) as unknown as Project

  it('derives the owner from the detected git origin (never a caller slug)', async () => {
    const result = await resolveProjectAvatarForProject({
      project: project(),
      detectRepository: async () => 'https://github.com/acme/widgets.git',
      fetchImpl: async (url) => {
        if (String(url) === 'https://api.github.com/users/acme') {
          return new Response(JSON.stringify({ avatar_url: AVATAR }), {
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(new Uint8Array([7]), { headers: { 'content-type': 'image/png' } })
      }
    })
    expect(result).toEqual({ dataUrl: 'data:image/png;base64,Bw==' })
  })

  it('prefers the configured kanban repository owner over the detected origin', async () => {
    const owners: string[] = []
    await resolveProjectAvatarForProject({
      project: project({ kanban: { columns: [], github: { repository: 'configured-org/app' } } } as unknown as Partial<Project>),
      detectRepository: async () => 'https://github.com/detected-org/app',
      fetchImpl: async (url) => {
        owners.push(new URL(String(url)).pathname)
        return new Response(JSON.stringify({ avatar_url: null }), {
          headers: { 'content-type': 'application/json' }
        })
      }
    })
    expect(owners[0]).toBe('/users/configured-org')
  })

  it('returns null when the project has no GitHub origin', async () => {
    let called = false
    const result = await resolveProjectAvatarForProject({
      project: project(),
      detectRepository: async () => null,
      fetchImpl: async () => { called = true; return new Response('') }
    })
    expect(result).toBeNull()
    expect(called).toBe(false)
  })

  it('returns null (does not block) when origin detection throws', async () => {
    const result = await resolveProjectAvatarForProject({
      project: project(),
      detectRepository: async () => { throw new Error('ssh unreachable') },
      fetchImpl: async () => new Response('')
    })
    expect(result).toBeNull()
  })
})
