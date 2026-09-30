// A retried control call must not open a second node — exercised at the ONE place both shells pass:
// the hook server's `/control/` route. Desktop main and the Server Edition each register a handler
// behind it; neither sees a request the ledger answered, which is what these tests count.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import { REQUEST_ID_HINT_LEAD, REQUEST_ID_REPLAYED_LEAD } from '../control-request-ledger'

const secret = Buffer.alloc(32, 7)
let dir: string
type Cmd = { verb: string; nodeId: string; args: Record<string, string>; verified: boolean }
let handled: Cmd[] = []
/** Whether each call was handed the late-answer path — main words its timeout by exactly this. */
let lateOffered: boolean[] = []
let next: (cmd: Cmd, late?: (r: { ok: boolean; message?: string }) => void) => Promise<{
  ok: boolean
  message?: string
  result?: unknown
  error?: string
  indeterminate?: boolean
}>

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-reqid-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(secret)
  hookServer.setControlHandler(async (cmd) => {
    handled.push({ verb: cmd.verb, nodeId: cmd.nodeId, args: cmd.args, verified: cmd.verified })
    lateOffered.push(typeof cmd.onLateAnswer === 'function')
    return next(cmd, cmd.onLateAnswer)
  })
})
beforeEach(() => {
  handled = []
  lateOffered = []
  let n = 0
  next = async (cmd) => ({ ok: true, message: `opened n${++n}`, result: { ids: [`n${n}`], verb: cmd.verb } })
})
afterAll(() => {
  hookServer.setIdentityStrictOverride(() => undefined)
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

let seq = 0
/** A fresh caller node per test, so rows from one test never answer another. */
const freshNode = (): string => `src-${++seq}`

function post(
  verb: string,
  opts: {
    node: string
    args?: Record<string, string>
    cliRequestId?: string
    json?: boolean
    verified?: boolean
  }
): Promise<{ status: number; body: string }> {
  const { node, args = {}, cliRequestId, json = false, verified = true } = opts
  const body = json
    ? JSON.stringify({ nodeId: node, args, ...(cliRequestId ? { requestId: cliRequestId } : {}) })
    : new URLSearchParams({
        nodeId: node,
        ...(cliRequestId ? { requestId: cliRequestId } : {}),
        ...Object.fromEntries(Object.entries(args).map(([k, v]) => [`arg.${k}`, v]))
      }).toString()
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: hookServer.getPort(),
        path: `/control/${verb}`,
        method: 'POST',
        headers: {
          'x-nodeterm-hook-token': hookServer.getToken(),
          ...(verified ? { 'x-nodeterm-node-token': nodeAuthToken(secret, node) } : {}),
          'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
          accept: json ? 'application/json' : 'text/plain'
        }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode!, body: text }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('control route: --request-id makes a retried open idempotent', () => {
  it('the same id twice runs the handler ONCE and replays the original reply, marked as a replay', async () => {
    const node = freshNode()
    const args = { agent: 'claude', prompt: 'build it', 'request-id': 'wave1-a' }
    const first = await post('open-agent', { node, args })
    expect(first).toEqual({ status: 200, body: 'opened n1\n' })
    const again = await post('open-agent', { node, args })
    expect(again.status).toBe(200)
    expect(again.body.split('\n')[0]).toContain(REQUEST_ID_REPLAYED_LEAD)
    expect(again.body).toContain('wave1-a')
    expect(again.body).toContain('opened n1')
    expect(again.body).not.toContain('opened n2')
    expect(handled).toHaveLength(1)
  })

  it('the JSON dialect replays the whole stored reply plus `replayed: true`', async () => {
    const node = freshNode()
    const args = { agent: 'claude', 'request-id': 'r-json' }
    const first = JSON.parse((await post('open-agent', { node, args, json: true })).body)
    const again = JSON.parse((await post('open-agent', { node, args, json: true })).body)
    expect(again).toEqual({ ...first, replayed: true, requestId: 'r-json' })
    expect(handled).toHaveLength(1)
  })

  it('the handler never sees the id', async () => {
    await post('open-agent', { node: freshNode(), args: { agent: 'claude', 'request-id': 'x1' }, cliRequestId: 'cli-1' })
    expect(handled[0].args).toEqual({ agent: 'claude' })
  })

  it('the same id with different args is a conflict: refused, nothing runs', async () => {
    const node = freshNode()
    await post('open-agent', { node, args: { agent: 'claude', 'request-id': 'r1' } })
    const clash = await post('open-agent', { node, args: { agent: 'codex', 'request-id': 'r1' } })
    expect(clash.status).toBe(409)
    expect(clash.body).toMatch(/^request-id-conflict: /)
    expect(handled).toHaveLength(1)
  })

  it('a retry while the first call is still running is refused as in flight — still one node', async () => {
    const node = freshNode()
    let release!: () => void
    next = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, message: 'opened slow-1' })
      })
    const args = { agent: 'claude', 'request-id': 'slow' }
    const firstP = post('open-agent', { node, args })
    await vi_waitFor(() => handled.length === 1)
    const during = await post('open-agent', { node, args })
    expect(during.status).toBe(409)
    expect(during.body).toMatch(/^request-in-flight: /)
    release()
    expect((await firstP).body).toBe('opened slow-1\n')
    const after = await post('open-agent', { node, args })
    expect(after.body).toContain('opened slow-1')
    expect(handled).toHaveLength(1)
  })

  it('distinct ids open two nodes', async () => {
    const node = freshNode()
    await post('open-agent', { node, args: { agent: 'claude', 'request-id': 'a' } })
    await post('open-agent', { node, args: { agent: 'claude', 'request-id': 'b' } })
    expect(handled).toHaveLength(2)
  })

  it("the shim's own per-run id dedupes a re-post of the same run, and two runs are two calls", async () => {
    const node = freshNode()
    await post('open-terminal', { node, cliRequestId: 'cli-aaaa' })
    const repost = await post('open-terminal', { node, cliRequestId: 'cli-aaaa' })
    expect(repost.body).toContain('opened n1')
    await post('open-terminal', { node, cliRequestId: 'cli-bbbb' })
    expect(handled).toHaveLength(2)
  })

  it('an explicit id wins over the per-run one', async () => {
    const node = freshNode()
    await post('open-terminal', { node, args: { 'request-id': 'mine' }, cliRequestId: 'cli-1' })
    await post('open-terminal', { node, args: { 'request-id': 'mine' }, cliRequestId: 'cli-2' })
    expect(handled).toHaveLength(1)
  })

  it('an unverified caller gets NO dedupe (never a shared bucket) and an explicit id says so', async () => {
    const node = freshNode()
    const args = { 'request-id': 'legacy-1' }
    const a = await post('open-terminal', { node, args, verified: false })
    const b = await post('open-terminal', { node, args, verified: false })
    expect(handled).toHaveLength(2)
    expect(a.body).toMatch(/request id ignored/i)
    expect(b.body).toMatch(/request id ignored/i)
    // The per-run id alone is silent: the caller never asked for anything.
    const c = await post('open-terminal', { node, cliRequestId: 'cli-9', verified: false })
    expect(c.body).not.toMatch(/request id ignored/i)
  })

  it('a dry run bypasses the ledger: the real call with the same id still runs', async () => {
    const node = freshNode()
    await post('open-agent', { node, args: { agent: 'claude', 'dry-run': '', 'request-id': 'd1' } })
    const real = await post('open-agent', { node, args: { agent: 'claude', 'request-id': 'd1' } })
    expect(real.body).not.toContain(REQUEST_ID_REPLAYED_LEAD)
    expect(handled).toHaveLength(2)
  })

  it('an explicit id on a verb that creates nothing is refused before the handler', async () => {
    const res = await post('rename', { node: freshNode(), args: { node: 'n1', title: 'x', 'request-id': 'r' } })
    expect(res.status).toBe(400)
    expect(res.body).toMatch(/^request-id-unsupported: /)
    expect(handled).toHaveLength(0)
  })

  it('an invalid explicit id is refused before the handler', async () => {
    const res = await post('open-terminal', { node: freshNode(), args: { 'request-id': 'no spaces please' } })
    expect(res.status).toBe(400)
    expect(res.body).toMatch(/^request-id-invalid: /)
    expect(handled).toHaveLength(0)
  })

  it('an answer that could not say whether the effect happened settles as unknown; a late answer is then replayed', async () => {
    const node = freshNode()
    let late!: (r: { ok: boolean; message?: string }) => void
    next = async (_cmd, onLate) => {
      late = onLate!
      return { ok: false, error: 'no answer within 120s', indeterminate: true }
    }
    const args = { branch: 'feat-x', 'request-id': 'wt-1' }
    await post('open-worktree', { node, args })
    const unknown = await post('open-worktree', { node, args })
    expect(unknown.status).toBe(409)
    expect(unknown.body).toMatch(/^request-outcome-unknown: /)
    late({ ok: true, message: 'opened worktree feat-x' })
    const replay = await post('open-worktree', { node, args })
    expect(replay.status).toBe(200)
    expect(replay.body).toContain('opened worktree feat-x')
    expect(handled).toHaveLength(1)
  })

  // Review follow-up to #1027: the timeout told the caller to "retry with the same --request-id" and
  // never said what that id was. For the per-run id the shim generates, the caller has never seen
  // it — so its natural retry was the bare command, a FRESH id, and a second open.
  it('an indeterminate answer names the request id it holds — the per-run one included — and how to pass it', async () => {
    next = async () => ({ ok: false, error: 'no answer within 120s — may still complete', indeterminate: true })
    const text = await post('open-worktree', { node: freshNode(), args: { branch: 'b' }, cliRequestId: 'cli-feed01' })
    expect(text.status).toBe(400)
    expect(text.body).toContain('no answer within 120s')
    expect(text.body).toContain(`${REQUEST_ID_HINT_LEAD} cli-feed01`)
    expect(text.body).toContain('--request-id cli-feed01')
    const json = JSON.parse(
      (await post('open-worktree', { node: freshNode(), args: { branch: 'b' }, cliRequestId: 'cli-feed02', json: true }))
        .body
    )
    expect(json.requestId).toBe('cli-feed02')
    expect(json.message).toContain('--request-id cli-feed02')
    expect(json.error).toContain('no answer within 120s')
  })

  it('with no claim there is no id to name, and the handler is offered no late-answer path', async () => {
    next = async () => ({ ok: false, error: 'no answer within 120s — check the canvas', indeterminate: true })
    const unverified = await post('open-worktree', {
      node: freshNode(),
      args: { branch: 'b', 'request-id': 'mine' },
      verified: false
    })
    expect(unverified.body).not.toContain(REQUEST_ID_HINT_LEAD)
    const noId = await post('open-worktree', { node: freshNode(), args: { branch: 'b' } })
    expect(noId.body).not.toContain(REQUEST_ID_HINT_LEAD)
    await post('open-worktree', { node: freshNode(), args: { branch: 'b' }, cliRequestId: 'cli-x1' })
    expect(lateOffered).toEqual([false, false, true])
  })

  it('an in-flight or unknown refusal spells the flag WITH its value, so a per-run id can be passed back', async () => {
    const node = freshNode()
    let release!: () => void
    next = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: false, error: 'late', indeterminate: true })
      })
    const firstP = post('open-agent', { node, args: { agent: 'claude' }, cliRequestId: 'cli-abc123' })
    await vi_waitFor(() => handled.length === 1)
    const during = await post('open-agent', { node, args: { agent: 'claude' }, cliRequestId: 'cli-abc123' })
    expect(during.body).toMatch(/^request-in-flight: /)
    expect(during.body).toContain('--request-id cli-abc123')
    release()
    await firstP
    const unknown = await post('open-agent', { node, args: { agent: 'claude' }, cliRequestId: 'cli-abc123' })
    expect(unknown.body).toMatch(/^request-outcome-unknown: /)
    expect(unknown.body).toContain('--request-id cli-abc123')
    // …and passing it back as --request-id is the same call, not a conflict.
    const passedBack = await post('open-agent', { node, args: { agent: 'claude', 'request-id': 'cli-abc123' } })
    expect(passedBack.body).toMatch(/^request-outcome-unknown: /)
    expect(handled).toHaveLength(1)
  })

  it('a handler that throws leaves the id unknown: the retry is refused, not re-run', async () => {
    const node = freshNode()
    next = async () => {
      throw new Error('renderer went away')
    }
    const args = { 'request-id': 'boom' }
    await post('open-terminal', { node, args })
    const retry = await post('open-terminal', { node, args })
    expect(retry.body).toMatch(/^request-outcome-unknown: /)
    expect(handled).toHaveLength(1)
  })
})

async function vi_waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!cond()) throw new Error('condition never became true')
}
