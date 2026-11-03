import { describe, expect, it } from 'vitest'
import { openPrLanding, planPullCreated, pullCreatedControl, pullCreatedFromHook } from './pr-created-hook'

// The real payload shapes (fixtures: shared/agents/__fixtures__/claude/subagent-hook-payloads.json,
// codex/auto-review-permission.json): Claude's Bash tool_response is an object with stdout/stderr,
// Codex's is the output string.
const claude = (command: string, stdout: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
  ...extra
})
const codex = (command: string, output: string) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: output
})

const CREATED = 'https://github.com/acme/app/pull/42\n'

describe('pullCreatedFromHook', () => {
  it('reads the PR gh printed after a Claude Code `gh pr create`', () => {
    expect(pullCreatedFromHook('claude', claude('gh pr create --title t --body b', CREATED)))
      .toEqual({ repository: 'acme/app', pullNumber: 42 })
  })

  it('reads the PR from a Codex `gh pr create` output string', () => {
    expect(pullCreatedFromHook('codex', codex('git push -u origin x && gh pr create --fill', `pushed\n${CREATED}`)))
      .toEqual({ repository: 'acme/app', pullNumber: 42 })
  })

  it('takes the last link when the output holds several', () => {
    const out = 'see https://github.com/acme/app/pull/7\nhttps://github.com/acme/app/pull/43\n'
    expect(pullCreatedFromHook('claude', claude('gh pr create', out))).toEqual({ repository: 'acme/app', pullNumber: 43 })
  })

  it('names the other repository as printed (the caller refuses it)', () => {
    expect(pullCreatedFromHook('claude', claude('gh pr create -R evil/repo', 'https://github.com/evil/repo/pull/1\n')))
      .toEqual({ repository: 'evil/repo', pullNumber: 1 })
  })

  it('finds nothing for `gh pr create --web` (gh prints a compare URL, not a PR)', () => {
    const out = 'Opening https://github.com/acme/app/compare/main...feat?expand=1 in your browser.\n'
    expect(pullCreatedFromHook('claude', claude('gh pr create --web', out))).toBeUndefined()
    expect(pullCreatedFromHook('claude', claude('gh pr create --web', 'Opening https://github.com/acme/app/pull/new/feat in your browser.\n'))).toBeUndefined()
  })

  it('finds nothing for a failed create that printed no link', () => {
    const failed = { ...claude('gh pr create', ''), tool_response: { stdout: '', stderr: 'pull request create failed: GraphQL: No commits between main and feat' } }
    expect(pullCreatedFromHook('claude', failed)).toBeUndefined()
  })

  it('reads only Claude stdout, never stderr', () => {
    const exists = { ...claude('gh pr create', ''), tool_response: { stdout: '', stderr: 'a pull request for branch "x" already exists:\nhttps://github.com/acme/app/pull/5\n' } }
    expect(pullCreatedFromHook('claude', exists)).toBeUndefined()
  })

  it.each([
    ['a different command', claude('gh pr view 42', CREATED)],
    ['a command that only mentions it', claude('echo "run gh pr create later"', CREATED)],
    ['gh pr create-ish', claude('gh pr created', CREATED)],
    ['PreToolUse', claude('gh pr create', CREATED, { hook_event_name: 'PreToolUse' })],
    ['another tool', claude('gh pr create', CREATED, { tool_name: 'Read' })],
    ['no command', claude('gh pr create', CREATED, { tool_input: {} })]
  ])('ignores %s', (_why, payload) => {
    expect(pullCreatedFromHook('claude', payload)).toBeUndefined()
  })

  it('ignores other agents', () => {
    expect(pullCreatedFromHook('gemini', claude('gh pr create', CREATED))).toBeUndefined()
    expect(pullCreatedFromHook('grok', codex('gh pr create', CREATED))).toBeUndefined()
  })

  it.each([
    'https://github.com/acme/app/pull/0',
    'https://github.com/acme/app/pull/007',
    'https://github.com/acme/app/pull/99999999999',
    'https://github.com/acme/app/pull/42/files',
    'https://github.com/acme/app/pull/42abc',
    'https://github.com/-acme/app/pull/42',
    'https://github.com/acme/../pull/42',
    'https://github.com/a/b/c/pull/42',
    'http://github.com/acme/app/pull/42',
    'https://github.com.evil.io/acme/app/pull/42',
    'https://evilgithub.com/acme/app/pull/42'
  ])('refuses a malformed link (%s)', (link) => {
    expect(pullCreatedFromHook('claude', claude('gh pr create', `${link}\n`))).toBeUndefined()
  })

  it('takes the last PR link, not a later link of another kind', () => {
    const out = 'https://github.com/acme/app/pull/42\nChecks: https://github.com/acme/app/actions/runs/9\n'
    expect(pullCreatedFromHook('claude', claude('gh pr create', out))).toEqual({ repository: 'acme/app', pullNumber: 42 })
  })

  it('reads a create after cd, on its own line, or inside $( )', () => {
    for (const command of ['cd app && gh pr create --fill', 'git push\ngh pr create --fill', 'url=$(gh pr create --fill)']) {
      expect(pullCreatedFromHook('claude', claude(command, CREATED))).toEqual({ repository: 'acme/app', pullNumber: 42 })
    }
  })

  it('refuses when the last link is malformed, even after a good one', () => {
    const out = 'https://github.com/acme/app/pull/42\nhttps://github.com/acme/app/pull/0\n'
    expect(pullCreatedFromHook('claude', claude('gh pr create', out))).toBeUndefined()
  })

  it('reads only the tail of a huge output', () => {
    const out = `https://github.com/acme/app/pull/1\n${'x'.repeat(200_000)}\n`
    expect(pullCreatedFromHook('claude', claude('gh pr create', out))).toBeUndefined()
    expect(pullCreatedFromHook('claude', claude('gh pr create', `${'x'.repeat(200_000)}\n${CREATED}`)))
      .toEqual({ repository: 'acme/app', pullNumber: 42 })
  })
})

describe('planPullCreated', () => {
  const created = { repository: 'acme/app', pullNumber: 42 }

  it('creates a node for the project repository, compared without case', () => {
    expect(planPullCreated({ created: { repository: 'Acme/App', pullNumber: 42 }, repo: { repository: 'acme/app', approved: true }, pullNodes: [] }))
      .toEqual({ kind: 'create', ref: { repository: 'acme/app', pullNumber: 42, tab: 'overview' } })
  })

  it('still creates the node when the repository is not approved yet (the node asks)', () => {
    expect(planPullCreated({ created, repo: { repository: 'acme/app', approved: false }, pullNodes: [] }))
      .toEqual({ kind: 'create', ref: { repository: 'acme/app', pullNumber: 42, tab: 'overview' } })
  })

  it('reuses the node the project already has for that PR', () => {
    const pullNodes = [{ id: 'pull-9', pull: { repository: 'acme/app', pullNumber: 42 } }]
    expect(planPullCreated({ created, repo: { repository: 'acme/app', approved: true }, pullNodes }))
      .toEqual({ kind: 'reuse', nodeId: 'pull-9' })
  })

  it('refuses a PR of another repository, and a project with no repository', () => {
    for (const repo of [{ repository: 'other/app', approved: true }, { approved: false }, undefined]) {
      expect(planPullCreated({ created, repo, pullNodes: [] })).toMatchObject({ kind: 'refuse' })
    }
  })

  it('refuses a relay guest', () => {
    expect(planPullCreated({ created, repo: { repository: 'acme/app', approved: true }, pullNodes: [], relayGuest: true }))
      .toEqual({ kind: 'refuse', error: expect.stringContaining('open-pr-relay-refused') })
  })
})

describe('pullCreatedControl', () => {
  it('is the open-pr call the reporting agent would have made', () => {
    expect(pullCreatedControl({ nodeId: 'n1', repository: 'acme/app', pullNumber: 42 })).toEqual({
      cmd: { requestId: '', sourceNodeId: 'n1', verb: 'open-pr', args: { pr: '42' } },
      created: { repository: 'acme/app', pullNumber: 42 }
    })
  })
})

describe('openPrLanding', () => {
  const create = { kind: 'create' as const, ref: { repository: 'acme/app', pullNumber: 42, tab: 'overview' as const } }
  const reuse = { kind: 'reuse' as const, nodeId: 'pull-1' }

  it('the hook path never moves the camera: a new node gets a Jump toast, a reused one nothing', () => {
    for (const onScreen of [true, false]) {
      expect(openPrLanding({ plan: create, onScreen, fromHook: true })).toEqual({ travel: false, toast: 'PR #42 opened' })
      expect(openPrLanding({ plan: reuse, onScreen, fromHook: true })).toEqual({ travel: false })
    }
  })

  it('the open-pr verb keeps framing a reused node on screen, and only that', () => {
    expect(openPrLanding({ plan: reuse, onScreen: true, fromHook: false })).toEqual({ travel: true })
    expect(openPrLanding({ plan: reuse, onScreen: false, fromHook: false })).toEqual({ travel: false })
    expect(openPrLanding({ plan: create, onScreen: true, fromHook: false })).toEqual({ travel: false })
  })
})
