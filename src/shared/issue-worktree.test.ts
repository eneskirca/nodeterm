import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  ISSUE_BRANCH_SLUG_MAX,
  ISSUE_BRANCH_SUFFIX_MAX,
  isIssueBranch,
  issueBranchSlug,
  issueWorktreeBranch,
  planIssueWorktree,
  type IssueWorktreeInput
} from './issue-worktree'
import { computeWorktreePath, DEFAULT_WORKTREE_PATH_TEMPLATE, effectiveWorktreeTemplate, isValidGitRef } from './worktree'

// Issue titles are writable by anyone on a public repository. Every one of these must come out as
// a branch in the `[a-z0-9-]` alphabet that git accepts, and never as anything else.
const HOSTILE_TITLES: string[] = [
  '../../etc/passwd',
  '..',
  '; rm -rf ~',
  '`touch /tmp/pwned`',
  '$(whoami) and ${HOME}',
  "' OR 1=1 --",
  '--upload-pack=touch /tmp/x',
  '-b evil',
  'refs/heads/main',
  'HEAD@{1}',
  'feature.lock',
  'a..b~^:?*[\\',
  '   ',
  '',
  '🔥🔥🔥',
  '中文标题',
  'mаin', // Cyrillic а
  'ｍａｉｎ', // fullwidth
  'fix\u202Egnp.exe', // bidi override
  'zero\u200Bwidth\u200Djoin',
  'tab\tnew\nline\r\u0000nul\u001b[31mred',
  'İstanbul çalışıyor', // Turkish dotted capital I
  'x'.repeat(500),
  'word '.repeat(200),
  '---',
  '-- leading and trailing --',
  '\\\\server\\share',
  'C:\\Windows\\System32'
]

const BRANCH_SHAPE = /^issue-[1-9][0-9]*(-[a-z0-9]+)*$/

describe('issueBranchSlug', () => {
  it('keeps readable ASCII words and drops everything else', () => {
    expect(issueBranchSlug('Fix login crash on Safari')).toBe('fix-login-crash-on-safari')
    expect(issueBranchSlug('Café: déjà vu (again!)')).toBe('cafe-deja-vu-again')
    expect(issueBranchSlug('İstanbul çalışıyor')).toBe('istanbul-cal-s-yor')
    expect(issueBranchSlug('  --Hello--  ')).toBe('hello')
  })

  it('is empty when nothing survives, so the branch falls back to issue-<N>', () => {
    for (const t of ['', '   ', '🔥🔥🔥', '中文标题', '---', undefined, null, 42, { toString: () => 'x' }]) {
      expect(issueBranchSlug(t)).toBe('')
      expect(issueWorktreeBranch(7, t)).toBe('issue-7')
    }
  })

  it('caps the slug, backing up to a word boundary when the cap lands mid-word', () => {
    const long = 'fix login crash on safari when the user has two factor enabled'
    const slug = issueBranchSlug(long)
    expect(slug.length).toBeLessThanOrEqual(ISSUE_BRANCH_SLUG_MAX)
    expect(slug).toBe('fix-login-crash-on-safari-when-the-user')
    expect(issueBranchSlug('x'.repeat(500))).toBe('x'.repeat(ISSUE_BRANCH_SLUG_MAX))
    expect(issueBranchSlug('word '.repeat(200)).endsWith('-')).toBe(false)
  })

  it('drops lookalikes and invisible characters instead of letting them pass for letters', () => {
    // A Cyrillic а must not read as the Latin a in "main".
    expect(issueBranchSlug('mаin')).toBe('m-in')
    expect(issueBranchSlug('fix\u202Egnp.exe')).toBe('fix-gnp-exe')
    expect(issueBranchSlug('zero\u200Bwidth\u200Djoin')).toBe('zero-width-join')
  })
})

describe('issueWorktreeBranch', () => {
  it('names the branch issue-<N>-<slug>, with -k for a suffix of 2 or more', () => {
    expect(issueWorktreeBranch(12, 'Fix it')).toBe('issue-12-fix-it')
    expect(issueWorktreeBranch(12, 'Fix it', 1)).toBe('issue-12-fix-it')
    expect(issueWorktreeBranch(12, 'Fix it', 2)).toBe('issue-12-fix-it-2')
    expect(issueWorktreeBranch(12, '', 3)).toBe('issue-12-3')
  })

  it('refuses a number that is not an issue number', () => {
    for (const n of [0, -1, 1.5, NaN, 2 ** 31, '12', null, undefined]) {
      expect(issueWorktreeBranch(n, 'x')).toBe('')
    }
  })

  it.each(HOSTILE_TITLES)('a hostile title yields a plain, valid branch: %j', (title) => {
    const branch = issueWorktreeBranch(4242, title)
    expect(branch).toMatch(BRANCH_SHAPE)
    expect(branch.length).toBeLessThanOrEqual('issue-4242-'.length + ISSUE_BRANCH_SLUG_MAX)
    expect(isValidGitRef(branch)).toBe(true)
    // The worktree folder is one segment under the template's base — no traversal, no separator.
    const path = computeWorktreePath('/work/repo', branch, DEFAULT_WORKTREE_PATH_TEMPLATE)
    expect(path).toBe(`/work/repo.worktrees/${branch}`)
  })

  it('every hostile branch passes the REAL git check-ref-format --branch', () => {
    for (const title of HOSTILE_TITLES) {
      for (const suffix of [1, 2, ISSUE_BRANCH_SUFFIX_MAX]) {
        const branch = issueWorktreeBranch(4242, title, suffix)
        // argv, never a shell: execFileSync passes the name as ONE argument.
        const out = execFileSync('git', ['check-ref-format', '--branch', branch], { encoding: 'utf8' })
        expect(out.trim()).toBe(branch)
      }
    }
  })
})

describe('isIssueBranch', () => {
  it('matches the issue and its suffixes, never another issue', () => {
    expect(isIssueBranch('issue-12', 12)).toBe(true)
    expect(isIssueBranch('issue-12-fix', 12)).toBe(true)
    expect(isIssueBranch('Issue-12-Fix', 12)).toBe(true)
    expect(isIssueBranch('issue-123', 12)).toBe(false)
    expect(isIssueBranch('issue-1', 12)).toBe(false)
    expect(isIssueBranch('feature/issue-12', 12)).toBe(false)
    expect(isIssueBranch(undefined, 12)).toBe(false)
  })
})

const ROOT = '/work/repo'
const TEMPLATE = DEFAULT_WORKTREE_PATH_TEMPLATE
const wt = (b: string): string => `/work/repo.worktrees/${b}`
const base = (over: Partial<IssueWorktreeInput> = {}): IssueWorktreeInput => ({
  number: 12,
  title: 'Fix login',
  repoRoot: ROOT,
  template: TEMPLATE,
  entries: [{ path: ROOT, branch: 'main', head: 'a', isBare: false }],
  branches: ['main'],
  bound: [],
  ...over
})
const nothingOnDisk = async (): Promise<boolean> => false

describe('planIssueWorktree', () => {
  it('creates issue-<N>-<slug> at the templated path when nothing is in the way', async () => {
    expect(await planIssueWorktree(base(), nothingOnDisk)).toEqual({
      kind: 'create',
      target: { branch: 'issue-12-fix-login', path: wt('issue-12-fix-login') }
    })
  })

  it('offers to reuse a worktree a frame on this canvas is already bound to, with -2 as the alternative', async () => {
    const plan = await planIssueWorktree(
      base({
        entries: [
          { path: ROOT, branch: 'main', head: 'a', isBare: false },
          { path: wt('issue-12-fix-login'), branch: 'issue-12-fix-login', head: 'b', isBare: false }
        ],
        branches: ['main', 'issue-12-fix-login'],
        bound: [{ groupId: 'g1', branch: 'issue-12-fix-login', path: wt('issue-12-fix-login') }]
      }),
      nothingOnDisk
    )
    expect(plan).toEqual({
      kind: 'choose',
      existing: { kind: 'bound', groupId: 'g1', branch: 'issue-12-fix-login', path: wt('issue-12-fix-login') },
      alternative: { branch: 'issue-12-fix-login-2', path: wt('issue-12-fix-login-2') }
    })
  })

  it('finds the issue\'s worktree even after its title changed, and offers the new name as the alternative', async () => {
    const plan = await planIssueWorktree(
      base({
        title: 'Fix login on Safari',
        entries: [
          { path: ROOT, branch: 'main', head: 'a', isBare: false },
          { path: wt('issue-12-fix-login'), branch: 'issue-12-fix-login', head: 'b', isBare: false }
        ],
        branches: ['main', 'issue-12-fix-login']
      }),
      nothingOnDisk
    )
    expect(plan.kind).toBe('choose')
    if (plan.kind !== 'choose') return
    expect(plan.existing).toMatchObject({ kind: 'orphan', branch: 'issue-12-fix-login' })
    expect(plan.alternative).toEqual({
      branch: 'issue-12-fix-login-on-safari',
      path: wt('issue-12-fix-login-on-safari')
    })
  })

  it('prefers a bound frame over an unbound worktree of the same issue', async () => {
    const plan = await planIssueWorktree(
      base({
        entries: [
          { path: ROOT, branch: 'main', head: 'a', isBare: false },
          { path: wt('issue-12-fix-login'), branch: 'issue-12-fix-login', head: 'b', isBare: false },
          { path: wt('issue-12-old'), branch: 'issue-12-old', head: 'c', isBare: false }
        ],
        bound: [{ groupId: 'g9', branch: 'issue-12-old', path: wt('issue-12-old') }]
      }),
      nothingOnDisk
    )
    expect(plan.kind === 'choose' && plan.existing).toMatchObject({ kind: 'bound', groupId: 'g9' })
  })

  it('never offers the main checkout, a prunable registration or another issue\'s worktree for reuse', async () => {
    const plan = await planIssueWorktree(
      base({
        entries: [
          { path: ROOT, branch: 'issue-12-fix-login', head: 'a', isBare: false },
          { path: wt('issue-12-gone'), branch: 'issue-12-gone', head: 'b', isBare: false, prunable: true },
          { path: wt('issue-123-x'), branch: 'issue-123-x', head: 'c', isBare: false }
        ],
        branches: ['issue-12-fix-login', 'issue-12-gone', 'issue-123-x']
      }),
      nothingOnDisk
    )
    // The wanted branch is checked out in the main checkout: taken, not reusable → -2, and the
    // caller is told why the name changed.
    expect(plan).toEqual({
      kind: 'create',
      target: { branch: 'issue-12-fix-login-2', path: wt('issue-12-fix-login-2') },
      renamedFrom: 'issue-12-fix-login'
    })
  })

  it('offers to check out the existing branch when it is checked out nowhere', async () => {
    const plan = await planIssueWorktree(base({ branches: ['main', 'issue-12-fix-login'] }), nothingOnDisk)
    expect(plan).toEqual({
      kind: 'choose',
      existing: { kind: 'branch', branch: 'issue-12-fix-login', path: wt('issue-12-fix-login') },
      alternative: { branch: 'issue-12-fix-login-2', path: wt('issue-12-fix-login-2') }
    })
  })

  it('treats branch names case-insensitively, and offers the existing one under its OWN spelling', async () => {
    // A case-insensitive filesystem cannot hold both; and git resolves the name it is given, so the
    // checkout must name `Issue-12-Fix-Login`, not the lower-case name the app would have created.
    const plan = await planIssueWorktree(base({ branches: ['main', 'Issue-12-Fix-Login'] }), nothingOnDisk)
    expect(plan).toEqual({
      kind: 'choose',
      existing: { kind: 'branch', branch: 'Issue-12-Fix-Login', path: wt('issue-12-fix-login') },
      alternative: { branch: 'issue-12-fix-login-2', path: wt('issue-12-fix-login-2') }
    })
  })

  it('a differently-cased branch still takes the name when its folder is taken too (no second branch that differs only in case)', async () => {
    const plan = await planIssueWorktree(
      base({ branches: ['main', 'Issue-12-Fix-Login'] }),
      async (p) => p === wt('issue-12-fix-login')
    )
    expect(plan).toEqual({
      kind: 'create',
      target: { branch: 'issue-12-fix-login-2', path: wt('issue-12-fix-login-2') },
      renamedFrom: 'issue-12-fix-login'
    })
  })

  it('skips a suffix whose branch exists under another case', async () => {
    const plan = await planIssueWorktree(
      base({ branches: ['main', 'Issue-12-Fix-Login', 'ISSUE-12-FIX-LOGIN-2'] }),
      nothingOnDisk
    )
    expect(plan.kind === 'choose' && plan.alternative).toEqual({
      branch: 'issue-12-fix-login-3',
      path: wt('issue-12-fix-login-3')
    })
  })

  it('never overwrites a folder that already exists — it moves to the next free suffix', async () => {
    const taken = new Set([wt('issue-12-fix-login'), wt('issue-12-fix-login-2')])
    const plan = await planIssueWorktree(base(), async (p) => taken.has(p))
    expect(plan).toEqual({
      kind: 'create',
      target: { branch: 'issue-12-fix-login-3', path: wt('issue-12-fix-login-3') },
      renamedFrom: 'issue-12-fix-login'
    })
  })

  it('reads a failed existence probe as "taken", never as absence', async () => {
    const plan = await planIssueWorktree(base(), async (p) => {
      if (p === wt('issue-12-fix-login')) throw new Error('EACCES')
      return false
    })
    expect(plan.kind === 'create' && plan.target.branch).toBe('issue-12-fix-login-2')
  })

  it('does not offer to check out an existing branch into a folder that is taken', async () => {
    const plan = await planIssueWorktree(
      base({ branches: ['main', 'issue-12-fix-login'] }),
      async (p) => p === wt('issue-12-fix-login')
    )
    expect(plan).toEqual({
      kind: 'create',
      target: { branch: 'issue-12-fix-login-2', path: wt('issue-12-fix-login-2') },
      renamedFrom: 'issue-12-fix-login'
    })
  })

  it('counts a bound frame\'s branch as taken even when the worktree list could not be read', async () => {
    // Bound somewhere OTHER than the templated folder (a --path create, a template changed since):
    // only the branch says the name is taken, and offering it again would fail at git.
    const plan = await planIssueWorktree(
      base({
        entries: [],
        branches: null,
        bound: [{ groupId: 'g1', branch: 'issue-12-fix-login', path: '/elsewhere/issue-12-fix-login' }]
      }),
      nothingOnDisk
    )
    expect(plan.kind === 'choose' && plan.alternative?.branch).toBe('issue-12-fix-login-2')
  })

  it('counts a bound frame\'s folder as taken too', async () => {
    const plan = await planIssueWorktree(
      base({
        entries: [],
        branches: null,
        bound: [{ groupId: 'g1', branch: 'someone-else', path: wt('issue-12-fix-login') }]
      }),
      nothingOnDisk
    )
    expect(plan).toMatchObject({ kind: 'create', target: { branch: 'issue-12-fix-login-2' } })
  })

  it('treats a branch that exists only on a remote as TAKEN — never a diverging local twin', async () => {
    const plan = await planIssueWorktree(
      base({ remoteBranches: ['origin/issue-12-fix-login', 'origin/main'] }),
      nothingOnDisk
    )
    expect(plan).toEqual({
      kind: 'create',
      target: { branch: 'issue-12-fix-login-2', path: wt('issue-12-fix-login-2') },
      renamedFrom: 'issue-12-fix-login'
    })
    // …on any remote, and for the suffixes too; it is never offered as "check it out".
    const skipped = await planIssueWorktree(
      base({ remoteBranches: ['upstream/Issue-12-Fix-Login', 'origin/issue-12-fix-login-2'] }),
      nothingOnDisk
    )
    expect(skipped).toMatchObject({ kind: 'create', target: { branch: 'issue-12-fix-login-3' } })
  })

  it('refuses a location from the SHARED settings file that leaves the repository\'s folder', async () => {
    for (const sharedBasePath of ['../../.claude/skills', '/home/u/.codex', '../../../../tmp', '.git/hooks']) {
      // As in the app: the template IS what the shared basePath expands to.
      const template = effectiveWorktreeTemplate({ basePath: sharedBasePath }, undefined)
      const plan = await planIssueWorktree(
        base({ repoRoot: '/home/u/code/repo', template, sharedBasePath }),
        nothingOnDisk
      )
      expect(plan.kind, sharedBasePath).toBe('refused')
      if (plan.kind === 'refused') expect(plan.reason).toContain('.nodeterm/settings.json')
    }
    // The same shared setting pointing beside the repository is fine.
    const ok = effectiveWorktreeTemplate({ basePath: '../wt' }, undefined)
    expect(
      (await planIssueWorktree(base({ repoRoot: '/home/u/code/repo', template: ok, sharedBasePath: '../wt' }), nothingOnDisk)).kind
    ).toBe('create')
  })

  it('refuses when every suffix is taken, when there is no repository, or no path', async () => {
    expect((await planIssueWorktree(base(), async () => true)).kind).toBe('refused')
    expect((await planIssueWorktree(base({ repoRoot: '  ' }), nothingOnDisk)).kind).toBe('refused')
    // A template that climbs to the filesystem root yields no path (computeWorktreePath's guard).
    expect((await planIssueWorktree(base({ template: '../../../../..' }), nothingOnDisk)).kind).toBe('refused')
    expect((await planIssueWorktree(base({ number: 0 }), nothingOnDisk)).kind).toBe('refused')
  })

  it('a hostile title still plans a folder directly under the template base', async () => {
    for (const title of HOSTILE_TITLES) {
      const plan = await planIssueWorktree(base({ title }), nothingOnDisk)
      expect(plan.kind).toBe('create')
      if (plan.kind !== 'create') continue
      expect(plan.target.branch).toMatch(BRANCH_SHAPE)
      expect(plan.target.path).toBe(wt(plan.target.branch))
    }
  })
})
