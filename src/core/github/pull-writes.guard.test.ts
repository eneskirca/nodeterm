// The pull node's GitHub writes (comment, line comment, review, merge, request reviewer, update branch, auto-merge on and off) and "New pull
// request"'s create happen only on a user's click.
// No canvas-control path may reach them: an agent's verb must never post to GitHub (spec: "no
// canvas-control command calls a write"). This pins it at the source of every control shell.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const CONTROL_SOURCES = [
  'src/core/canvas-control-core.ts',
  'src/core/github/control-read.ts',
  'src/main/canvas-control.ts',
  'src/main/control-forward.ts',
  'src/main/github-control.ts',
  'src/server/canvas-control.ts',
  // The agent's pull node verbs (#19): parse, store and the renderer dispatch only stage or move the view.
  'src/shared/pull-agent-verbs.ts',
  'src/renderer/state/pullAgent.ts',
  'src/renderer/canvas/Canvas.tsx'
]
const WRITES =
  /commentOnPull|reviewPull|mergePull|githubIssuesPullComment|githubIssuesPullReview|githubIssuesPullMerge|pull-comment|pull-review|pull-merge|createIssueComment|requestPullReviewer|githubIssuesPullRequestReviewer|pull-request-reviewer|commentOnPullLine|createPullLineComment|githubIssuesPullLineComment|pull-line-comment|\bcreatePull\b|githubIssuesPullCreate|pull-create|updatePullBranch|githubIssuesPullUpdateBranch|pull-update-branch|PullAutoMerge|pull-auto-merge/

describe('pull writes guard', () => {
  it.each(CONTROL_SOURCES)('%s names no pull write', (file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    expect(source.match(WRITES)?.[0]).toBeUndefined()
  })
})
