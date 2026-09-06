import { describe, it, expect } from 'vitest'
import {
  descendantIds,
  displacedByWorktree,
  isInsideDir,
  sanitizeWorktreeBranch,
  computeWorktreePath,
  resolveWorktreePath,
  parseWorktreePorcelain,
  isDangerousWorktreeRemovalPath,
  decideMergeStrategy,
  isRemoteSessionNode,
  isValidGitRef,
  resolveBaseRef,
  resolveWorktreeBase,
  type WorktreeBaseNode,
  worktreeFromCreate,
  worktreeFromEntry,
  worktreeRemoveMessage,
  effectiveWorktreeBaseRef,
  effectiveWorktreeTemplate,
  DEFAULT_BASE_REF,
  DEFAULT_WORKTREE_PATH_TEMPLATE,
  type WorktreeEntry,
  type ProjectWorktreeDefaults
} from './worktree'
import { filterWorktrees } from './worktree'

const entry = (path: string, branch: string | null): WorktreeEntry => ({
  path,
  branch,
  head: 'abc',
  isBare: false
})

// Worktrees are local-only in v1, and the gate that keeps a remote session out of one must ask
// about BOTH SSH markers: the exact node it exists to protect — an SSH-PROJECT terminal, created by
// `createTerminalNode(…, project.ssh)` with `data.ssh` + `data.sshRemoteTmux` — once walked straight
// through a one-field guard: ↪ destroyed its REMOTE tmux session (running processes and all) and
// respawned it in a local path that does not exist on the host.
describe('isRemoteSessionNode', () => {
  it('is true for an SSH-project terminal (data.ssh + data.sshRemoteTmux)', () => {
    expect(
      isRemoteSessionNode({
        ssh: { host: 'box', user: 'me' },
        sshRemoteTmux: true
      })
    ).toBe(true)
  })

  it('is true when only one of the two SSH markers survived a hand-edited project file', () => {
    expect(isRemoteSessionNode({ ssh: { host: 'box', user: 'me' } })).toBe(true)
    expect(isRemoteSessionNode({ sshRemoteTmux: true })).toBe(true)
  })

  it('is false for a plain local terminal (nothing changes for the local case)', () => {
    expect(isRemoteSessionNode({})).toBe(false)
    expect(isRemoteSessionNode(undefined)).toBe(false)
    expect(isRemoteSessionNode({ ssh: undefined, sshRemoteTmux: false })).toBe(false)
  })
})

describe('isValidGitRef', () => {
  it('accepts a normal branch name', () => {
    expect(isValidGitRef('feature/x')).toBe(true)
  })
  it('rejects flag-injection and whitespace', () => {
    expect(isValidGitRef('--force')).toBe(false)
    expect(isValidGitRef('a b')).toBe(false)
    expect(isValidGitRef('')).toBe(false)
  })
})

describe('sanitizeWorktreeBranch', () => {
  it('replaces spaces and illegal chars with dashes', () => {
    expect(sanitizeWorktreeBranch('My Feature!')).toBe('my-feature')
  })
  it('strips leading dashes (flag-injection guard)', () => {
    expect(sanitizeWorktreeBranch('--force')).toBe('force')
  })
})

describe('computeWorktreePath', () => {
  it('defaults beside the repository and flattens the branch', () => {
    expect(computeWorktreePath('/src/myrepo', 'feature/x')).toBe(
      '/src/myrepo.worktrees/feature-x'
    )
  })
  it('supports the requested aliases and appends a branch when the template omits it', () => {
    expect(computeWorktreePath('/src/MyRepo', 'Feature/X', '../$reponame.worktrees')).toBe(
      '/src/MyRepo.worktrees/feature-x'
    )
    expect(computeWorktreePath('/src/MyRepo', 'Feature/X', '../$defaultFolderName.worktrees')).toBe(
      '/src/MyRepo.worktrees/feature-x'
    )
    expect(computeWorktreePath('/src/MyRepo', 'Feature/X', './worktrees')).toBe(
      '/src/MyRepo/worktrees/feature-x'
    )
  })
  it('supports explicit branch tokens, absolute templates, and Windows-style input', () => {
    expect(computeWorktreePath('/src/repo/', 'topic/a', '/tmp/wt/$branch')).toBe(
      '/tmp/wt/topic-a'
    )
    expect(computeWorktreePath('C:\\src\\repo', 'topic/a', '..\\${repoName}.wt\\${branch}')).toBe(
      'C:/src/repo.wt/topic-a'
    )
  })
  it('suggests nothing when the repository or branch is unknown', () => {
    expect(computeWorktreePath('', 'x')).toBe('')
    expect(computeWorktreePath('   ', 'x')).toBe('')
    expect(computeWorktreePath('/src/repo', '')).toBe('')
  })
  it('refuses a template that climbs past the repo to the filesystem root', () => {
    // `../../../../..` clamps at `/`, which on a root-running Server Edition would make
    // `git worktree add` create a directory at the filesystem root. Suggest nothing instead.
    expect(computeWorktreePath('/src/repo', 'topic/a', '../../../../../..')).toBe('')
    // One level under root is still refused (a single top-level segment).
    expect(computeWorktreePath('/repo', 'b', '/${branch}')).toBe('')
    // But a legitimate absolute base with depth is allowed.
    expect(computeWorktreePath('/src/repo', 'b', '/srv/worktrees/${branch}')).toBe(
      '/srv/worktrees/b'
    )
  })
})

describe('resolveWorktreePath', () => {
  it('derives the configured default relative to the session repository root', async () => {
    const p = await resolveWorktreePath({
      repoRoot: '/srv/repos/myapp',
      branch: 'feature/x',
      template: './worktrees'
    })
    expect(p).toBe('/srv/repos/myapp/worktrees/feature-x')
  })
  it('honors an explicit --path', async () => {
    const p = await resolveWorktreePath({
      explicitPath: '  /custom/wt  ',
      repoRoot: '/srv/repos/x',
      branch: 'b'
    })
    expect(p).toBe('/custom/wt')
  })
  it('yields "" when the repository root is unknown and no --path was given', async () => {
    const p = await resolveWorktreePath({
      repoRoot: '',
      branch: 'b'
    })
    expect(p).toBe('')
  })
})

describe('resolveBaseRef', () => {
  it("uses the main checkout's branch — git prints it first", () => {
    expect(resolveBaseRef([entry('/repo', 'trunk'), entry('/wt/x', 'feature/x')])).toBe('trunk')
    expect(resolveBaseRef([entry('/repo', 'master')])).toBe('master')
  })
  it('falls back to main when the default branch is unknown (detached / empty list)', () => {
    expect(resolveBaseRef([])).toBe(DEFAULT_BASE_REF)
    expect(resolveBaseRef([entry('/repo', null)])).toBe(DEFAULT_BASE_REF)
    expect(resolveBaseRef([entry('/repo', '  ')])).toBe(DEFAULT_BASE_REF)
  })
})

describe('worktreeFromCreate', () => {
  it('marks a worktree the app just created as createdByApp (Remove may delete the dir)', () => {
    expect(
      worktreeFromCreate({
        repoPath: '/repo',
        mode: 'new',
        branch: 'feature/x',
        baseRef: 'master',
        path: '/u/worktrees/repo/feature-x'
      })
    ).toEqual({
      repoPath: '/repo',
      branch: 'feature/x',
      baseRef: 'master',
      path: '/u/worktrees/repo/feature-x',
      createdByApp: true
    })
  })
  it('trims the collected fields', () => {
    const wt = worktreeFromCreate({
      repoPath: ' /repo ',
      mode: 'existing',
      branch: ' feature/x ',
      baseRef: ' main ',
      path: ' /wt/x '
    })
    expect(wt).toMatchObject({ repoPath: '/repo', branch: 'feature/x', baseRef: 'main', path: '/wt/x' })
  })
})

describe('worktreeFromEntry', () => {
  it('marks an ADOPTED worktree as NOT createdByApp (Remove must not delete the user\'s dir)', () => {
    const wt = worktreeFromEntry(entry('/wt/x', 'feature/x'), '/repo', 'trunk')
    expect(wt).toEqual({
      repoPath: '/repo',
      branch: 'feature/x',
      baseRef: 'trunk',
      path: '/wt/x',
      createdByApp: false
    })
  })
  it('defaults the base ref to main when the repo default is unknown', () => {
    expect(worktreeFromEntry(entry('/wt/x', 'feature/x'), '/repo', '')?.baseRef).toBe(DEFAULT_BASE_REF)
  })
  it('refuses a detached worktree or a missing repo root', () => {
    expect(worktreeFromEntry(entry('/wt/x', null), '/repo', 'main')).toBeNull()
    expect(worktreeFromEntry(entry('/wt/x', 'b'), '', 'main')).toBeNull()
    expect(worktreeFromEntry(entry('', 'b'), '/repo', 'main')).toBeNull()
  })
})

describe('parseWorktreePorcelain', () => {
  it('parses git worktree list --porcelain blocks', () => {
    const out = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
      'worktree /wt/x', 'HEAD def456', 'branch refs/heads/feature/x', '',
      'worktree /bare', 'bare', ''
    ].join('\n')
    const entries = parseWorktreePorcelain(out)
    expect(entries).toEqual([
      { path: '/repo', head: 'abc123', branch: 'main', isBare: false, prunable: false },
      { path: '/wt/x', head: 'def456', branch: 'feature/x', isBare: false, prunable: false },
      { path: '/bare', head: null, branch: null, isBare: true, prunable: false }
    ])
  })

  // git keeps LISTING a worktree whose directory was deleted behind its back, tagging it
  // `prunable`. Dropping that tag is what would let a dead worktree render as a healthy one.
  it('flags a worktree whose directory is gone as prunable', () => {
    const out = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
      'worktree /wt/gone', 'HEAD def456', 'branch refs/heads/feat',
      'prunable gitdir file points to non-existent location', ''
    ].join('\n')
    const entries = parseWorktreePorcelain(out)
    expect(entries[0].prunable).toBe(false)
    expect(entries[1]).toEqual({
      path: '/wt/gone', head: 'def456', branch: 'feat', isBare: false, prunable: true
    })
  })

  it('flags a bare `prunable` line with no reason', () => {
    const entries = parseWorktreePorcelain(['worktree /wt/gone', 'prunable', ''].join('\n'))
    expect(entries[0].prunable).toBe(true)
  })
})

describe('isDangerousWorktreeRemovalPath', () => {
  const home = '/Users/me'
  it('refuses the repo root itself', () => {
    expect(isDangerousWorktreeRemovalPath('/repo', '/repo', home)).toBe(true)
  })
  it('refuses a path that contains the repo', () => {
    expect(isDangerousWorktreeRemovalPath('/repo', '/repo/sub', home)).toBe(true)
  })
  it('refuses home and filesystem root', () => {
    expect(isDangerousWorktreeRemovalPath(home, '/repo', home)).toBe(true)
    expect(isDangerousWorktreeRemovalPath('/', '/repo', home)).toBe(true)
  })
  it('allows a normal sibling worktree dir', () => {
    expect(isDangerousWorktreeRemovalPath('/Users/me/worktrees/r/feature-x', '/repo', home)).toBe(false)
  })
})

describe('decideMergeStrategy', () => {
  it('fetch-updates when base is not checked out anywhere', () => {
    expect(decideMergeStrategy({ baseCheckedOutPath: null, baseDirty: false }))
      .toEqual({ kind: 'fetch-update' })
  })
  it('merges in place when base checkout is clean', () => {
    expect(decideMergeStrategy({ baseCheckedOutPath: '/repo', baseDirty: false }))
      .toEqual({ kind: 'merge-in-place', path: '/repo' })
  })
  it('blocks when base checkout is dirty', () => {
    const r = decideMergeStrategy({ baseCheckedOutPath: '/repo', baseDirty: true })
    expect(r.kind).toBe('blocked')
  })
})

// Removing a worktree has to reach every node that was living in its directory — a terminal inside
// a NESTED group is in that directory just as much as a direct child; editor/diff nodes are
// with it too. A one-level filter left them holding a dead cwd, which is the exact trap the
// destructive-edges work exists to remove.
describe('descendantIds', () => {
  const nodes = [
    { id: 'g' },
    { id: 't1', parentId: 'g' },
    { id: 'inner', parentId: 'g' },
    { id: 't2', parentId: 'inner' }, // two levels down
    { id: 'deep', parentId: 't2' },
    { id: 'outside' }
  ]

  it('collects children AND grandchildren, never a node outside the group', () => {
    expect([...descendantIds(nodes, 'g')].sort()).toEqual(['deep', 'inner', 't1', 't2'])
  })

  it('is empty for a group with no children', () => {
    expect(descendantIds(nodes, 'outside').size).toBe(0)
  })

  it('terminates on a corrupt parent cycle instead of hanging', () => {
    const cyclic = [
      { id: 'a', parentId: 'g' },
      { id: 'b', parentId: 'a' },
      { id: 'g', parentId: 'b' } // g is its own descendant
    ]
    expect([...descendantIds(cyclic, 'g')].sort()).toEqual(['a', 'b', 'g'])
  })
})

// The one derivation BOTH teardown paths use — Remove (which also ends the sessions) and the stale
// group's Unbind (which does not). Unbind is the documented recovery path for a worktree deleted
// outside the app, and it used to leave `data.cwd = <dead path>` on the children, persisted to
// project.json: tmux hides it (a warm reattach ignores cwd) until a machine reboot, when the cold
// start spawns into the dead path, pty-manager silently falls back to $HOME, and the dead path
// stays in the project file forever.
describe('displacedByWorktree', () => {
  const wt = '/wt/feat'
  const nodes = [
    { id: 'g', type: 'group', data: { cwd: wt } },
    { id: 'term', type: 'terminal', parentId: 'g', data: { cwd: wt } },
    { id: 'inner', type: 'group', parentId: 'g', data: { cwd: wt } },
    { id: 'nested', type: 'terminal', parentId: 'inner', data: { cwd: `${wt}/pkg` } },
    // In the group, but its cwd was pointed somewhere else by hand — it was never displaced.
    { id: 'elsewhere', type: 'terminal', parentId: 'g', data: { cwd: '/repo' } },
    // A sibling directory that merely shares the prefix must not be swept up.
    { id: 'prefix', type: 'terminal', parentId: 'g', data: { cwd: '/wt/feature' } },
    { id: 'nocwd', type: 'terminal', parentId: 'g', data: {} },
    { id: 'sticky', type: 'sticky', parentId: 'g', data: { cwd: wt } },
    // Same cwd, but not in the group: not this group's business.
    { id: 'stranger', type: 'terminal', data: { cwd: wt } },
    // Editor/diff nodes never get a parentId (they float free on the canvas — see
    // createEditorNode/createDiffNode), so group membership can't identify them. Path
    // containment is the only signal: editor stores the ABSOLUTE path in `filePath`; diff
    // stores the repo root in `cwd` and the file's path RELATIVE to it in `filePath`.
    { id: 'editor-in', type: 'editor', data: { filePath: `${wt}/src/index.ts` } },
    { id: 'editor-out', type: 'editor', data: { filePath: '/repo/src/index.ts' } },
    // Shares the prefix but is a sibling directory, not really inside the worktree.
    { id: 'editor-prefix', type: 'editor', data: { filePath: '/wt/feature/index.ts' } },
    { id: 'diff-in', type: 'diff', data: { cwd: wt, filePath: 'src/index.ts' } },
    { id: 'diff-out', type: 'diff', data: { cwd: '/repo', filePath: 'src/index.ts' } }
  ]

  it('collects every descendant terminal living in the worktree, nested ones included', () => {
    expect([...displacedByWorktree(nodes, 'g', wt)].sort()).toEqual(
      ['diff-in', 'editor-in', 'nested', 'term'].sort()
    )
  })

  it('leaves nodes outside the group, outside the path, or without a cwd alone', () => {
    const got = displacedByWorktree(nodes, 'g', wt)
    for (const id of [
      'elsewhere',
      'prefix',
      'nocwd',
      'sticky',
      'stranger',
      'g',
      'inner',
      'editor-out',
      'editor-prefix',
      'diff-out'
    ]) {
      expect(got.has(id)).toBe(false)
    }
  })

  it('collects an editor/diff node by path even though it has no parentId at all', () => {
    // Same as 'editor-in'/'diff-in' above, spelled out: neither carries a parentId, and neither
    // is a descendant of 'g' by any group-membership test — only the path says they're displaced.
    expect(nodes.find((n) => n.id === 'editor-in')?.parentId).toBeUndefined()
    expect(nodes.find((n) => n.id === 'diff-in')?.parentId).toBeUndefined()
    const got = displacedByWorktree(nodes, 'g', wt)
    expect(got.has('editor-in')).toBe(true)
    expect(got.has('diff-in')).toBe(true)
  })

  it('displaces nothing for an empty worktree path (never sweeps the whole canvas)', () => {
    expect(displacedByWorktree(nodes, 'g', '').size).toBe(0)
  })
})

describe('isInsideDir', () => {
  it('matches the directory itself and anything under it', () => {
    expect(isInsideDir('/wt/feat', '/wt/feat')).toBe(true)
    expect(isInsideDir('/wt/feat/src', '/wt/feat')).toBe(true)
    expect(isInsideDir('/wt/feat/', '/wt/feat')).toBe(true)
  })
  it('does not match a sibling that merely shares a prefix', () => {
    expect(isInsideDir('/wt/feature', '/wt/feat')).toBe(false)
  })
  it('is false for an unset cwd (nothing to displace)', () => {
    expect(isInsideDir(undefined, '/wt/feat')).toBe(false)
    expect(isInsideDir('', '/wt/feat')).toBe(false)
  })
})

describe('worktreeRemoveMessage', () => {
  const base = { branch: 'feat/x', path: '/wt/feat-x', canDelete: true, deleteFromDisk: true }

  it('names the branch and the directory that will be destroyed', () => {
    const msg = worktreeRemoveMessage(base)
    expect(msg).toContain('Branch: feat/x')
    expect(msg).toContain('Directory: /wt/feat-x')
  })

  it('attributes an agent-opened removal (it used to be identical to a user-initiated one)', () => {
    expect(worktreeRemoveMessage({ ...base, requestedBy: 'claude-1' })).toContain(
      'Agent "claude-1" wants to remove this worktree.'
    )
    // A user-initiated removal claims no agent.
    expect(worktreeRemoveMessage(base)).not.toContain('Agent "')
  })

  it('an adopted worktree defaults to unbind, and says so; the disk opt-in is spelled out', () => {
    const adopted = { ...base, canDelete: false, deleteFromDisk: false }
    const unbind = worktreeRemoveMessage(adopted)
    expect(unbind).toContain('not created by nodeterm')
    expect(unbind).not.toContain('DELETED')
    expect(worktreeRemoveMessage({ ...adopted, deleteFromDisk: true })).toContain(
      '⚠ The worktree directory will be DELETED. Its branch is kept.'
    )
  })

  it('carries the uncommitted-work warning', () => {
    expect(worktreeRemoveMessage({ ...base, warning: '3 uncommitted file(s) in the worktree.' })).toContain(
      '⚠ 3 uncommitted file(s) in the worktree.'
    )
  })
})

describe('filterWorktrees', () => {
  const entries = [
    entry('/repo.worktrees/feature-login', 'feature/login'),
    entry('/repo.worktrees/fix-api', 'fix/API'),
    entry('/repo.worktrees/detached', null)
  ]

  it('matches branch or path without case sensitivity', () => {
    expect(filterWorktrees(entries, 'LOGIN')).toEqual([entries[0]])
    expect(filterWorktrees(entries, 'fix api')).toEqual([entries[1]])
  })

  it('returns every entry for a blank query and none for a miss', () => {
    expect(filterWorktrees(entries, '  ')).toBe(entries)
    expect(filterWorktrees(entries, 'not-here')).toEqual([])
  })
})

// Pure worktree-creation resolver: what baseRef and path TEMPLATE a new worktree should default to,
// given a project's own settings. Neither function does IO or validates a path — computeWorktreePath
// (the caller) already refuses a shallow-rooted result, so a hostile basePath is left to fall back
// exactly as it does today; see the `computeWorktreePath` case below.
describe('effectiveWorktreeBaseRef', () => {
  const entries = [entry('/repo', 'trunk'), entry('/wt/x', 'feature/x')]

  it('a project baseRef wins over the repo-derived default', () => {
    const project: ProjectWorktreeDefaults = { baseRef: 'release' }
    expect(effectiveWorktreeBaseRef(project, entries)).toBe('release')
  })

  it('falls back to resolveBaseRef(entries) when the project has no baseRef', () => {
    expect(effectiveWorktreeBaseRef(undefined, entries)).toBe('trunk')
    expect(effectiveWorktreeBaseRef({}, entries)).toBe('trunk')
  })

  it('treats a whitespace-only project baseRef as unset', () => {
    expect(effectiveWorktreeBaseRef({ baseRef: '   ' }, entries)).toBe('trunk')
  })

  it('falls all the way to DEFAULT_BASE_REF when neither the project nor the repo says', () => {
    expect(effectiveWorktreeBaseRef(undefined, [])).toBe(DEFAULT_BASE_REF)
  })
})

describe('effectiveWorktreeTemplate', () => {
  it('a set project basePath becomes `<basePath>/${branch}`', () => {
    expect(effectiveWorktreeTemplate({ basePath: '/srv/worktrees' }, undefined)).toBe(
      '/srv/worktrees/${branch}'
    )
  })

  it('joins with exactly one slash even when basePath has a trailing slash', () => {
    expect(effectiveWorktreeTemplate({ basePath: '/srv/worktrees/' }, undefined)).toBe(
      '/srv/worktrees/${branch}'
    )
  })

  it('a whitespace-only basePath is ignored, falling through to the global template', () => {
    expect(effectiveWorktreeTemplate({ basePath: '   ' }, './worktrees')).toBe('./worktrees')
  })

  it('falls back to the trimmed global template when there is no project basePath', () => {
    expect(effectiveWorktreeTemplate(undefined, '  ./worktrees  ')).toBe('./worktrees')
    expect(effectiveWorktreeTemplate({}, './worktrees')).toBe('./worktrees')
  })

  it('falls back to DEFAULT_WORKTREE_PATH_TEMPLATE when neither project basePath nor global template is set', () => {
    expect(effectiveWorktreeTemplate(undefined, undefined)).toBe(DEFAULT_WORKTREE_PATH_TEMPLATE)
    expect(effectiveWorktreeTemplate({}, '   ')).toBe(DEFAULT_WORKTREE_PATH_TEMPLATE)
  })

  // The function itself does no path resolution or validation — it only builds a template string.
  // A hostile basePath like '/' must still end up refused, but that refusal happens DOWNSTREAM in
  // computeWorktreePath (via resolvePathFromRepo's shallow-root guard), not here. Prove the chain
  // actually holds by feeding the synthesized template through computeWorktreePath.
  it('a rooted basePath produces a template that computeWorktreePath later refuses', () => {
    const template = effectiveWorktreeTemplate({ basePath: '/' }, undefined)
    expect(template).toBe('/${branch}')
    expect(computeWorktreePath('/src/repo', 'topic/a', template)).toBe('')
  })
})

describe('resolveWorktreeBase (issue #530 — --base <ref|stationId>)', () => {
  // A wave-one worktree frame (g1, branch wave1) holding an agent node (a1), a nested inner
  // frame (g1a) holding a2; a loose node (n0); an unbound frame (g2) with a member (b1).
  const NODES: WorktreeBaseNode[] = [
    { id: 'g1', worktree: { branch: 'wave1' } },
    { id: 'a1', parentId: 'g1' },
    { id: 'g1a', parentId: 'g1' },
    { id: 'a2', parentId: 'g1a' },
    { id: 'n0' },
    { id: 'g2' },
    { id: 'b1', parentId: 'g2' }
  ]

  it('no --base means the default', () => {
    expect(resolveWorktreeBase(undefined, 'wave2', NODES)).toEqual({ kind: 'default' })
    expect(resolveWorktreeBase('  ', 'wave2', NODES)).toEqual({ kind: 'default' })
  })
  it('a member node resolves through its bound group to the branch', () => {
    expect(resolveWorktreeBase('a1', 'wave2', NODES)).toEqual({
      kind: 'station',
      ref: 'wave1',
      stationId: 'a1',
      groupId: 'g1'
    })
  })
  it('a node in a NESTED frame climbs to the nearest bound ancestor', () => {
    expect(resolveWorktreeBase('a2', 'wave2', NODES)).toEqual({
      kind: 'station',
      ref: 'wave1',
      stationId: 'a2',
      groupId: 'g1'
    })
  })
  it('the bound group id itself is a station', () => {
    expect(resolveWorktreeBase('g1', 'wave2', NODES)).toEqual({
      kind: 'station',
      ref: 'wave1',
      stationId: 'g1',
      groupId: 'g1'
    })
  })
  it('a node outside any worktree frame is an explicit refusal — never reinterpreted as a ref', () => {
    for (const id of ['n0', 'b1', 'g2']) {
      const r = resolveWorktreeBase(id, 'wave2', NODES)
      expect(r.kind).toBe('error')
      if (r.kind === 'error') expect(r.error).toContain('not inside a worktree-bound frame')
    }
  })
  it('a station whose branch IS the new branch is refused (self-base)', () => {
    const r = resolveWorktreeBase('a1', 'wave1', NODES)
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.error).toContain('based on itself')
  })
  it('a plain ref self-base is refused too', () => {
    const r = resolveWorktreeBase('wave2', 'wave2', NODES)
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.error).toContain('based on itself')
  })
  it('a value naming no node passes through as a validated git ref', () => {
    expect(resolveWorktreeBase('main', 'wave2', NODES)).toEqual({ kind: 'ref', ref: 'main' })
    expect(resolveWorktreeBase('origin/main', 'wave2', NODES)).toEqual({
      kind: 'ref',
      ref: 'origin/main'
    })
  })
  it('a value that is neither a node nor a valid ref is refused', () => {
    for (const bad of ['-rf', 'a..b', 'has space']) {
      const r = resolveWorktreeBase(bad, 'wave2', NODES)
      expect(r.kind).toBe('error')
      if (r.kind === 'error') expect(r.error).toContain('neither')
    }
  })
  it('a forged parentId cycle terminates as a refusal instead of hanging', () => {
    // project.json is hand-editable and git-shared; the walk is visited-set guarded.
    const cyc: WorktreeBaseNode[] = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' }
    ]
    const r = resolveWorktreeBase('x', 'wave2', cyc)
    expect(r.kind).toBe('error')
  })
})
