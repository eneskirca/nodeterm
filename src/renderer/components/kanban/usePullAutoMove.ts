import { useEffect, useMemo, useRef } from 'react'
import type { ProjectKanban } from '@shared/types'
import type { GitHubIssuesApi } from '@shared/github-issues'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import type { IssueRef } from '@shared/github-issue-ref'
import { sanitizeKanbanPullAutoMove } from '@shared/kanban-pull-links'
import { useSettings } from '../../state/settings'
import { useProjects } from '../../state/projects'
import { autoMoveNote, planPullAutoMoves } from '../../lib/pullAutoMove'
import { documentChaseDeps, startPullChase } from '../../lib/pullChase'

/**
 * Runs the merge-driven move for SESSION cards while the board is open (the pull status it reads is
 * only fresh while a board is subscribed). All decisions are `planPullAutoMoves`, which writes
 * nothing; this glue asks the host for each move's one-time claim and applies only the moves it wins,
 * through `onAutoMove` (a compare-and-set against the latest board + the board-log line). It never
 * writes settings: a background settings write from one Server Edition tab would overwrite whatever
 * the user just changed in another.
 */
/** How long a refused move claim is remembered before the board may ask again (one pull-board read
 *  interval): long enough that a dragged-back card is not chatty, short enough that a transient
 *  refusal does not cost the move. */
export const REFUSED_CLAIM_RETRY_MS = 60_000

export function usePullAutoMove(input: {
  api: Pick<GitHubIssuesApi, 'claimPullAutoMove' | 'notePullWaits'>
  projectId: string
  cards: Array<{ id: string; kind: string; worktreeBranch?: string; issueRef?: IssueRef }>
  board: ProjectKanban
  pullBoard: GitHubPullBoard | undefined
  onAutoMove?: (cardId: string, fromColumnId: string | null, toColumnId: string, note: string) => void
}): void {
  const raw = useSettings((state) => state.settings.kanbanPullAutoMove)
  // A relay tab is another machine's project: that machine decides whether its board moves itself.
  // Settings refuses to arm one; this is the backstop for a hand-edited settings.json.
  const relay = useProjects((state) => !!state.projects.find((item) => item.id === input.projectId)?.remote)
  const entry = useMemo(
    () => relay ? undefined : sanitizeKanbanPullAutoMove(raw).projects[input.projectId],
    [raw, input.projectId, relay]
  )
  const { api, projectId, board, pullBoard, onAutoMove } = input
  // `cards` is re-derived from the canvas nodes on every canvas change, a fresh array of fresh
  // objects even when nothing the planner reads changed. Keyed on what it reads, the plan re-runs
  // only when that does.
  const cardsSig = autoMoveCardsSig(input.cards)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cards = useMemo(() => input.cards, [cardsSig])
  // The BOARD's lifetime, not one effect run: the pull board is re-read every minute, and a re-render
  // landing between a won claim and its answer must not throw the move away — the claim is spent
  // either way, so dropping it would lose the move for good.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const latest = useRef(onAutoMove)
  latest.current = onAutoMove
  // Wait notes already sent from this board, so a re-render does not re-send them (the host dedupes
  // too; this only saves the calls).
  const noted = useRef(new Set<string>())
  // Claims already asked from this board, keyed by (project, card, PR set), so a dragged-back card
  // does not ask on every canvas change, pull-board read or board edit. In flight or WON: never
  // asked again (a won claim is spent). REFUSED: asked again only after `REFUSED_CLAIM_RETRY_MS` —
  // usually a refusal is final (already moved, never seen waiting), but the host also refuses while
  // it is not bound to the project yet or is clearing its cache, and remembering THAT for the
  // board's lifetime lost the move until the board was reopened. FAILED (a rejected call): forgotten.
  // The value is when the refusal arrived; `Infinity` = in flight or won.
  const asked = useRef(new Map<string, number>())
  useEffect(() => {
    if (!entry || !onAutoMove) return
    const plan = planPullAutoMoves({ cards, board, pullBoard, entry })
    for (const wait of plan.waits) {
      // Keys carry card ids, which come from a git-shared file: JSON, never a separator join.
      const waitKey = (pull: number): string => JSON.stringify([projectId, wait.cardId, pull])
      const fresh = wait.pulls.filter((pull) => !noted.current.has(waitKey(pull)))
      if (!fresh.length) continue
      for (const pull of fresh) noted.current.add(waitKey(pull))
      void api.notePullWaits({ projectId, cardId: wait.cardId, pulls: fresh }).catch(() => {
        // Not recorded: let a later pass try again.
        for (const pull of fresh) noted.current.delete(waitKey(pull))
      })
    }
    for (const move of plan.moves) {
      const claimKey = JSON.stringify([projectId, move.cardId, move.pulls])
      const refusedAt = asked.current.get(claimKey)
      if (refusedAt !== undefined && Date.now() - refusedAt < REFUSED_CLAIM_RETRY_MS) continue
      asked.current.set(claimKey, Infinity)
      void api.claimPullAutoMove({ projectId, cardId: move.cardId, pulls: move.pulls })
        .then((claimed) => {
          if (!claimed) asked.current.set(claimKey, Date.now())
          // A claim that lands after this board closed is spent, not applied: the card stays where it
          // is, which is the safe side of a lost move. The move itself is a compare-and-set against
          // the latest board, so a late answer cannot undo a drag made meanwhile.
          if (claimed && mounted.current) {
            latest.current?.(move.cardId, move.fromColumnId, entry.columnId, autoMoveNote(move.pulls))
          }
        })
        .catch(() => { asked.current.delete(claimKey) })
    }
  }, [api, entry, cards, board, pullBoard, projectId, onAutoMove])
}

/** What the planner reads off each card, as one primitive. A card id is written through
 *  `JSON.stringify`, so no id can forge another card's fields. */
export function autoMoveCardsSig(
  cards: Array<{ id: string; kind: string; worktreeBranch?: string; issueRef?: IssueRef }>
): string {
  return JSON.stringify(cards.map((card) => [
    card.id, card.kind, card.worktreeBranch ?? null,
    card.issueRef ? [card.issueRef.owner, card.issueRef.repo, card.issueRef.number] : null
  ]))
}

/** While some PR is undecided, ask the host (only while the page is visible) whether a chase read
 *  is due. The host keeps the schedule and the cap. */
export function usePullChase(api: GitHubIssuesApi, projectId: string, undecided: boolean): void {
  useEffect(() => {
    if (!undecided || !projectId) return
    return startPullChase(documentChaseDeps(() => {
      void api.chasePulls(projectId).catch(() => undefined)
    }))
  }, [api, projectId, undecided])
}
