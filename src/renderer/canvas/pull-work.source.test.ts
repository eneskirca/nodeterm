import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * STRUCTURAL pins for the pull node's "Work on this PR" inside Canvas.tsx (no unit seam in a
 * 15,000-line component). The behaviour is proven elsewhere: naming, collisions, fetch argv and the
 * prompt in `shared/pull-work.test.ts`, the git steps on real repositories in
 * `core/git-service.pull-worktree.test.ts`, the button in `nodes/PullNodeView.test.tsx`.
 */
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const src = read(new URL('./Canvas.tsx', import.meta.url).pathname)
const code = (body: string): string => body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

describe('Work on this PR', () => {
  it('is sent only by the pull node (a user click), never by a control verb', () => {
    const root = new URL('../../', import.meta.url).pathname
    const senders = files(root).filter((p) => /PULL_WORK_EVENT|nodeterm:pull-work/.test(read(p)))
      .map((p) => p.slice(root.length)).sort()
    expect(senders).toEqual(['renderer/canvas/Canvas.tsx', 'renderer/nodes/PullNode.tsx', 'shared/pull-work.ts'])
    expect(code(src).match(/dispatchEvent\([^)]*PULL_WORK_EVENT/g) ?? []).toHaveLength(0)
  })

  it('opens a fresh worktree through the core pull checkout, with the prompt from pullWorkPrompt and a rope', () => {
    const a = src.indexOf('window.addEventListener(ISSUE_WORK_EVENT, listener)')
    const listener = code(src.slice(src.indexOf('const onWork = async', a), src.indexOf('window.addEventListener(PULL_WORK_EVENT, listener)')))
    expect(listener).toContain("n.type === 'pull'")
    expect(listener).toContain('issueWorktreeUnavailable()')
    expect(listener).toContain('planPullWorktree(')
    expect(listener).toContain('api.git.pullWorktreeAdd(')
    expect(listener).not.toContain('api.git.worktreeAdd(')
    expect(listener).toContain("mode: 'new'")
    expect(listener).toContain('opener: source.id')
    expect(code(src).match(/pullWorkPrompt\(/g) ?? []).toHaveLength(1)
    expect(listener).not.toMatch(/pr\.title|pr\.body/)
    expect(listener).toContain('launchOrSpill(prompt, true, api.files.saveUpload)')
    // One spill-or-fallback block for both "Work on this" paths.
    expect(code(src).match(/promptExceedsLineBudget\(/g) ?? []).toHaveLength(1)
  })
})
