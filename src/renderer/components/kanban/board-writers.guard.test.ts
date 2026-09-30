import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * "A hook `done` never moves a card" is a property of what DOESN'T exist: nowhere in the renderer
 * is a board assignment or a GitHub issue move written in response to agent status. A test that
 * flips an agent to `done` and watches one component cannot prove that — the write it guards
 * against would live somewhere else (a hook listener in Canvas, a status store subscription). So
 * this enumerates EVERY call site that writes a board: each one is listed with the human or agent
 * ACTION that triggers it. A new writer fails this test until someone adds it here and signs for
 * its trigger — and "an agent's turn ended" is not an acceptable one. `done` means a turn ended,
 * not that the work did: cards move when a person drags them, a session `assign`s itself, or — only
 * where a person switched it on — every pull request linked to a session card has merged.
 *
 * Scope: the renderer, where the agent-status store and every board surface live. The core's relay
 * verbs (`projects.setCardColumn`) are phone-initiated and are not reachable from a hook.
 */
const RENDERER = path.resolve(__dirname, '../..')

/** file (relative to src/renderer) → the triggers of its board writes, one entry per call site. */
const BOARD_WRITERS: Record<string, string[]> = {
  'canvas/Canvas.tsx': [
    'onKanbanChange — the per-project board committing a person\'s drag/edit',
    'createNodeInColumn — a person\'s "+ New" in a column',
    'fileIssueSession — a person\'s "Start with agent" or "Start with agent in a new worktree" filing ' +
      'the new session under the issue card\'s column; also board dispatch, whose only trigger is a ' +
      'person moving the issue card into the dispatch column they switched on for this machine ' +
      '(lib/board-dispatch.guard.test pins that)',
    'the `assign` control verb — a session moving its OWN card (the issue-bound contract)',
    'autoMoveCardFromPulls — the merge-driven move: a person switched it on for this machine in ' +
      'Settings, and it fires only on a pull request MERGE this machine observed after that (never on ' +
      'agent status), after winning the host\'s one-time claim; session cards only'
  ],
  'components/kanban/GlobalKanbanView.tsx': ['onChangeBoard — the Omni board committing a person\'s drag/edit'],
  'components/kanban/NodeLabels.tsx': ['a person editing a node\'s labels'],
  'components/settings/sections/GitHubIssuesSection.tsx': ['a person editing the board\'s GitHub config'],
  'components/kanban/KanbanView.tsx': [
    'moveIssueByUser — called only by requestGitHubMove (a person moving an issue card: drag, Move ' +
      'select, summary modal) and the close/reopen ConfirmDialog (a person confirming that move)'
  ],
  'state/githubIssues.ts': ['the store\'s `move`, called only by the KanbanView site above']
}

const WRITER = /\bsetProjectKanban\(|\bmoveGitHubState\(|\.moveIssue\(/g
// The store's own declaration/implementation of setProjectKanban is not a call site.
const DECLARATION = /setProjectKanban\((id: string|id, kanban\))/

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sources(full))
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

describe('board writers (why a hook `done` can never move a card)', () => {
  it('every renderer call site that writes a board assignment or moves an issue is signed for', () => {
    const found: Record<string, number> = {}
    for (const file of sources(RENDERER)) {
      const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')
      let count = 0
      for (const line of lines) {
        const t = line.trim()
        if (t.startsWith('//') || t.startsWith('*') || DECLARATION.test(t)) continue
        count += (t.match(WRITER) ?? []).length
      }
      if (count) found[path.relative(RENDERER, file).split(path.sep).join('/')] = count
    }
    const expected = Object.fromEntries(Object.entries(BOARD_WRITERS).map(([f, why]) => [f, why.length]))
    expect(found).toEqual(expected)
  })

  it('the agent-status side of the issue binding writes nothing', () => {
    for (const rel of ['state/agentStatus.ts', 'lib/issueRuns.ts', 'components/kanban/IssueRunChips.tsx']) {
      const src = readFileSync(path.join(RENDERER, rel), 'utf8')
      expect(src, rel).not.toMatch(/setProjectKanban|assignNode|moveIssue|moveGitHubState/)
    }
  })
})
