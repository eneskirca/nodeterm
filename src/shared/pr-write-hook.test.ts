import { describe, expect, it } from 'vitest'
import { PRE_TOOL_DENY_PREFIX, PR_GATE_ANSWER_MAX_BYTES, answerPrWriteGate, isPrGateAnswer, isPrGateId, parsePrWrites, preToolDenyAnswer, prRefreshTargets, prWriteEvent, prWriteGateDecision } from './pr-write-hook'

describe('parsePrWrites', () => {
  it('reads each gh pr write form', () => {
    expect(parsePrWrites('gh pr merge 8')).toEqual([{ action: 'merge', pullNumber: 8 }])
    expect(parsePrWrites('gh pr merge 8 --squash --delete-branch')).toEqual([{ action: 'merge', pullNumber: 8, method: 'squash' }])
    expect(parsePrWrites('gh pr merge -r 8')).toEqual([{ action: 'merge', pullNumber: 8, method: 'rebase' }])
    expect(parsePrWrites('gh pr review 8 --approve')).toEqual([{ action: 'approve', pullNumber: 8 }])
    expect(parsePrWrites('gh pr review 8 -r -b "fix the test"')).toEqual([{ action: 'request-changes', pullNumber: 8 }])
    expect(parsePrWrites('gh pr review --comment -b ok 8')).toEqual([{ action: 'comment', pullNumber: 8 }])
    expect(parsePrWrites('gh pr comment 8 --body "looks good"')).toEqual([{ action: 'comment', pullNumber: 8 }])
    expect(parsePrWrites('gh pr close 8 -c "superseded"')).toEqual([{ action: 'close', pullNumber: 8 }])
  })

  it('reads the PR as a number, #number, URL or nothing', () => {
    expect(parsePrWrites('gh pr merge "#8"')).toEqual([{ action: 'merge', pullNumber: 8 }])
    expect(parsePrWrites('gh pr merge https://github.com/acme/app/pull/8')).toEqual([
      { action: 'merge', pullNumber: 8, repository: 'acme/app' }
    ])
    expect(parsePrWrites('gh pr merge --squash')).toEqual([{ action: 'merge', method: 'squash' }])
    expect(parsePrWrites('gh pr merge feature-branch')).toEqual([{ action: 'merge' }])
  })

  it('names the repository -R, --repo, --repo= or GH_REPO points at', () => {
    expect(parsePrWrites('gh pr merge 8 -R other/repo')).toEqual([{ action: 'merge', pullNumber: 8, repository: 'other/repo' }])
    expect(parsePrWrites('gh pr merge 8 --repo=github.com/other/repo')).toEqual([
      { action: 'merge', pullNumber: 8, repository: 'other/repo' }
    ])
    expect(parsePrWrites('gh pr -R other/repo comment 8 -b x')).toEqual([{ action: 'comment', pullNumber: 8, repository: 'other/repo' }])
    expect(parsePrWrites('GH_REPO=other/repo gh pr close 8')).toEqual([{ action: 'close', pullNumber: 8, repository: 'other/repo' }])
  })

  it('is not fooled by quotes, and finds a write anywhere in a chain', () => {
    expect(parsePrWrites('git push && gh pr merge 8 --squash')).toEqual([{ action: 'merge', pullNumber: 8, method: 'squash' }])
    expect(parsePrWrites('npm test; gh pr review 8 --approve || echo no')).toEqual([{ action: 'approve', pullNumber: 8 }])
    expect(parsePrWrites('echo "gh pr merge 8"')).toEqual([])
    expect(parsePrWrites("gh pr comment 8 --body 'done && gh pr merge 9'")).toEqual([{ action: 'comment', pullNumber: 8 }])
    expect(parsePrWrites('cd app\ngh pr close 8')).toEqual([{ action: 'close', pullNumber: 8 }])
    expect(parsePrWrites('/opt/homebrew/bin/gh pr merge 8')).toEqual([{ action: 'merge', pullNumber: 8 }])
  })

  it('leaves reads and browser opens alone', () => {
    expect(parsePrWrites('gh pr view 8 --comments')).toEqual([])
    expect(parsePrWrites('gh pr diff 8')).toEqual([])
    expect(parsePrWrites('gh pr checks 8 --watch')).toEqual([])
    expect(parsePrWrites('gh pr comment 8 --web')).toEqual([])
    expect(parsePrWrites('gh pr review 8')).toEqual([])
    expect(parsePrWrites('gh pr create --fill')).toEqual([])
    expect(parsePrWrites('ghost pr merge 8')).toEqual([])
    expect(parsePrWrites('gh api repos/acme/app/pulls/8')).toEqual([])
  })

  it('reads gh api writes to a PR by method and path', () => {
    expect(parsePrWrites('gh api -X PUT repos/acme/app/pulls/8/merge')).toEqual([
      { action: 'merge', pullNumber: 8, repository: 'acme/app' }
    ])
    expect(parsePrWrites('gh api --method=POST /repos/{owner}/{repo}/pulls/8/reviews -f event=APPROVE')).toEqual([
      { action: 'review', pullNumber: 8 }
    ])
    expect(parsePrWrites('gh api repos/acme/app/pulls/8/comments -f body=hi -f path=a.ts')).toEqual([
      { action: 'comment', pullNumber: 8, repository: 'acme/app' }
    ])
    expect(parsePrWrites('gh api -XPATCH https://api.github.com/repos/acme/app/issues/8/comments')).toEqual([
      { action: 'comment', pullNumber: 8, repository: 'acme/app', viaIssue: true }
    ])
    expect(parsePrWrites('gh api repos/:owner/:repo/issues/8/comments --input body.json')).toEqual([
      { action: 'comment', pullNumber: 8, viaIssue: true }
    ])
  })

  it('leaves gh api reads and other paths alone', () => {
    expect(parsePrWrites('gh api repos/acme/app/pulls/8/comments')).toEqual([])
    expect(parsePrWrites('gh api -X GET repos/acme/app/pulls/8/reviews -f per_page=100')).toEqual([])
    expect(parsePrWrites('gh api -X DELETE repos/acme/app/issues/comments/5')).toEqual([])
    expect(parsePrWrites('gh api -X POST repos/acme/app/issues/8/labels -f labels[]=x')).toEqual([])
    expect(parsePrWrites('gh api graphql -f query=x')).toEqual([])
  })
})

const hook = (event: string, command: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: event,
  tool_name: 'Bash',
  tool_input: { command },
  ...extra
})

describe('prWriteEvent', () => {
  it('reads a verified Claude Code or Codex Bash PreToolUse / PostToolUse', () => {
    expect(prWriteEvent('claude', 'n1', hook('PreToolUse', 'gh pr merge 8'), { verified: true }))
      .toEqual({ nodeId: 'n1', phase: 'pre', writes: [{ action: 'merge', pullNumber: 8 }] })
    expect(prWriteEvent('codex', 'n1', hook('PostToolUse', 'gh pr close 8', { tool_response: '' }), { verified: true }))
      .toEqual({ nodeId: 'n1', phase: 'post', writes: [{ action: 'close', pullNumber: 8 }] })
  })

  it('reads nothing from an unverified caller, another agent, another tool or a command with no write', () => {
    expect(prWriteEvent('claude', 'n1', hook('PreToolUse', 'gh pr merge 8'), { verified: false })).toBeUndefined()
    expect(prWriteEvent('grok', 'n1', hook('PreToolUse', 'gh pr merge 8'), { verified: true })).toBeUndefined()
    expect(prWriteEvent('claude', 'n1', { ...hook('PreToolUse', 'gh pr merge 8'), tool_name: 'Write' }, { verified: true })).toBeUndefined()
    expect(prWriteEvent('claude', 'n1', hook('Stop', 'gh pr merge 8'), { verified: true })).toBeUndefined()
    expect(prWriteEvent('claude', 'n1', hook('PreToolUse', 'gh pr view 8'), { verified: true })).toBeUndefined()
    expect(prWriteEvent('claude', '', hook('PreToolUse', 'gh pr merge 8'), { verified: true })).toBeUndefined()
  })
})

const own = 'acme/app'
const node = (id: string, pullNumber: number, linked: boolean, repository = own) => ({ id, repository, pullNumber, linked })

describe('prWriteGateDecision', () => {
  it('denies an own-repo write to a PR with a linked pull node and names pr-propose for it', () => {
    const d = prWriteGateDecision({ writes: [{ action: 'merge', pullNumber: 8, method: 'squash' }], repo: own, pullNodes: [node('p8', 8, true)] })
    expect(d.deny).toContain('pr-propose --node p8 --action merge --method squash')
    expect(d.deny).toContain('Do not write to GitHub yourself')
    expect(d.deny).not.toContain('open-pr')
  })

  it('names the message pr-propose needs for a review or comment', () => {
    const d = prWriteGateDecision({ writes: [{ action: 'approve', pullNumber: 8 }], repo: own, pullNodes: [node('p8', 8, true)] })
    expect(d.deny).toContain('pr-propose --node p8 --action approve --message')
  })

  it('tells the agent to link an unlinked pull node first', () => {
    const d = prWriteGateDecision({ writes: [{ action: 'comment', pullNumber: 8 }], repo: own, pullNodes: [node('p8', 8, false)] })
    expect(d.deny).toContain('open-pr --pr 8')
    expect(d.deny).toContain('pr-propose --node p8 --action comment')
  })

  it('tells the agent to open the PR first when no pull node exists', () => {
    const d = prWriteGateDecision({ writes: [{ action: 'merge', pullNumber: 8 }], repo: own, pullNodes: [node('p9', 9, true)] })
    expect(d.deny).toContain('open-pr --pr 8')
    expect(d.deny).toContain('pr-propose --node <the id it prints> --action merge')
  })

  it('uses the one linked pull node for a write that names no PR', () => {
    const d = prWriteGateDecision({ writes: [{ action: 'merge' }], repo: own, pullNodes: [node('p8', 8, true), node('p9', 9, false)] })
    expect(d.deny).toContain('pr-propose --node p8 --action merge')
    const two = prWriteGateDecision({ writes: [{ action: 'merge' }], repo: own, pullNodes: [node('p8', 8, true), node('p9', 9, true)] })
    expect(two.deny).toContain('open-pr --pr <number>')
  })

  it('denies a close without a pr-propose action to name', () => {
    const d = prWriteGateDecision({ writes: [{ action: 'close', pullNumber: 8 }], repo: own, pullNodes: [node('p8', 8, true)] })
    expect(d.deny).toContain('Do not write to GitHub yourself')
    expect(d.deny).not.toContain('pr-propose')
  })

  it('allows another repository, a project with no resolved repository, and an issue with no pull node', () => {
    expect(prWriteGateDecision({ writes: [{ action: 'merge', pullNumber: 8, repository: 'other/repo' }], repo: own, pullNodes: [] }).deny)
      .toBeUndefined()
    expect(prWriteGateDecision({ writes: [{ action: 'merge', pullNumber: 8 }], repo: undefined, pullNodes: [node('p8', 8, true)] }).deny)
      .toBeUndefined()
    expect(prWriteGateDecision({ writes: [{ action: 'comment', pullNumber: 8, viaIssue: true }], repo: own, pullNodes: [] }).deny)
      .toBeUndefined()
    expect(prWriteGateDecision({ writes: [{ action: 'comment', pullNumber: 8, viaIssue: true }], repo: own, pullNodes: [node('p8', 8, false)] }).deny)
      .toContain('open-pr --pr 8')
  })

  it('matches the repository without regard to case and ignores a pull node of another repository', () => {
    const d = prWriteGateDecision({ writes: [{ action: 'merge', pullNumber: 8, repository: 'ACME/App' }], repo: own, pullNodes: [node('x8', 8, true, 'other/repo')] })
    expect(d.deny).toContain('open-pr --pr 8')
  })

  it('denies the whole command when any write in it is to the project repository', () => {
    const d = prWriteGateDecision({
      writes: [{ action: 'comment', pullNumber: 1, repository: 'other/repo' }, { action: 'merge', pullNumber: 8 }],
      repo: own,
      pullNodes: [node('p8', 8, true)]
    })
    expect(d.deny).toContain('--node p8')
  })
})

describe('prRefreshTargets', () => {
  it('refreshes every pull node of the written PR in the project repository', () => {
    expect(prRefreshTargets({ writes: [{ action: 'merge', pullNumber: 8 }], repo: own, pullNodes: [node('a', 8, false), node('b', 8, true), node('c', 9, true)] }))
      .toEqual(['a', 'b'])
  })

  it('refreshes the linked node for a write that names no PR, and nothing for another repository', () => {
    expect(prRefreshTargets({ writes: [{ action: 'merge' }], repo: own, pullNodes: [node('a', 8, true)] })).toEqual(['a'])
    expect(prRefreshTargets({ writes: [{ action: 'merge', pullNumber: 8, repository: 'other/repo' }], repo: own, pullNodes: [node('a', 8, true)] }))
      .toEqual([])
  })
})

describe('preToolDenyAnswer', () => {
  it('is the PreToolUse deny JSON Claude Code and Codex read, on one line', () => {
    const line = preToolDenyAnswer('no "merge"\nhere')
    expect(line.startsWith(PRE_TOOL_DENY_PREFIX)).toBe(true)
    expect(line).not.toContain('\n')
    expect(JSON.parse(line)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no "merge"\nhere' }
    })
  })
})

describe('isPrGateAnswer / isPrGateId', () => {
  it('accepts allow and the deny line the gate poll prints, nothing else', () => {
    expect(isPrGateAnswer('allow')).toBe(true)
    expect(isPrGateAnswer(preToolDenyAnswer('no'))).toBe(true)
    expect(isPrGateAnswer('deny')).toBe(false)
    expect(isPrGateAnswer('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}')).toBe(false)
    expect(isPrGateAnswer(`${preToolDenyAnswer('no').slice(0, -1)}\n}`)).toBe(false)
    expect(isPrGateAnswer(preToolDenyAnswer('x'.repeat(PR_GATE_ANSWER_MAX_BYTES)))).toBe(false)
  })

  it('takes gate tickets only, never a held permission id', () => {
    expect(isPrGateId('gate-node-1-1730000000000-42')).toBe(true)
    expect(isPrGateId('node-1-1730000000000-42')).toBe(false)
    expect(isPrGateId('gate-../x')).toBe(false)
    expect(isPrGateId(undefined)).toBe(false)
  })
})

describe('answerPrWriteGate', () => {
  const event = { nodeId: 'n1', phase: 'pre' as const, writes: [{ action: 'merge' as const, pullNumber: 8 }] }
  const harness = () => {
    const written: string[] = []
    const logs: string[] = []
    return { written, logs, write: async (c: string) => (written.push(c), true), log: (m: string) => logs.push(m) }
  }

  it('writes the deny the canvas decided, cut to a bounded length', async () => {
    const h = harness()
    await answerPrWriteGate({ event, ask: async () => ({ deny: 'no' }), write: h.write, log: h.log })
    await answerPrWriteGate({ event, ask: async () => ({ deny: 'y'.repeat(10_000) }), write: h.write, log: h.log })
    expect(h.written[0]).toBe(preToolDenyAnswer('no'))
    expect(isPrGateAnswer(h.written[1])).toBe(true)
  })

  it('allows at once, without asking, when there is nothing to gate', async () => {
    const h = harness()
    let asked = false
    await answerPrWriteGate({ event: undefined, ask: async () => ((asked = true), { deny: 'no' }), write: h.write, log: h.log })
    await answerPrWriteGate({ event: { ...event, phase: 'post' }, ask: async () => ((asked = true), { deny: 'no' }), write: h.write, log: h.log })
    expect(h.written).toEqual(['allow', 'allow'])
    expect(asked).toBe(false)
  })

  it('fails open on a timeout or an error, and logs it', async () => {
    const h = harness()
    await answerPrWriteGate({ event, ask: () => new Promise(() => {}), write: h.write, log: h.log, timeoutMs: 10 })
    await answerPrWriteGate({ event, ask: async () => { throw new Error('boom') }, write: h.write, log: h.log })
    expect(h.written).toEqual(['allow', 'allow'])
    expect(h.logs).toHaveLength(2)
    expect(h.logs[0]).toContain('timed out')
  })

  it('logs an answer it could not write (the hook then times out open)', async () => {
    const h = harness()
    await answerPrWriteGate({ event, ask: async () => ({}), write: async () => false, log: h.log })
    expect(h.logs).toEqual([expect.stringContaining('could not write')])
  })
})
