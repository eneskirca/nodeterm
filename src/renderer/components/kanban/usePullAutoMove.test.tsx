// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import { useProjects } from '../../state/projects'
import { useSettings } from '../../state/settings'
import { planPullAutoMoves } from '../../lib/pullAutoMove'
import { autoMoveCardsSig, REFUSED_CLAIM_RETRY_MS, usePullAutoMove } from './usePullAutoMove'

// The real planner, counted: a pass that re-plans an unchanged board is the chatter this pins.
vi.mock('../../lib/pullAutoMove', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pullAutoMove')>()
  return { ...actual, planPullAutoMoves: vi.fn(actual.planPullAutoMoves) }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const board: ProjectKanban = {
  columns: [{ id: 'doing', title: 'Doing', color: '#fff' }, { id: 'done', title: 'Done', color: '#fff' }],
  assignments: [{ nodeId: 'card-1', columnId: 'doing' }],
  github: { columnMappings: [], repository: 'o/r' }
}
const cards = [{ id: 'card-1', kind: 'terminal', worktreeBranch: 'feat/x' }]
const merged: GitHubPullBoard = {
  pulls: [{ number: 12, lifecycle: 'merged', headRefName: 'feat/x', closes: [], openSeen: true, mergedSeenAt: 2_000 }],
  observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
}

/** The host's rules, like GitHubPullStatusTracker: a claim needs a PR that has not moved this card
 *  yet and that the card was noted waiting on; claims are per PR. `seedWaits` stands in for notes
 *  recorded while the PR was open. */
function hostClaims(seedWaits: string[] = ['p1:card-1:12']) {
  const claimed = new Set<string>()
  const waits = new Set(seedWaits)
  return {
    waits,
    notePullWaits: vi.fn(async (request: { projectId: string; cardId: string; pulls: number[] }) => {
      for (const pull of request.pulls) waits.add(`${request.projectId}:${request.cardId}:${pull}`)
      return request.pulls.length
    }),
    claimPullAutoMove: vi.fn(async (request: { projectId: string; cardId: string; pulls: number[] }) => {
      const key = (pull: number): string => `${request.projectId}:${request.cardId}:${pull}`
      const fresh = request.pulls.filter((pull) => !claimed.has(key(pull)))
      if (!fresh.some((pull) => waits.has(key(pull)))) return false
      for (const pull of fresh) claimed.add(key(pull))
      return true
    })
  }
}

function Probe(props: {
  api: Pick<ReturnType<typeof hostClaims>, 'claimPullAutoMove' | 'notePullWaits'>
  pullBoard: GitHubPullBoard
  onAutoMove: (...args: unknown[]) => void
  cards?: typeof cards
  board?: ProjectKanban
}): null {
  usePullAutoMove({
    api: props.api, projectId: 'p1', cards: props.cards ?? cards, board: props.board ?? board,
    pullBoard: props.pullBoard, onAutoMove: props.onAutoMove
  })
  return null
}

/** What the board hands the hook on every canvas change: the same cards, in a fresh array of fresh
 *  objects (`sessions` is re-derived from the React Flow nodes each time). */
const freshCards = (): typeof cards => cards.map((card) => ({ ...card }))

function arm(remote = false): void {
  useProjects.setState({
    activeProjectId: 'p1',
    projects: [{ id: 'p1', name: 'P', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ...(remote ? { remote: true } : {}) }]
  } as never)
  useSettings.setState({
    settings: { ...useSettings.getState().settings, kanbanPullAutoMove: { projects: { p1: { columnId: 'done', armedAt: 1_000 } } } }
  })
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

beforeEach(() => arm())

describe('usePullAutoMove', () => {
  it('moves once after winning the host claim, and never writes settings', async () => {
    const api = hostClaims()
    const onAutoMove = vi.fn()
    const before = useSettings.getState().settings
    const root = createRoot(document.createElement('div'))
    act(() => root.render(<Probe api={api} pullBoard={merged} onAutoMove={onAutoMove} />))
    act(() => root.render(<Probe api={api} pullBoard={{ ...merged }} onAutoMove={onAutoMove} />))
    await settle()
    expect(onAutoMove).toHaveBeenCalledTimes(1)
    expect(onAutoMove).toHaveBeenCalledWith('card-1', 'doing', 'done', 'PR #12 merged')
    expect(api.claimPullAutoMove).toHaveBeenCalledWith({ projectId: 'p1', cardId: 'card-1', pulls: [12] })
    expect(useSettings.getState().settings).toBe(before)
  })

  it('two windows on one host: only the one that wins the claim moves the card', async () => {
    const api = hostClaims()
    const first = vi.fn()
    const second = vi.fn()
    act(() => createRoot(document.createElement('div')).render(<Probe api={api} pullBoard={merged} onAutoMove={first} />))
    act(() => createRoot(document.createElement('div')).render(<Probe api={api} pullBoard={merged} onAutoMove={second} />))
    await settle()
    expect(first.mock.calls.length + second.mock.calls.length).toBe(1)
  })

  it('notes the wait while the PR is open, then moves on the merge', async () => {
    const api = hostClaims([])
    const onAutoMove = vi.fn()
    const open: GitHubPullBoard = { ...merged, pulls: [{ number: 12, lifecycle: 'open', headRefName: 'feat/x', closes: [] }] }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(<Probe api={api} pullBoard={open} onAutoMove={onAutoMove} />))
    await settle()
    expect(api.notePullWaits).toHaveBeenCalledWith({ projectId: 'p1', cardId: 'card-1', pulls: [12] })
    act(() => root.render(<Probe api={api} pullBoard={merged} onAutoMove={onAutoMove} />))
    await settle()
    expect(onAutoMove).toHaveBeenCalledTimes(1)
  })

  it('a card that first appears after the merge never moves', async () => {
    const api = hostClaims([])
    const onAutoMove = vi.fn()
    act(() => createRoot(document.createElement('div')).render(<Probe api={api} pullBoard={merged} onAutoMove={onAutoMove} />))
    await settle()
    expect(api.claimPullAutoMove).toHaveBeenCalled()
    expect(onAutoMove).not.toHaveBeenCalled()
  })

  it('a dragged-back card asks the host once, not once per canvas change', async () => {
    // The claim for #12 was spent when the card first moved; the user then dragged it back.
    const api = hostClaims()
    await api.claimPullAutoMove({ projectId: 'p1', cardId: 'card-1', pulls: [12] })
    api.claimPullAutoMove.mockClear()
    const onAutoMove = vi.fn()
    const root = createRoot(document.createElement('div'))
    for (let change = 0; change < 5; change++) {
      act(() => root.render(<Probe api={api} pullBoard={merged} onAutoMove={onAutoMove} cards={freshCards()} />))
      await settle()
    }
    expect(api.claimPullAutoMove).toHaveBeenCalledTimes(1)
    expect(onAutoMove).not.toHaveBeenCalled()
  })

  it('re-plans only when something the planner reads about the cards changed', async () => {
    const api = hostClaims()
    // KanbanView hands a memoized callback; only the cards array is fresh on each canvas change.
    const onAutoMove = vi.fn()
    const root = createRoot(document.createElement('div'))
    act(() => root.render(<Probe api={api} pullBoard={merged} onAutoMove={onAutoMove} cards={freshCards()} />))
    const plan = vi.mocked(planPullAutoMoves)
    const before = plan.mock.calls.length
    for (let change = 0; change < 4; change++) {
      act(() => root.render(<Probe api={api} pullBoard={merged} onAutoMove={onAutoMove} cards={freshCards()} />))
    }
    expect(plan.mock.calls.length).toBe(before)
    act(() => root.render(<Probe api={api} pullBoard={merged} onAutoMove={onAutoMove}
      cards={[{ ...cards[0], worktreeBranch: 'feat/y' }]} />))
    expect(plan.mock.calls.length).toBe(before + 1)
    await settle()
  })

  it('the card signature cannot be forged by an id carrying separators', () => {
    expect(autoMoveCardsSig([{ id: 'a","terminal","feat/x', kind: 'sticky' }]))
      .not.toBe(autoMoveCardsSig([{ id: 'a', kind: 'terminal', worktreeBranch: 'feat/x' }]))
  })

  it('asks again after a refusal once the retry window passes — a refusal can be transient', async () => {
    // The host refuses while it is not bound to the project yet (or mid cache-clear); remembering
    // that answer for the board's lifetime would lose the move until the board was reopened.
    let clock = 1_000_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      let bound = false
      const api = {
        notePullWaits: vi.fn(async () => 0),
        claimPullAutoMove: vi.fn(async () => bound)
      }
      const onAutoMove = vi.fn()
      const root = createRoot(document.createElement('div'))
      act(() => root.render(<Probe api={api} pullBoard={merged} onAutoMove={onAutoMove} />))
      await settle()
      expect(api.claimPullAutoMove).toHaveBeenCalledTimes(1)
      bound = true
      // Inside the window: a fresh read does not re-ask.
      clock += REFUSED_CLAIM_RETRY_MS - 1
      act(() => root.render(<Probe api={api} pullBoard={{ ...merged }} onAutoMove={onAutoMove} />))
      await settle()
      expect(api.claimPullAutoMove).toHaveBeenCalledTimes(1)
      // Past it: the next read asks again, wins, and moves the card.
      clock += 2
      act(() => root.render(<Probe api={api} pullBoard={{ ...merged }} onAutoMove={onAutoMove} />))
      await settle()
      expect(api.claimPullAutoMove).toHaveBeenCalledTimes(2)
      expect(onAutoMove).toHaveBeenCalledTimes(1)
      // A WON claim is never asked again, however long the board stays open.
      clock += 10 * REFUSED_CLAIM_RETRY_MS
      act(() => root.render(<Probe api={api} pullBoard={{ ...merged }} onAutoMove={onAutoMove} />))
      await settle()
      expect(api.claimPullAutoMove).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  it('does not send a second claim while the first is still in flight', async () => {
    const pending = new Promise<boolean>(() => undefined)
    const api = { notePullWaits: vi.fn(async () => 0), claimPullAutoMove: vi.fn(() => pending) }
    const onAutoMove = vi.fn()
    const root = createRoot(document.createElement('div'))
    for (let change = 0; change < 3; change++) {
      act(() => root.render(
        <Probe api={api} pullBoard={{ ...merged }} onAutoMove={onAutoMove} cards={freshCards()} />
      ))
    }
    await settle()
    expect(api.claimPullAutoMove).toHaveBeenCalledTimes(1)
  })

  it('asks again when a NEW merge joins the card\'s set, and after a failed call', async () => {
    const api = hostClaims()
    await api.claimPullAutoMove({ projectId: 'p1', cardId: 'card-1', pulls: [12] })
    api.claimPullAutoMove.mockClear()
    const onAutoMove = vi.fn()
    const root = createRoot(document.createElement('div'))
    act(() => root.render(<Probe api={api} pullBoard={merged} onAutoMove={onAutoMove} />))
    await settle()
    expect(api.claimPullAutoMove).toHaveBeenCalledTimes(1)
    const again: GitHubPullBoard = {
      ...merged,
      pulls: [...merged.pulls, { number: 20, lifecycle: 'merged', headRefName: 'feat/x', closes: [], openSeen: true, mergedSeenAt: 3_000 }]
    }
    api.waits.add('p1:card-1:20')
    act(() => root.render(<Probe api={api} pullBoard={again} onAutoMove={onAutoMove} />))
    await settle()
    expect(api.claimPullAutoMove).toHaveBeenLastCalledWith({ projectId: 'p1', cardId: 'card-1', pulls: [12, 20] })
    expect(onAutoMove).toHaveBeenCalledTimes(1)

    // An IPC that failed was never answered: the next pass may ask again.
    const failing = { notePullWaits: vi.fn(async () => 0), claimPullAutoMove: vi.fn(async () => { throw new Error('offline') }) }
    const other = createRoot(document.createElement('div'))
    act(() => other.render(<Probe api={failing} pullBoard={merged} onAutoMove={vi.fn()} />))
    await settle()
    act(() => other.render(<Probe api={failing} pullBoard={{ ...merged }} onAutoMove={vi.fn()} />))
    await settle()
    expect(failing.claimPullAutoMove).toHaveBeenCalledTimes(2)
  })

  it('never moves a card on a relay tab — that board belongs to the other machine', async () => {
    arm(true)
    const api = hostClaims()
    const onAutoMove = vi.fn()
    act(() => createRoot(document.createElement('div')).render(<Probe api={api} pullBoard={merged} onAutoMove={onAutoMove} />))
    await settle()
    expect(onAutoMove).not.toHaveBeenCalled()
    expect(api.claimPullAutoMove).not.toHaveBeenCalled()
  })
})
