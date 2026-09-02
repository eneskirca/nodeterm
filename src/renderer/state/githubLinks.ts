import { create } from 'zustand'
import type {
  GitHubBranchPull,
  GitHubIssueCardView,
  GitHubIssuePage,
  GitHubIssuesApi,
  GitHubLink
} from '@shared/github-issues'
import { linkKey } from '../lib/githubLinks'

/** How long a resolved card is considered fresh enough for a chip's status dot. A canvas chip has
 *  no host subscription (the board's is ref-counted and lives with the board), so this bound IS
 *  the freshness guarantee: last lookup within the window, or the last board open. */
export const LINK_CARD_TTL_MS = 5 * 60_000
/** A number that resolves to nothing, and a project whose GitHub is refused, are both re-asked
 *  after this — long enough that a canvas full of chips does not hammer the host. */
export const LINK_RETRY_MS = 60_000

/** A refusal that applies to the whole project, not to one number: one gate stops a dozen chips
 *  asking the same unanswerable question. */
export type LinkGate = 'not-approved' | 'not-authenticated'

/** Dismissed suggestions are MACHINE-LOCAL: the frame's branch and the pull request travel with
 *  the repository, but "I already said no to this one" is one person's answer on one machine, so
 *  it never goes near `.nodeterm/project.json`. */
const DISMISSED_KEY = 'nodeterm.prSuggestDismissed'
const DISMISSED_MAX = 500

function loadDismissed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveDismissed(values: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...values].slice(-DISMISSED_MAX)))
  } catch { /* a private window simply forgets the dismissal */ }
}

/** Dismissal is per FRAME, not per branch: two frames on one branch are two pieces of work, and
 *  answering for one must not silently answer for the other. */
export const suggestionKey = (projectId: string, groupId: string, number: number): string =>
  `${projectId}:${groupId}:${number}`

export interface PullSuggestions {
  branch: string
  pulls: GitHubBranchPull[]
  at: number
  error?: string
}

interface CardEntry {
  card: GitHubIssueCardView
  at: number
}

interface GitHubLinksState {
  cards: Record<string, Record<string, CardEntry>>
  pending: Record<string, Record<string, true>>
  missing: Record<string, Record<string, number>>
  gate: Record<string, { reason: LinkGate; at: number }>
  pullSuggestions: Record<string, PullSuggestions>
  dismissed: Set<string>
  fetchPullsForBranch(
    api: GitHubIssuesApi,
    projectId: string,
    groupId: string,
    branch: string,
    options?: { force?: boolean }
  ): Promise<void>
  dismissSuggestion(projectId: string, groupId: string, number: number): void
  ensureCard(api: GitHubIssuesApi, projectId: string, link: GitHubLink): Promise<void>
  seedFromPages(projectId: string, pages: GitHubIssuePage[]): void
  invalidate(projectId: string, numbers?: number[]): void
}

const now = (): number => Date.now()

export const useGitHubLinks = create<GitHubLinksState>((set, get) => ({
  cards: {},
  pending: {},
  missing: {},
  gate: {},
  pullSuggestions: {},
  dismissed: loadDismissed(),

  async fetchPullsForBranch(api, projectId, groupId, branch, options) {
    const key = `${projectId}:${groupId}`
    const gate = get().gate[projectId]
    if (gate && now() - gate.at < LINK_RETRY_MS) return
    const result = await api.pullsForBranch({
      projectId, branch, ...(options?.force ? { force: true } : {})
    }).catch(() => ({ ok: false as const, reason: 'failed' as const }))
    set((s) => {
      if (result.ok) {
        return {
          pullSuggestions: {
            ...s.pullSuggestions,
            [key]: { branch, pulls: result.pulls, at: now() }
          }
        }
      }
      const next: Partial<GitHubLinksState> = {
        pullSuggestions: {
          ...s.pullSuggestions,
          [key]: { branch, pulls: [], at: now(), error: result.reason }
        }
      }
      if (result.reason === 'not-approved' || result.reason === 'not-authenticated') {
        next.gate = { ...s.gate, [projectId]: { reason: result.reason, at: now() } }
      }
      return next as GitHubLinksState
    })
  },

  dismissSuggestion(projectId, groupId, number) {
    set((s) => {
      const dismissed = new Set(s.dismissed)
      dismissed.add(suggestionKey(projectId, groupId, number))
      saveDismissed(dismissed)
      return { dismissed }
    })
  },

  async ensureCard(api, projectId, link) {
    const key = linkKey(link)
    const state = get()
    const gate = state.gate[projectId]
    if (gate && now() - gate.at < LINK_RETRY_MS) return
    if (state.pending[projectId]?.[key]) return
    const cached = state.cards[projectId]?.[key]
    if (cached && now() - cached.at < LINK_CARD_TTL_MS) return
    const missedAt = state.missing[projectId]?.[key]
    if (missedAt !== undefined && now() - missedAt < LINK_RETRY_MS) return
    set((s) => ({
      pending: { ...s.pending, [projectId]: { ...s.pending[projectId], [key]: true } }
    }))
    try {
      const result = await api.lookup({ projectId, number: link.number })
      set((s) => {
        const pending = { ...s.pending[projectId] }
        delete pending[key]
        const next: Partial<GitHubLinksState> = {
          pending: { ...s.pending, [projectId]: pending }
        }
        if (result.ok) {
          // The lookup is BY NUMBER, so the answer may be the other kind: keying it by the item's
          // own kind is what stops a pull request being cached as the issue chip's card.
          const answerKey = linkKey({ kind: result.item.pull ? 'pull' : 'issue', number: result.item.number })
          next.cards = {
            ...s.cards,
            [projectId]: { ...s.cards[projectId], [answerKey]: { card: result.item, at: now() } }
          }
        } else if (result.reason === 'not-approved' || result.reason === 'not-authenticated') {
          next.gate = { ...s.gate, [projectId]: { reason: result.reason, at: now() } }
        } else if (result.reason === 'not-found') {
          next.missing = {
            ...s.missing,
            [projectId]: { ...s.missing[projectId], [key]: now() }
          }
        }
        return next as GitHubLinksState
      })
    } catch {
      set((s) => {
        const pending = { ...s.pending[projectId] }
        delete pending[key]
        return { pending: { ...s.pending, [projectId]: pending } }
      })
    }
  },

  /** Warm every chip from a board load: the pages the board just paged are the same items a chip
   *  would ask for one at a time. Free — nothing is fetched here. */
  seedFromPages(projectId, pages) {
    const at = now()
    const entries: Record<string, CardEntry> = {}
    for (const page of pages) {
      for (const item of page.items) {
        entries[linkKey({ kind: item.pull ? 'pull' : 'issue', number: item.number })] = { card: item, at }
      }
    }
    if (!Object.keys(entries).length) return
    set((s) => ({
      cards: { ...s.cards, [projectId]: { ...s.cards[projectId], ...entries } }
    }))
  },

  /** Drop what a host delta invalidated. No numbers = the whole project (a cache clear, a
   *  configuration change), including the gate — the refusal may be what just changed. */
  invalidate(projectId, numbers) {
    set((s) => {
      if (!numbers) {
        const cards = { ...s.cards }
        const missing = { ...s.missing }
        const gate = { ...s.gate }
        delete cards[projectId]
        delete missing[projectId]
        delete gate[projectId]
        return { cards, missing, gate }
      }
      const wanted = new Set(numbers)
      const drop = (record: Record<string, unknown> | undefined): Record<string, never> =>
        Object.fromEntries(Object.entries(record ?? {})
          .filter(([key]) => !wanted.has(Number(key.split('#')[1])))) as Record<string, never>
      return {
        cards: { ...s.cards, [projectId]: drop(s.cards[projectId]) as Record<string, CardEntry> },
        missing: { ...s.missing, [projectId]: drop(s.missing[projectId]) as Record<string, number> }
      }
    })
  }
}))

/** The card a chip should paint with, or undefined while none is known. */
export function linkCard(
  projectId: string,
  link: Pick<GitHubLink, 'kind' | 'number'>
): GitHubIssueCardView | undefined {
  return useGitHubLinks.getState().cards[projectId]?.[linkKey(link)]?.card
}
