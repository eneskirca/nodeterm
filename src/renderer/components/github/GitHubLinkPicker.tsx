import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GitHubIssueCardView, GitHubLink } from '@shared/github-issues'
import { useSession } from '../../session/session'
import { hasLink, linkState, parseLinkInput } from '../../lib/githubLinks'

const DEBOUNCE_MS = 150
const RESULT_LIMIT = 20

/** What the list is currently showing. `refused` carries a reason the user can act on rather
 *  than an empty list, which reads as "this repository has nothing in it". */
type Results =
  | { kind: 'items'; items: GitHubIssueCardView[]; partial: boolean }
  | { kind: 'refused'; message: string }
  | { kind: 'not-found'; number: number }

interface Props {
  projectId: string
  repository: string
  /** Links the node already carries — their rows are shown, disabled. */
  existing: GitHubLink[]
  initialQuery?: string
  kindFilter?: 'issue' | 'pull'
  /** Candidates to offer before anything is typed (the worktree frame's open pull requests). */
  preset?: GitHubIssueCardView[]
  anchor: { x: number; y: number }
  onPick: (link: GitHubLink) => void
  onClose: () => void
}

const REFUSALS: Record<string, string> = {
  'not-approved': 'GitHub is not approved for this project — approve it in Settings → GitHub.',
  'not-authenticated': 'Not signed in to GitHub — sign in in Settings → GitHub.',
  'configuration-changed': 'The project’s GitHub configuration changed — try again.',
  'invalid-request': 'That is not an issue or pull request number.'
}

/**
 * Search-and-pick list for attaching a GitHub issue or pull request to a node.
 *
 * A query that IS a number or a github.com URL goes to `lookup` (which can reach the API for an
 * item the cached snapshot never held); anything else goes to `search`, which only ever reads the
 * cache. A URL for another repository resolves to nothing at all — the link's repository is the
 * project's, so attaching by that number would silently point at the wrong item.
 */
export function GitHubLinkPicker({
  projectId,
  repository,
  existing,
  initialQuery,
  kindFilter,
  preset,
  anchor,
  onPick,
  onClose
}: Props) {
  const { api } = useSession()
  const [query, setQuery] = useState(initialQuery ?? '')
  const [results, setResults] = useState<Results>({
    kind: 'items',
    items: preset ?? [],
    partial: false
  })
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    const run = generation.current + 1
    generation.current = run
    const parsed = parseLinkInput(query, repository)
    const timer = setTimeout(() => {
      setBusy(true)
      const work = parsed
        ? api.githubIssues.lookup({ projectId, number: parsed.number }).then((result): Results => {
            if (result.ok) return { kind: 'items', items: [result.item], partial: false }
            if (result.reason === 'not-found') return { kind: 'not-found', number: parsed.number }
            return { kind: 'refused', message: REFUSALS[result.reason] ?? 'GitHub is unavailable.' }
          })
        : api.githubIssues.search({
            projectId,
            search: query.trim(),
            limit: RESULT_LIMIT,
            ...(kindFilter ? { kind: kindFilter } : {})
          }).then((result): Results => ({
            kind: 'items', items: result.items, partial: result.partial
          }))
      void work
        .catch((): Results => ({ kind: 'refused', message: 'GitHub is unavailable.' }))
        .then((next) => {
          if (generation.current !== run) return
          setBusy(false)
          setResults(next)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [api, projectId, repository, query, kindFilter])

  const rows = useMemo(
    () => (results.kind === 'items' ? results.items : []),
    [results]
  )

  const pick = (item: GitHubIssueCardView): void => {
    const link: GitHubLink = {
      kind: item.pull ? 'pull' : 'issue',
      number: item.number,
      ...(item.title ? { title: item.title.slice(0, 200) } : {})
    }
    if (hasLink(existing, link)) return
    onPick(link)
  }

  const firstFree = rows.find((item) =>
    !hasLink(existing, { kind: item.pull ? 'pull' : 'issue', number: item.number }))

  return createPortal(
    <>
      <div className="tab-backdrop" style={{ zIndex: 78 }} onClick={onClose} />
      <div
        className="tab-menu github-link-picker"
        style={{ top: anchor.y, left: anchor.x, zIndex: 80 }}
      >
        <input
          className="tab__edit github-link-picker__filter"
          placeholder="#123, a title, or a github.com link"
          value={query}
          spellCheck={false}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); onClose() }
            if (event.key === 'Enter' && firstFree) { event.preventDefault(); pick(firstFree) }
          }}
        />
        <div className="github-link-picker__list">
          {results.kind === 'refused' && (
            <button type="button" disabled className="github-link-picker__note">
              {results.message}
            </button>
          )}
          {results.kind === 'not-found' && (
            <button type="button" disabled className="github-link-picker__note">
              #{results.number} is not in {repository}.
            </button>
          )}
          {results.kind === 'items' && !rows.length && !busy && (
            <button type="button" disabled className="github-link-picker__note">
              Nothing matches.
            </button>
          )}
          {rows.map((item) => {
            const link = { kind: (item.pull ? 'pull' : 'issue') as GitHubLink['kind'], number: item.number }
            const attached = hasLink(existing, link)
            return (
              <button
                type="button"
                key={`${link.kind}#${item.number}`}
                disabled={attached}
                title={attached ? 'Already attached to this node' : item.title}
                onClick={() => pick(item)}
              >
                <i className={`github-link-chip__dot github-link-chip__dot--${linkState(link, item)}`} />
                <span className="github-link-picker__num">#{item.number}</span>
                <span className="github-link-picker__title">{item.title}</span>
                {item.pull && <span className="github-link-picker__badge">PR</span>}
              </button>
            )
          })}
        </div>
        {results.kind === 'items' && results.partial && (
          <div className="github-link-picker__foot">
            Only part of the repository is cached — refresh the board for the rest.
          </div>
        )}
      </div>
    </>,
    document.body
  )
}
