// What a board move actually DOES to a GitHub issue — decided in one pure place so the drop
// handler, the card's Move selector and the summary modal cannot disagree about it.
//
// Moving a card is not a board-local edit: reaching the completion column closes the issue on
// GitHub and leaving it reopens the issue, which emails every subscriber and writes the issue's
// public timeline. Neither is undoable from here. Closed issues all map INTO the completion
// column, so that column fills with historical closed work, and the Ungrouped column — the easiest
// drop target to hit by accident — counts as "outside completion", i.e. a reopen. A drag is a
// cheap, easily mis-aimed gesture; the outcome is not. So state-changing moves ask first, and
// label-only moves stay immediate.

export type GitHubMoveIntentKind = 'noop' | 'labels-only' | 'close' | 'reopen'

export interface GitHubMoveIntent {
  kind: GitHubMoveIntentKind
}

export interface GitHubMoveConfirmation {
  message: string
  confirmLabel: string
  danger: boolean
}

interface MovableIssue {
  number: number
  title: string
  state: 'open' | 'closed'
  columnId: string | null
}

export function githubMoveIntent(
  issue: MovableIssue,
  toColumnId: string | null,
  completionColumnId: string | undefined
): GitHubMoveIntent {
  if (issue.columnId === toColumnId) return { kind: 'noop' }
  // With no completion column configured the service refuses writes outright, so nothing here can
  // change state — every move is a relabel.
  if (!completionColumnId) return { kind: 'labels-only' }
  if (toColumnId === completionColumnId && issue.state === 'open') return { kind: 'close' }
  if (toColumnId !== completionColumnId && issue.state === 'closed') return { kind: 'reopen' }
  return { kind: 'labels-only' }
}

/** The dialog to show before the move, or null when the move needs no confirmation. */
export function githubMoveConfirmation(
  issue: MovableIssue,
  toColumnId: string | null,
  completionColumnId: string | undefined
): GitHubMoveConfirmation | null {
  const { kind } = githubMoveIntent(issue, toColumnId, completionColumnId)
  const name = `#${issue.number} ${issue.title}`
  if (kind === 'close') {
    return {
      message: `Close ${name} on GitHub? Everyone watching the issue is notified.`,
      confirmLabel: 'Close issue',
      danger: true
    }
  }
  if (kind === 'reopen') {
    return {
      message: `Reopen ${name} on GitHub? Everyone watching the issue is notified.`,
      confirmLabel: 'Reopen issue',
      danger: true
    }
  }
  return null
}
