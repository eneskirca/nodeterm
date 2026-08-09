import type { GitHubIssueUser } from '../../shared/github-issues'

const MAX_AVATAR_BYTES = 128 * 1024
const MAX_PAGE_BYTES = 512 * 1024
const MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

type AvatarFetcherOptions = {
  fetch?: typeof fetch
  cacheTtlMs?: number
  now?: () => number
}

type CacheEntry = { dataUrl: string; bytes: number; expiresAt: number }

async function boundedBytes(response: Response): Promise<Uint8Array | null> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_AVATAR_BYTES) return null
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > MAX_AVATAR_BYTES) { await reader.cancel(); return null }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

export class GitHubAvatarFetcher {
  private readonly fetcher: typeof fetch
  private readonly cache = new Map<number, CacheEntry>()
  private readonly ttl: number
  private readonly now: () => number

  constructor(options: AvatarFetcherOptions = {}) {
    this.fetcher = options.fetch ?? fetch
    this.ttl = options.cacheTtlMs ?? 5 * 60_000
    this.now = options.now ?? Date.now
  }

  async forPage(users: readonly GitHubIssueUser[]): Promise<{
    dataUrls: Map<number, string>
    truncated: boolean
  }> {
    const dataUrls = new Map<number, string>()
    let total = 0
    let truncated = false
    for (const user of new Map(users.map((item) => [item.id, item])).values()) {
      const cached = this.cache.get(user.id)
      if (cached && cached.expiresAt > this.now()) {
        if (total + cached.bytes > MAX_PAGE_BYTES) { truncated = true; break }
        total += cached.bytes
        dataUrls.set(user.id, cached.dataUrl)
        continue
      }
      const loaded = await this.fetchOne(user)
      if (!loaded) continue
      if (total + loaded.bytes > MAX_PAGE_BYTES) { truncated = true; break }
      total += loaded.bytes
      dataUrls.set(user.id, loaded.dataUrl)
    }
    return { dataUrls, truncated }
  }

  private async fetchOne(user: GitHubIssueUser): Promise<CacheEntry | null> {
    let url: URL
    try { url = new URL(user.avatarUrl) } catch { return null }
    if (url.protocol !== 'https:' || url.hostname !== 'avatars.githubusercontent.com' ||
        url.username || url.password) return null
    url.searchParams.set('size', '64')
    let response: Response
    try {
      response = await this.fetcher(url, { method: 'GET', redirect: 'manual' })
    } catch {
      return null
    }
    if (!response.ok || response.status >= 300) return null
    const mime = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
    if (!mime || !MIME.has(mime)) return null
    const bytes = await boundedBytes(response)
    if (!bytes) return null
    const entry = {
      dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
      bytes: bytes.byteLength,
      expiresAt: this.now() + this.ttl
    }
    this.cache.set(user.id, entry)
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!)
    return entry
  }
}
