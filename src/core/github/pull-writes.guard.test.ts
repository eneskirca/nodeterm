// The pull node's GitHub writes (comment, review, merge) happen only on a user's click.
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
  'src/server/canvas-control.ts'
]
const WRITES =
  /commentOnPull|reviewPull|mergePull|githubIssuesPullComment|githubIssuesPullReview|githubIssuesPullMerge|pull-comment|pull-review|pull-merge|createIssueComment/

describe('pull writes guard', () => {
  it.each(CONTROL_SOURCES)('%s names no pull write', (file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    expect(source.match(WRITES)?.[0]).toBeUndefined()
  })
})
