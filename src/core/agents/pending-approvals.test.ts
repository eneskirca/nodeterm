import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  isValidPendingId,
  pendingDir,
  writePendingAnswerLocal,
  answerPendingLocal,
  answerPendingHookLocal,
  pendingBelongsToNode,
  sweepPendingDir,
  syntheticAnsweredEvent,
  PENDING_MAX_AGE_MS,
  readPendingRequestLocal,
  localHeldPermissionIo
} from './pending-approvals'
import {
  answerHeldPermission,
  labelHeldForRevision,
  MIN_STRUCTURED_ANSWER_REVISION,
  PENDING_REQUEST_MAX_BYTES,
  PERMISSION_DECISION_PREFIX
} from './permission-decision'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-pending-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('isValidPendingId', () => {
  it('accepts the script charset', () => {
    expect(isValidPendingId('nt_node-1720000000000-12345')).toBe(true)
    expect(isValidPendingId('abcXYZ_09-')).toBe(true)
  })
  it('rejects traversal / injection / empty', () => {
    expect(isValidPendingId('')).toBe(false)
    expect(isValidPendingId('../etc/passwd')).toBe(false)
    expect(isValidPendingId('a/b')).toBe(false)
    expect(isValidPendingId('a b')).toBe(false)
    expect(isValidPendingId('a;rm -rf')).toBe(false)
    expect(isValidPendingId('a.answer')).toBe(false)
    expect(isValidPendingId('a'.repeat(257))).toBe(false)
  })
})

/** A hook currently holding `id` (the request file the managed script writes and deletes). */
function hold(id: string): void {
  fs.mkdirSync(pendingDir(home), { recursive: true })
  fs.writeFileSync(path.join(pendingDir(home), `${id}.json`), '{}')
}

describe('writePendingAnswerLocal', () => {
  it('writes the one-line answer file for a valid id + decision', async () => {
    hold('node-1-2')
    const ok = await writePendingAnswerLocal('node-1-2', 'allow', home)
    expect(ok).toBe(true)
    const file = path.join(pendingDir(home), 'node-1-2.answer')
    expect(fs.readFileSync(file, 'utf8')).toBe('allow')
  })

  it('writes deny too', async () => {
    hold('n')
    expect(await writePendingAnswerLocal('n', 'deny', home)).toBe(true)
    expect(fs.readFileSync(path.join(pendingDir(home), 'n.answer'), 'utf8')).toBe('deny')
  })

  it('leaves no .tmp behind (atomic rename)', async () => {
    hold('n')
    await writePendingAnswerLocal('n', 'allow', home)
    const entries = fs.readdirSync(pendingDir(home)).sort()
    expect(entries).toEqual(['n.answer', 'n.json'])
  })

  it('refuses an invalid pendingId and writes nothing', async () => {
    expect(await writePendingAnswerLocal('../evil', 'allow', home)).toBe(false)
    expect(fs.existsSync(pendingDir(home))).toBe(false)
  })

  it('refuses content the hook script would not print (the same bound)', async () => {
    hold('n')
    expect(await writePendingAnswerLocal('n', 'always', home)).toBe(false)
    expect(await writePendingAnswerLocal('n', '{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}', home)).toBe(false)
    expect(await writePendingAnswerLocal('n', `${PERMISSION_DECISION_PREFIX}"allow"}}}\nX`, home)).toBe(false)
    expect(fs.existsSync(path.join(pendingDir(home), 'n.answer'))).toBe(false)
  })

  it('refuses a structured decision after the held request is gone', async () => {
    hold('n')
    fs.unlinkSync(path.join(pendingDir(home), 'n.json'))
    const json = `${PERMISSION_DECISION_PREFIX}"allow","updatedInput":{}}}}`
    expect(await writePendingAnswerLocal('n', json, home)).toBe(false)
    expect(fs.readdirSync(pendingDir(home))).toEqual([])
  })

  it('writes a core-built JSON decision verbatim, 0600', async () => {
    hold('n')
    const json = `${PERMISSION_DECISION_PREFIX}"allow","updatedInput":{}}}}`
    expect(await writePendingAnswerLocal('n', json, home)).toBe(true)
    const f = path.join(pendingDir(home), 'n.answer')
    expect(fs.readFileSync(f, 'utf8')).toBe(json)
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o777).toBe(0o600)
  })
})

describe('readPendingRequestLocal + localHeldPermissionIo', () => {
  it('reads the held request, and answers null once it is gone or for a bad id', async () => {
    fs.mkdirSync(pendingDir(home), { recursive: true })
    const req = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: 'p' } })
    fs.writeFileSync(path.join(pendingDir(home), 'n.json'), req)
    expect(await readPendingRequestLocal('n', home)).toBe(req)
    expect(await readPendingRequestLocal('gone', home)).toBeNull()
    expect(await readPendingRequestLocal('../n', home)).toBeNull()
  })
  it('refuses an over-long request file rather than reading it', async () => {
    fs.mkdirSync(pendingDir(home), { recursive: true })
    fs.writeFileSync(path.join(pendingDir(home), 'big.json'), 'x'.repeat(PENDING_REQUEST_MAX_BYTES + 1))
    expect(await readPendingRequestLocal('big', home)).toBeNull()
  })
  it('reads a file exactly at the cap, and refuses a directory at the name', async () => {
    fs.mkdirSync(pendingDir(home), { recursive: true })
    const atCap = 'y'.repeat(PENDING_REQUEST_MAX_BYTES)
    fs.writeFileSync(path.join(pendingDir(home), 'cap.json'), atCap)
    expect(await readPendingRequestLocal('cap', home)).toBe(atCap)
    fs.mkdirSync(path.join(pendingDir(home), 'dir.json'))
    expect(await readPendingRequestLocal('dir', home)).toBeNull()
  })
  it.skipIf(process.platform === 'win32')('refuses a symlink planted at the name (O_NOFOLLOW; POSIX only)', async () => {
    fs.mkdirSync(pendingDir(home), { recursive: true })
    const target = path.join(home, 'secret.json')
    fs.writeFileSync(target, JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }))
    fs.symlinkSync(target, path.join(pendingDir(home), 'link.json'))
    expect(await readPendingRequestLocal('link', home)).toBeNull()
  })
  it('end to end: a plan answer is built from the file on disk and written beside it', async () => {
    fs.mkdirSync(pendingDir(home), { recursive: true })
    fs.writeFileSync(
      path.join(pendingDir(home), 'n.json'),
      JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: 'p' } })
    )
    labelHeldForRevision(
      { nodeId: 'x', agentId: 'claude', kind: 'state', state: 'blocked', held: { pendingId: 'n', toolName: 'ExitPlanMode' } },
      MIN_STRUCTURED_ANSWER_REVISION
    )
    const res = await answerHeldPermission('n', { answer: { kind: 'plan', mode: 'restore' } }, localHeldPermissionIo('n', home))
    expect(res).toEqual({ ok: true, decision: 'allow' })
    expect(fs.readFileSync(path.join(pendingDir(home), 'n.answer'), 'utf8')).toBe(
      `${PERMISSION_DECISION_PREFIX}"allow","updatedInput":{}}}}`
    )
  })

  // A06: the hook deletes <id>.json when its 45 s hold ends. Writing the answer anyway used to
  // report success (and clear NEEDS YOU everywhere) for an answer nothing would ever read.
  it('reports false and writes nothing once the hold has ended', async () => {
    fs.mkdirSync(pendingDir(home), { recursive: true })
    expect(await writePendingAnswerLocal('late-1', 'allow', home)).toBe(false)
    expect(fs.existsSync(path.join(pendingDir(home), 'late-1.answer'))).toBe(false)
  })
})

describe('answerPendingLocal', () => {
  it('says sent for a live hold', async () => {
    hold('live-1')
    expect(await answerPendingLocal('live-1', 'deny', home)).toBe('sent')
  })

  it('says gone — not failed — when the hold ended (A35)', async () => {
    expect(await answerPendingLocal('late-1', 'allow', home)).toBe('gone')
    fs.mkdirSync(pendingDir(home), { recursive: true })
    expect(await answerPendingLocal('late-1', 'allow', home)).toBe('gone')
  })

  it('says failed when the answer cannot be written', async () => {
    hold('ro-1')
    // A directory where the answer file should go makes the rename fail.
    fs.mkdirSync(path.join(pendingDir(home), 'ro-1.answer'))
    expect(await answerPendingLocal('ro-1', 'allow', home)).toBe('failed')
  })

  it('says failed for an invalid id', async () => {
    expect(await answerPendingLocal('../x', 'allow', home)).toBe('failed')
  })
})

describe('structured hook replies', () => {
  const request = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', permission_suggestions: [
    { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }
  ] }
  function holdRequest(id = 'node-99-7', value: unknown = request): void {
    hold(id)
    fs.writeFileSync(path.join(pendingDir(home), `${id}.json`), JSON.stringify(value))
  }
  it('binds the ticket to its exact node and script suffix', () => {
    expect(pendingBelongsToNode('node', 'node-99-7')).toBe(true)
    for (const id of ['other-99-7', 'node-suffix', 'node-extra-99-7']) expect(pendingBelongsToNode('node', id)).toBe(false)
  })
  it('writes only a live owned concrete suggested rule, privately and atomically', async () => {
    holdRequest()
    expect(await answerPendingHookLocal('node', 'node-99-7', { kind: 'allow-always', suggestionIndex: 0 }, home)).toBe('sent')
    const file = path.join(pendingDir(home), 'node-99-7.answer')
    const [marker, output] = fs.readFileSync(file, 'utf8').split('\n')
    expect(marker).toBe('nodeterm-hook-reply-v2')
    expect(JSON.parse(output).hookSpecificOutput.decision.updatedPermissions).toEqual(request.permission_suggestions)
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(pendingDir(home)).sort()).toEqual(['node-99-7.answer', 'node-99-7.json'])
  })
  it('refuses foreign tickets, ended holds, malformed or oversized requests without an answer', async () => {
    holdRequest()
    expect(await answerPendingHookLocal('other', 'node-99-7', { kind: 'allow-always', suggestionIndex: 0 }, home)).toBe('failed')
    expect(await answerPendingHookLocal('node', 'node-99-8', { kind: 'allow-always', suggestionIndex: 0 }, home)).toBe('gone')
    for (const bytes of ['not json', 'x'.repeat(128 * 1024 + 1)]) {
      fs.writeFileSync(path.join(pendingDir(home), 'node-99-7.json'), bytes)
      expect(await answerPendingHookLocal('node', 'node-99-7', { kind: 'allow-always', suggestionIndex: 0 }, home)).toBe('failed')
    }
    expect(fs.existsSync(path.join(pendingDir(home), 'node-99-7.answer'))).toBe(false)
  })
  it('refuses a held file replaced during the bounded read', async () => {
    holdRequest()
    const read = fs.promises.readFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'readFile').mockImplementationOnce(async (...args: any[]) => {
      const bytes = await (read as any)(...args)
      const next = path.join(pendingDir(home), 'replacement.json')
      fs.writeFileSync(next, JSON.stringify(request))
      fs.renameSync(next, path.join(pendingDir(home), 'node-99-7.json'))
      return bytes
    })
    expect(await answerPendingHookLocal('node', 'node-99-7', { kind: 'allow-always', suggestionIndex: 0 }, home)).toBe('failed')
    expect(fs.existsSync(path.join(pendingDir(home), 'node-99-7.answer'))).toBe(false)
  })
  it('does not publish if the hook times out while the complete reply is being staged', async () => {
    holdRequest()
    const write = fs.promises.writeFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(async (...args: any[]) => {
      await (write as any)(...args)
      fs.unlinkSync(path.join(pendingDir(home), 'node-99-7.json'))
    })
    expect(await answerPendingHookLocal('node', 'node-99-7', { kind: 'allow-always', suggestionIndex: 0 }, home)).toBe('gone')
    expect(fs.readdirSync(pendingDir(home))).toEqual([])
  })
  it.skipIf(process.platform === 'win32')('does not follow a symlink masquerading as a held request', async () => {
    holdRequest('other-1-1')
    fs.symlinkSync(path.join(pendingDir(home), 'other-1-1.json'), path.join(pendingDir(home), 'node-99-7.json'))
    expect(await answerPendingHookLocal('node', 'node-99-7', { kind: 'allow-always', suggestionIndex: 0 }, home)).toBe('failed')
    expect(fs.existsSync(path.join(pendingDir(home), 'node-99-7.answer'))).toBe(false)
  })
  it('writes structured question answers without changing the requested tool input', async () => {
    const questions = [{ question: 'Which?', header: 'Options', multiSelect: true, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]
    holdRequest('node-99-7', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions } })
    expect(await answerPendingHookLocal('node', 'node-99-7', { kind: 'question', selections: [[0, 1]] }, home)).toBe('sent')
    const result = JSON.parse(fs.readFileSync(path.join(pendingDir(home), 'node-99-7.answer'), 'utf8').split('\n')[1])
    expect(result.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions, answers: { 'Which?': 'A, B' } } })
  })
})

describe('syntheticAnsweredEvent (optimistic-flip builder)', () => {
  it('builds a claude working-state event threading the pendingId (allow)', () => {
    const e = syntheticAnsweredEvent('node-1', 'node-1-99-7', 'allow')
    expect(e).toMatchObject({
      nodeId: 'node-1',
      agentId: 'claude',
      kind: 'state',
      state: 'working',
      pendingId: 'node-1-99-7'
    })
  })

  it('builds a working event for deny too (the agent continues the turn)', () => {
    expect(syntheticAnsweredEvent('n', 'n-1-1', 'deny')).toMatchObject({ state: 'working', pendingId: 'n-1-1' })
  })

  it('returns null on an out-of-contract decision', () => {
    // @ts-expect-error — exercising the runtime guard
    expect(syntheticAnsweredEvent('n', 'n-1-1', 'always')).toBeNull()
  })
})

describe('sweepPendingDir', () => {
  it('removes files older than the max age, keeps fresh ones', async () => {
    const dir = pendingDir(home)
    fs.mkdirSync(dir, { recursive: true })
    const stale = path.join(dir, 'old-1.json')
    const fresh = path.join(dir, 'new-1.json')
    fs.writeFileSync(stale, '{}')
    fs.writeFileSync(fresh, '{}')
    const now = Date.now()
    // Backdate the stale file well past the window.
    const old = new Date(now - PENDING_MAX_AGE_MS - 60_000)
    fs.utimesSync(stale, old, old)

    const removed = await sweepPendingDir(now, PENDING_MAX_AGE_MS, home)
    expect(removed).toBe(1)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('also sweeps stale .answer orphans and ignores unrelated files', async () => {
    const dir = pendingDir(home)
    fs.mkdirSync(dir, { recursive: true })
    const ans = path.join(dir, 'x.answer')
    const other = path.join(dir, 'notes.txt')
    fs.writeFileSync(ans, 'allow')
    fs.writeFileSync(other, 'keep')
    const now = Date.now()
    const old = new Date(now - PENDING_MAX_AGE_MS - 1000)
    fs.utimesSync(ans, old, old)
    fs.utimesSync(other, old, old)

    const removed = await sweepPendingDir(now, PENDING_MAX_AGE_MS, home)
    expect(removed).toBe(1)
    expect(fs.existsSync(ans)).toBe(false)
    expect(fs.existsSync(other)).toBe(true) // non-pending file untouched
  })

  it('returns 0 (no throw) when the dir does not exist', async () => {
    expect(await sweepPendingDir(Date.now(), PENDING_MAX_AGE_MS, home)).toBe(0)
  })
})
