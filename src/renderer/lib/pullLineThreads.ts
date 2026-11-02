import type { PullDiffSide, PullLineComment } from '@shared/github-pull-detail'

/** One thread of line comments: the first comment and its replies, oldest first. */
export interface PullLineThread {
  /** The first comment's id: what a reply names as `inReplyTo`. */
  id: number
  side: PullDiffSide
  /** Null = not on a current line (outdated, or on the whole file). */
  line: number | null
  outdated: boolean
  comments: PullLineComment[]
}

/** The threads on one file, by line. A reply whose first comment is not in the list starts its own. */
export function pullLineThreads(comments: readonly PullLineComment[], path: string): PullLineThread[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]))
  const rootOf = (comment: PullLineComment): PullLineComment => {
    const seen = new Set<number>()
    let at = comment
    while (at.inReplyTo !== undefined && byId.has(at.inReplyTo) && !seen.has(at.id)) {
      seen.add(at.id)
      at = byId.get(at.inReplyTo)!
    }
    return at
  }
  const threads = new Map<number, PullLineThread>()
  for (const comment of comments) {
    if (comment.path !== path) continue
    const root = rootOf(comment)
    let thread = threads.get(root.id)
    if (!thread) {
      thread = { id: root.id, side: root.side, line: root.line, outdated: root.outdated, comments: [] }
      threads.set(root.id, thread)
    }
    thread.comments.push(comment)
  }
  const list = [...threads.values()]
  for (const thread of list) thread.comments.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id)
  return list.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity) || a.id - b.id)
}
