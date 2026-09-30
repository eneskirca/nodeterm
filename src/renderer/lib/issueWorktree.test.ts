import { describe, expect, it } from 'vitest'
import { createAgentNode, terminalNodeSize } from '../state/workspace'
import { GROUP_PAD_TOP, GROUP_PAD_X } from './coldOpen'
import {
  frameAgentPlacement,
  issueWorktreeFrames,
  runExclusive,
  ISSUE_WORKTREE_LABEL,
  ISSUE_WORKTREE_NO_REPO_HINT,
  ISSUE_WORKTREE_RELAY_HINT,
  issueWorktreeChoiceCopy,
  issueWorktreeMenuRow,
  issueWorktreeRefusal,
  issueWorktreeRenamedNotice
} from './issueWorktree'
import { WORKTREE_NO_CWD_HINT, WORKTREE_SSH_HINT } from './addMenuSpec'
import type { MenuItem } from '../components/ContextMenu'

const OK = { relay: false, ssh: false, cwd: '/work/repo', repoRoot: '/work/repo' }

describe('issueWorktreeRefusal', () => {
  it('lets a local project with a repository through', () => {
    expect(issueWorktreeRefusal(OK)).toBeNull()
  })

  it('refuses the surfaces worktrees do not reach in v1, each with its own reason', () => {
    expect(issueWorktreeRefusal({ ...OK, relay: true })).toBe(ISSUE_WORKTREE_RELAY_HINT)
    expect(issueWorktreeRefusal({ ...OK, ssh: true })).toBe(WORKTREE_SSH_HINT)
    expect(issueWorktreeRefusal({ ...OK, cwd: undefined })).toBe(WORKTREE_NO_CWD_HINT)
    expect(issueWorktreeRefusal({ ...OK, cwd: '  ' })).toBe(WORKTREE_NO_CWD_HINT)
    expect(issueWorktreeRefusal({ ...OK, repoRoot: null })).toBe(ISSUE_WORKTREE_NO_REPO_HINT)
  })

  it('names the tab kind before anything about its project (a shared tab is refused as such)', () => {
    expect(issueWorktreeRefusal({ relay: true, ssh: true, cwd: undefined, repoRoot: null })).toBe(
      ISSUE_WORKTREE_RELAY_HINT
    )
    // An SSH project has no LOCAL folder or repository to speak of — say SSH, not "no folder".
    expect(issueWorktreeRefusal({ relay: false, ssh: true, cwd: undefined, repoRoot: null })).toBe(
      WORKTREE_SSH_HINT
    )
  })
})

describe('issueWorktreeMenuRow', () => {
  it('is a submenu of the agent rows when the action can run', () => {
    const items: MenuItem[] = [{ label: 'Claude', onClick: () => {} }]
    expect(issueWorktreeMenuRow({ items })).toEqual({
      type: 'submenu',
      label: ISSUE_WORKTREE_LABEL,
      icon: undefined,
      children: items
    })
  })

  it('is the same label DISABLED with the reason when it cannot — never a missing row', () => {
    const row = issueWorktreeMenuRow({ refusal: WORKTREE_SSH_HINT })
    expect(row).toMatchObject({ label: ISSUE_WORKTREE_LABEL, disabled: true, hint: WORKTREE_SSH_HINT })
  })
})

describe('issueWorktreeChoiceCopy', () => {
  const alt = { branch: 'issue-12-fix-2', path: '/w/issue-12-fix-2' }

  it('offers reuse (preselected) and a DIFFERENT new branch, and promises nothing is overwritten', () => {
    const copy = issueWorktreeChoiceCopy(
      12,
      { kind: 'bound', groupId: 'g', branch: 'issue-12-fix', path: '/w/issue-12-fix' },
      alt,
      'main'
    )
    expect(copy.value).toBe('reuse')
    expect(copy.options.map((o) => o.value)).toEqual(['reuse', 'new'])
    expect(copy.message).toContain('issue-12-fix')
    expect(copy.message).toContain('Nothing will be overwritten')
    expect(copy.options[1].label).toContain('issue-12-fix-2 off main')
  })

  it('says an adopted worktree is not the app\'s to delete', () => {
    const copy = issueWorktreeChoiceCopy(
      12,
      {
        kind: 'orphan',
        branch: 'issue-12-fix',
        path: '/w/issue-12-fix',
        entry: { path: '/w/issue-12-fix', branch: 'issue-12-fix', head: 'a', isBare: false }
      },
      alt,
      'main'
    )
    expect(copy.options[0].label).toContain('Remove will not delete')
  })

  it('offers to check out an existing branch, and only reuse when no free name is left', () => {
    const copy = issueWorktreeChoiceCopy(
      12,
      { kind: 'branch', branch: 'issue-12-fix', path: '/w/issue-12-fix' },
      null,
      'main'
    )
    expect(copy.options).toHaveLength(1)
    expect(copy.options[0].label).toBe('Check out issue-12-fix in a new worktree at /w/issue-12-fix')
    expect(copy.message).toContain('only reuse is offered')
  })
})

describe('issueWorktreeRenamedNotice', () => {
  it('says why the new worktree has a suffix', () => {
    expect(issueWorktreeRenamedNotice('issue-12-fix', 'issue-12-fix-2')).toBe(
      'issue-12-fix was already taken (a local or remote branch, or a folder, of that name exists), so the new worktree is issue-12-fix-2.'
    )
  })
})

describe('frameAgentPlacement', () => {
  const size = terminalNodeSize()
  const origin = { x: 1000, y: 2000 }

  it('hands addAgentNode a CENTER whose node lands at the frame\'s first slot, inside the frame', () => {
    const { center, frame } = frameAgentPlacement(origin, 0, size)
    // The REAL factory, which centres the node on the point it is given.
    const node = createAgentNode('claude', 0, '/w', center)
    expect(node.position).toEqual({ x: origin.x + GROUP_PAD_X, y: origin.y + GROUP_PAD_TOP })
    // Below the label band (the frame's drag handle), and wholly inside the frame.
    expect(node.position.y - origin.y).toBeGreaterThanOrEqual(GROUP_PAD_TOP)
    expect(node.position.x + (node.width as number)).toBeLessThanOrEqual(origin.x + frame.width)
    expect(node.position.y + (node.height as number)).toBeLessThanOrEqual(origin.y + frame.height)
  })

  it('a second agent takes the next slot without overlapping the first, and the frame grows to hold both', () => {
    const first = createAgentNode('claude', 0, '/w', frameAgentPlacement(origin, 0, size).center)
    const next = frameAgentPlacement(origin, 1, size)
    const second = createAgentNode('claude', 1, '/w', next.center)
    expect(second.position.x).toBeGreaterThanOrEqual(first.position.x + (first.width as number))
    expect(second.position.y).toBe(first.position.y)
    expect(second.position.x + (second.width as number)).toBeLessThanOrEqual(origin.x + next.frame.width)
  })
})

describe('runExclusive', () => {
  it('refuses a second start while the first is running, and frees the key when it ends', async () => {
    const inFlight = new Set<string>()
    let release!: () => void
    const first = runExclusive(inFlight, 'o/r#12', () => new Promise<void>((r) => (release = r)))
    expect(await runExclusive(inFlight, 'o/r#12', async () => {})).toBe(false)
    // Another issue is not blocked.
    expect(await runExclusive(inFlight, 'o/r#13', async () => {})).toBe(true)
    release()
    expect(await first).toBe(true)
    expect(inFlight.has('o/r#12')).toBe(false)
    expect(await runExclusive(inFlight, 'o/r#12', async () => {})).toBe(true)
  })

  it('frees the key when the task throws', async () => {
    const inFlight = new Set<string>()
    await expect(
      runExclusive(inFlight, 'k', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(inFlight.has('k')).toBe(false)
  })
})

describe('issueWorktreeFrames', () => {
  const frame = (id: string, repoPath: string, branch: string) => ({
    id,
    type: 'group',
    data: { worktree: { repoPath, branch, baseRef: 'main', path: `/wt/${branch}`, createdByApp: true } }
  })

  it('offers only frames bound to a worktree of THIS repository, and never a stale one', () => {
    const nodes = [
      frame('mine', '/work/repo', 'issue-12-fix'),
      frame('mine-trailing-slash', '/work/repo/', 'issue-12-b'),
      // Another repository's frame (a pasted or hostile project.json) — never "Reuse".
      frame('foreign', '/elsewhere/other', 'issue-12-fix'),
      frame('stale', '/work/repo', 'issue-12-gone'),
      { id: 'plain', type: 'group', data: {} },
      { id: 'term', type: 'terminal', data: {} }
    ]
    expect(issueWorktreeFrames(nodes, '/work/repo', ['stale']).map((f) => f.groupId)).toEqual([
      'mine',
      'mine-trailing-slash'
    ])
  })
})
