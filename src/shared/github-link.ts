import {
  GITHUB_LINK_TITLE_MAX,
  GITHUB_LINKS_PER_NODE_MAX,
  type GitHubLink,
  type GitHubLinkKind
} from './github-issues'
import type { CanvasNodeState } from './types'

const KINDS = new Set<string>(['issue', 'pull'])

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Normalize the `github` array of a node crossing the shared-file boundary, in BOTH directions
 * (`sanitizeNodeTriggers` is the precedent). `.nodeterm/project.json` is git-shared and
 * hand-editable, so every field is hostile input: a bad entry is dropped, a bad title drops while
 * the link survives, and the whole array degrades to `undefined` rather than throwing anywhere
 * downstream. The rebuilt objects carry only the three known keys, so a smuggled extra key cannot
 * ride into the live nodes or back out to disk.
 */
export function sanitizeGitHubLinks(value: unknown): GitHubLink[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: GitHubLink[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (out.length >= GITHUB_LINKS_PER_NODE_MAX) break
    const entry = plainObject(candidate)
    if (!entry) continue
    const kind = entry.kind
    if (typeof kind !== 'string' || !KINDS.has(kind)) continue
    const number = entry.number
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) continue
    const key = `${kind}#${number}`
    if (seen.has(key)) continue
    seen.add(key)
    const rawTitle = entry.title
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
    out.push({
      kind: kind as GitHubLinkKind,
      number,
      ...(title && title.length <= GITHUB_LINK_TITLE_MAX ? { title } : {})
    })
  }
  return out.length ? out : undefined
}

/** `sanitizeGitHubLinks` over a whole node array. Unlike triggers there is no kind gate: any node
 *  kind may carry links (a group frame does, which is what phase 3b's suggestion attaches to). */
export function sanitizeNodeGitHubLinks(nodes: CanvasNodeState[]): CanvasNodeState[] {
  return nodes.map((n) => {
    if (n.github === undefined) return n
    const safe = sanitizeGitHubLinks(n.github)
    if (safe) return { ...n, github: safe }
    const { github: _dropped, ...rest } = n
    return rest
  })
}

/** The link's page on github.com. Empty string when the project has no repository — the caller
 *  must not offer "Open on GitHub" without one. */
export function githubLinkUrl(repository: string | undefined, link: GitHubLink): string {
  if (!repository) return ''
  return `https://github.com/${repository}/${link.kind === 'pull' ? 'pull' : 'issues'}/${link.number}`
}
