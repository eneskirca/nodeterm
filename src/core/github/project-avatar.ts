import type { Project } from '../../shared/types'
import { fetchAvatarDataUrl } from './avatar-fetcher'
import { parseGitHubRepository } from './config'
import { GITHUB_OWNER_PATTERN } from '../../shared/github-issue-ref'

const API_ORIGIN = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const MAX_USER_JSON_BYTES = 64 * 1024
// A GitHub login: the one shared grammar. Validated before it ever reaches the URL path so a
// hostile project.json owner cannot escape `/users/{owner}` into another api.github.com route.
const OWNER = new RegExp(`^${GITHUB_OWNER_PATTERN}$`)

async function boundedJson(response: Response): Promise<Record<string, unknown> | null> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_USER_JSON_BYTES) return null
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > MAX_USER_JSON_BYTES) { await reader.cancel(); return null }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** GET api.github.com/users/{owner} (fixed host, https, no creds in URL, redirect:'manual', bounded
 *  JSON) → `.avatar_url` → the locked avatars.githubusercontent.com fetch. Null on missing avatar,
 *  a non-ok response, or any fetch failure. NEVER throws. */
export async function resolveProjectAvatarDataUrl(deps: {
  owner: string
  token?: string
  fetchImpl?: typeof fetch
}): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch
  if (!OWNER.test(deps.owner)) return null
  const url = new URL(`/users/${deps.owner}`, API_ORIGIN)
  if (url.origin !== API_ORIGIN) return null
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      // A hung connection must not leave the probe pending for the section's lifetime: abort after
      // 10s. The abort surfaces as a rejected fetch → caught below → null (the never-throw envelope).
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
        ...(deps.token ? { authorization: `Bearer ${deps.token}` } : {})
      }
    })
    if (!response.ok || response.status >= 300) return null
    const body = await boundedJson(response)
    const avatarUrl = body?.avatar_url
    if (typeof avatarUrl !== 'string') return null
    const loaded = await fetchAvatarDataUrl(avatarUrl, fetchImpl)
    return loaded?.dataUrl ?? null
  } catch {
    return null
  }
}

/** Host-side resolution keyed on a trusted project: derive the owner from the project's own GitHub
 *  origin (configured kanban repository, else the detected git origin — which for an SSH project is
 *  its remoteCwd via the same originUrl path) and hand it to the resolver. A caller never supplies a
 *  slug/owner. Null when the project has no GitHub origin or origin detection is unreachable. */
export async function resolveProjectAvatarForProject(deps: {
  project: Project
  detectRepository(project: Project): Promise<string | null>
  token?: string
  fetchImpl?: typeof fetch
}): Promise<{ dataUrl: string } | null> {
  const configured = deps.project.kanban?.github?.repository
    ? parseGitHubRepository(deps.project.kanban.github.repository)
    : null
  let detected: string | null = null
  try {
    detected = parseGitHubRepository(await deps.detectRepository(deps.project))
  } catch {
    detected = null
  }
  const repository = configured ?? detected
  if (!repository) return null
  const owner = repository.split('/')[0]
  const dataUrl = await resolveProjectAvatarDataUrl({
    owner,
    token: deps.token,
    fetchImpl: deps.fetchImpl
  })
  return dataUrl ? { dataUrl } : null
}
