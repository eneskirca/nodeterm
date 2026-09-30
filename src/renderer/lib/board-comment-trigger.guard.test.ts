/**
 * WHO MAY START A BOARD-COMMENT DELIVERY — exactly one place: the comment composer's send. A comment
 * that ARRIVES in the log (git pull, another instance, a relay peer, a team-presence guest) must never
 * type into a pane, and the only way to keep that true as code grows is that no other code path can
 * reach the delivery at all. This scan fails on a second caller, so adding one is a decision somebody
 * signs for here, with its reason — the same shape as `board-writers.guard.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const callers = (re: RegExp): string[] =>
  walk('src/renderer')
    .filter((f) => re.test(readFileSync(f, 'utf8')))
    .map((f) => relative('.', f).split('\\').join('/'))
    .sort()

describe('board-comment delivery has one trigger', () => {
  it('deliverCommentMentions is called only by the composer', () => {
    expect(callers(/\bdeliverCommentMentions\(/)).toEqual([
      // the definition
      'src/renderer/lib/boardCommentDelivery.ts',
      // BoardLogPanel's send handler — the text the user just typed, in this window
      'src/renderer/components/kanban/BoardLogPanel.tsx'
    ].sort())
  })

  it('the IPC is reached only through the deliverer Canvas registers', () => {
    expect(callers(/\.deliverBoardComment\(/)).toEqual(['src/renderer/canvas/Canvas.tsx'])
  })
})
