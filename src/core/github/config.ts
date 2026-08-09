import { createHash } from 'node:crypto'
import type { KanbanColumn } from '../../shared/types'
import type {
  GitHubConfigResult,
  NormalisedProjectKanbanGitHub
} from '../../shared/github-issues'

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?'
const REPOSITORY = '[A-Za-z0-9_.-]+'
const REPOSITORY_PATH = new RegExp(`^(${OWNER})/(${REPOSITORY})$`)

export function parseGitHubRepository(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let value = input.trim()
  if (!value) return null

  const scp = value.match(/^git@github\.com:([^/]+\/[^/]+)$/i)
  if (scp) value = scp[1]
  else if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash) return null
    value = url.pathname.replace(/^\//, '')
  }

  value = value.replace(/\.git$/i, '')
  const match = value.match(REPOSITORY_PATH)
  if (!match) return null
  const [, owner, repository] = match
  if (repository === '.' || repository === '..' || repository.startsWith('-')) return null
  return `${owner}/${repository}`
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function normaliseProjectKanbanGitHub(
  input: unknown,
  columns: readonly KanbanColumn[]
): GitHubConfigResult {
  const value = record(input)
  if (!value || !Array.isArray(value.columnMappings)) {
    return { ok: false, reason: 'invalid-shape' }
  }

  let repository: string | undefined
  if (value.repository !== undefined) {
    repository = parseGitHubRepository(value.repository) ?? undefined
    if (!repository) return { ok: false, reason: 'invalid-repository' }
  }

  const columnIds = new Set(columns.map((column) => column.id))
  const seenColumns = new Set<string>()
  const seenLabels = new Set<string>()
  const mappings: Array<{ columnId: string; label: string }> = []
  for (const candidate of value.columnMappings) {
    const mapping = record(candidate)
    if (!mapping || typeof mapping.columnId !== 'string' || typeof mapping.label !== 'string') {
      return { ok: false, reason: 'invalid-shape' }
    }
    const columnId = mapping.columnId.trim()
    const label = mapping.label.trim()
    if (!columnIds.has(columnId)) return { ok: false, reason: 'unknown-column' }
    if (seenColumns.has(columnId)) return { ok: false, reason: 'duplicate-column' }
    if (!label) return { ok: false, reason: 'empty-label' }
    const folded = label.toLocaleLowerCase('en-US')
    if (seenLabels.has(folded)) return { ok: false, reason: 'duplicate-label' }
    seenColumns.add(columnId)
    seenLabels.add(folded)
    mappings.push({ columnId, label })
  }

  let completionColumnId: string | undefined
  if (value.completionColumnId !== undefined) {
    if (typeof value.completionColumnId !== 'string') {
      return { ok: false, reason: 'invalid-completion-column' }
    }
    completionColumnId = value.completionColumnId.trim()
    if (!columnIds.has(completionColumnId) || !seenColumns.has(completionColumnId)) {
      return { ok: false, reason: 'invalid-completion-column' }
    }
  }

  const order = new Map(columns.map((column, index) => [column.id, index]))
  mappings.sort((a, b) => order.get(a.columnId)! - order.get(b.columnId)!)
  const canonical = {
    ...(repository ? { repository } : {}),
    columnMappings: mappings,
    ...(completionColumnId ? { completionColumnId } : {})
  }
  const normalised: NormalisedProjectKanbanGitHub = {
    ...canonical,
    revision: createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  }
  return { ok: true, value: normalised }
}
