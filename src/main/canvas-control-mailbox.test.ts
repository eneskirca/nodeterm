import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildCanvasControlInstructions,
  buildCanvasSkillBody,
  CONTROL_SHIM_SCRIPT,
  parseControlRequest
} from '../core/canvas-control-core'

const ack = {
  message: 'mail-a', state: 'accepted', revision: '2', note: 'Included in plan', 'request-id': 'take-a'
}
const complete = {
  message: 'mail-a', outcome: 'done', revision: '3', claim: 'claim-a', note: 'Verified result', 'request-id': 'finish-a'
}

describe('mailbox CLI shapes', () => {
  it('lists the authenticated caller’s boxes without naming another node', () => {
    for (const verb of ['inbox', 'outbox']) {
      expect(parseControlRequest(verb, {})).toEqual({ verb, args: {} })
      const args = { state: 'all', limit: '20', cursor: 'opaque:next', json: '' }
      expect(parseControlRequest(verb, args)).toEqual({ verb, args })
      expect(parseControlRequest(verb, { node: 'victim' })).toHaveProperty('error')
      for (const limit of ['0', '-1', '1.5', '2e2', '9007199254740993', '']) {
        expect(parseControlRequest(verb, { limit })).toHaveProperty('error')
      }
      expect(parseControlRequest(verb, { state: 'completed' })).toHaveProperty('error')
    }
  })

  it('read is a distinct, read-only command with no status/identity overrides', () => {
    expect(parseControlRequest('read', { message: 'mail-a', json: '' })).toEqual({
      verb: 'read', args: { message: 'mail-a', json: '' }
    })
    const invalid: Record<string, string>[] = [{}, { message: '' }, { message: 'mail-a', state: 'accepted' }, { message: 'mail-a', from: 'victim' }]
    for (const args of invalid) {
      expect(parseControlRequest('read', args)).toHaveProperty('error')
    }
  })

  it('requires revision and an idempotency key for explicit takeover/blocking', () => {
    expect(parseControlRequest('ack', ack)).toEqual({ verb: 'ack', args: ack })
    expect(parseControlRequest('ack', { ...ack, state: 'blocked' })).toHaveProperty('verb', 'ack')
    for (const key of ['message', 'state', 'revision', 'note', 'request-id']) {
      expect(parseControlRequest('ack', { ...ack, [key]: '' }), key).toHaveProperty('error')
    }
    expect(parseControlRequest('ack', { ...ack, state: 'completed' })).toHaveProperty('error')
    expect(parseControlRequest('ack', { ...ack, 'request-id': 'bad key' })).toHaveProperty('error')
  })

  it('completion requires the latest claim and never treats a blocker as done', () => {
    expect(parseControlRequest('complete', complete)).toEqual({ verb: 'complete', args: complete })
    expect(parseControlRequest('complete', { ...complete, outcome: 'rejected' })).toHaveProperty('verb', 'complete')
    for (const key of ['message', 'revision', 'claim', 'note', 'request-id', 'outcome']) {
      expect(parseControlRequest('complete', { ...complete, [key]: '' }), key).toHaveProperty('error')
    }
    expect(parseControlRequest('complete', { ...complete, outcome: 'blocked' })).toHaveProperty('error')
  })

  it('legacy send/reply shapes remain valid, with additive mail references', () => {
    for (const verb of ['send', 'reply']) {
      const cases: Record<string, string>[] = [{ node: 'target', text: 'hello' }, { node: 'target', text: 'hello', 'request-id': 'send-a', 'in-reply-to': 'mail-a' }]
      for (const args of cases) {
        expect(parseControlRequest(verb, args)).toEqual({ verb, args })
      }
    }
  })
})

describe('generated mailbox instructions', () => {
  it('uses the actual installed shim in both bodies, including Windows invocation', () => {
    const shim = '/isolated profile/canvas-control/nodeterm.sh'
    for (const body of [buildCanvasControlInstructions(shim), buildCanvasSkillBody(shim)]) {
      expect(body).toContain(`sh "${shim}" inbox --state open --limit 50 --json`)
      expect(body).toContain('At the beginning of every turn and before reporting completion')
      expect(body).toContain('opening a message never acknowledges it')
      expect(body).toContain('NEVER proves semantic processing')
      expect(body).toContain('claimId returned by ack')
      expect(body).toContain('An expired delivery attempt does not remove durable mail')
      expect(body).not.toContain('/tmp/nodeterm-start-check-')
    }
    expect(buildCanvasSkillBody('C:\\profile\\canvas-control\\nodeterm.sh', 'windows-cmd'))
      .toContain('nodeterm.cmd')
  })
})

// No real endpoint or profile: the REAL generated shell posts only to this argv-recording fake.
describe('mailbox wire flags through the generated shell', () => {
  let dir = ''
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-cli-'))
    fs.mkdirSync(path.join(dir, 'bin'))
    fs.writeFileSync(path.join(dir, 'shim.sh'), CONTROL_SHIM_SCRIPT)
    fs.writeFileSync(path.join(dir, 'bin', 'curl'), '#!/bin/sh\ncat >/dev/null\nfor a in "$@"; do printf "%s\\000" "$a"; done > "$NT_MAIL_LOG"\nprintf 200\n', { mode: 0o755 })
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  const run = (args: string[], socket: boolean): string[] => {
    execFileSync('sh', [path.join(dir, 'shim.sh'), ...args], {
      env: {
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
        NODETERM_CANVAS_CONTROL: '1', NODETERM_NODE_ID: 'test-node',
        ...(socket ? { NODETERM_HOOK_SOCK: path.join(dir, 'fake.sock') } : { NODETERM_HOOK_PORT: '1' }),
        NT_MAIL_LOG: path.join(dir, 'argv')
      }
    })
    return fs.readFileSync(path.join(dir, 'argv'), 'utf8').split('\0')
  }

  it.each([false, true])('--json negotiates JSON on TCP/socket=%s and preserves mutation data', (socket) => {
    const note = 'Unicode: übernommen\n$(touch NEVER) `literal`'
    const argv = run(['ack', '--message', 'mail-a', '--state', 'accepted', '--revision', '2', '--note', note, '--request-id', 'take-a', '--json'], socket)
    expect(argv).toContain('Accept: application/json')
    for (const field of ['arg.message=mail-a', 'arg.state=accepted', 'arg.revision=2', `arg.note=${note}`, 'arg.request-id=take-a', 'arg.json=']) expect(argv).toContain(field)
    expect(fs.existsSync(path.join(dir, 'NEVER'))).toBe(false)
    expect(run(['inbox'], socket)).toContain('Accept: text/plain')
  })
})
