import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { submitsSeparately, typesChatInput } from '../shared/agents/config'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

/** Every promisified execFile (runAsync / runWithStdin), in order: the envelope tests read it. */
const execCalls = vi.hoisted(() => [] as string[][])
vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  const execFile = (_f: string, _a: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as ((e: null, r: { stdout: string; stderr: string }) => void) | undefined
    cb?.(null, { stdout: '', stderr: '' })
    return {}
  }
  Object.assign(execFile, {
    [promisify.custom]: (file: string, args: string[]) => {
      execCalls.push([file, ...args])
      const child = { stdin: { on: () => undefined, end: () => undefined } }
      return Object.assign(Promise.resolve({ stdout: '', stderr: '' }), { child })
    }
  })
  return { execFile, execFileSync: (): string => '' }
})
vi.mock('./exec-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-path')>()),
  findExecutableSync: (bin: string) => (bin === 'ssh' ? '/usr/bin/ssh' : null)
}))
vi.mock('./session-host-backend', async () => (await import('./__fixtures__/no-session-host')).noSessionHost())
vi.mock('node-pty', () => ({ spawn: () => ({}) }))

// Review 2026-10-02: cursor ignores an Enter bundled into the same tmux invocation as a bracketed
// paste, and only the rename path split it, so chat sends, phone sends, canvas `write` and trigger
// deliveries to a Cursor node sat unsubmitted. The split now lives in the ONE funnel every one-way
// writer reaches, `PtyManager.sendText`. A full PtyManager rig is out of reach here, so this pins
// the wiring at source level; the behaviour itself was checked live (chat send to a Cursor node).
const src = readFileSync(path.join(__dirname, 'pty-manager.ts'), 'utf8').replace(/\r\n/g, '\n')
const sendText = src.slice(src.indexOf('  async sendText('), src.indexOf('  private async deliverText('))

describe('PtyManager.sendText separate submit', () => {
  it('cursor is the agent that needs it, and the pane learns its agent at create', () => {
    expect(submitsSeparately('cursor')).toBe(true)
    expect(submitsSeparately('claude')).toBe(false)
    expect(src).toMatch(/if \(options\.agentId\) this\.agentByKey\.set\(key, options\.agentId\)/)
  })

  it('pastes without Enter, then sends a bare Enter, on the tmux paths only', () => {
    expect(sendText).toContain('submitsSeparately(capabilityAgentId(')
    expect(sendText).toContain("this.deliverText(persistKey, text, false, live)")
    expect(sendText).toContain("this.deliverText(persistKey, '', true, live)")
    expect(sendText).toContain('!live?.nativeWindowsPane')
    expect(sendText).toContain('!live?.sessionHost')
    // A paste that landed but whose Enter did not is never reported as delivered.
    expect(sendText).toContain("'pasted-not-submitted'")
  })
})

/** The two tmux calls a separate-submit send makes, recorded in order on a real PtyManager. */
interface Internals {
  agentByKey: Map<string, string>
  liveSessionForPersistKey(k: string): unknown
  deliverText(k: string, text: string, enter: boolean): Promise<true | false | 'pasted-not-submitted'>
  sendText(k: string, text: string, opts?: { enter?: boolean }): Promise<unknown>
  sendTyped(k: string, text: string, agentId: string): Promise<unknown>
  sendChatPrompt(k: string, text: string, agentId: string): Promise<unknown>
  captureSession(k: string): Promise<string>
  sendEnvelope(k: string, envelope: string): Promise<boolean>
  sendEnvelopeNow(k: string, envelope: string): Promise<boolean>
  setRelayNodeResolver(r: unknown): void
  tmuxPath: string | null
  sessionByPersistKey(k: string): unknown
}

describe('PtyManager.sendText: overlapping separate-submit sends do not interleave (review 2026-10-03)', () => {
  beforeEach(() => {
    initPlatform(fakePlatform())
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  async function rig(agent: string, paste: (text: string) => true | false = () => true) {
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager() as unknown as Internals
    mgr.agentByKey.set('n1', agent)
    mgr.liveSessionForPersistKey = () => ({})
    const calls: [string, boolean][] = []
    mgr.deliverText = async (_k, text, enter) => {
      calls.push([text, enter])
      return text ? paste(text) : true
    }
    return { mgr, calls }
  }

  it('cursor: paste1, Enter, paste2, Enter', async () => {
    const { mgr, calls } = await rig('cursor')
    const sends = Promise.all([mgr.sendText('n1', 'first'), mgr.sendText('n1', 'second')])
    await vi.advanceTimersByTimeAsync(400)
    expect(await sends).toEqual([true, true])
    expect(calls).toEqual([
      ['first', false],
      ['', true],
      ['second', false],
      ['', true]
    ])
  })

  it('a failed paste keeps its own result and does not stall the next send', async () => {
    const { mgr, calls } = await rig('cursor', (t) => t !== 'first')
    const sends = Promise.all([mgr.sendText('n1', 'first'), mgr.sendText('n1', 'second')])
    await vi.advanceTimersByTimeAsync(400)
    expect(await sends).toEqual([false, true])
    expect(calls).toEqual([
      ['first', false],
      ['second', false],
      ['', true]
    ])
  })

  it('claude keeps its one-shot paste+Enter', async () => {
    const { mgr, calls } = await rig('claude')
    expect(await Promise.all([mgr.sendText('n1', 'first'), mgr.sendText('n1', 'second')])).toEqual([true, true])
    expect(calls).toEqual([
      ['first', true],
      ['second', true]
    ])
  })
})

// b27b3800 sends chat-view prompts as TYPED text, but only for TYPED_INPUT_CAPABLE (claude). Cursor
// keeps the paste, so its chat send must still reach the split: paste, gap, bare Enter. Every write
// into a pane now queues on `serializePaneWrite`, so an envelope cannot land between the two halves.
describe('PtyManager.sendChatPrompt: the typed chat path leaves cursor on the split paste', () => {
  beforeEach(() => {
    initPlatform(fakePlatform())
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  async function rig(agent: string) {
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager() as unknown as Internals
    mgr.agentByKey.set('n1', agent)
    mgr.liveSessionForPersistKey = () => ({})
    mgr.captureSession = async () => ''
    const calls: unknown[][] = []
    mgr.deliverText = async (_k, text, enter) => {
      calls.push([text, enter])
      return true
    }
    mgr.sendTyped = async (_k, text, agentId) => {
      calls.push(['typed', text, agentId])
      return true
    }
    mgr.sendEnvelopeNow = async (_k, envelope) => {
      calls.push(['envelope', envelope])
      return true
    }
    return { mgr, calls }
  }

  it('cursor is not typed: its chat prompt is pasted, then submitted by a separate Enter', async () => {
    expect(typesChatInput('cursor')).toBe(false)
    const { mgr, calls } = await rig('cursor')
    const sent = mgr.sendChatPrompt('n1', 'line one\nline two', 'cursor')
    await vi.advanceTimersByTimeAsync(200)
    expect(await sent).toBe(true)
    expect(calls).toEqual([
      ['line one\nline two', false],
      ['', true]
    ])
  })

  it('claude takes the typed path and never the split', async () => {
    const { mgr, calls } = await rig('claude')
    expect(await mgr.sendChatPrompt('n1', 'hi', 'claude')).toBe(true)
    expect(calls).toEqual([['typed', 'hi', 'claude']])
  })

  it('an envelope arriving mid-split waits until the cursor Enter is sent', async () => {
    const { mgr, calls } = await rig('cursor')
    const both = Promise.all([mgr.sendChatPrompt('n1', 'prompt', 'cursor'), mgr.sendEnvelope('n1', 'env')])
    await vi.advanceTimersByTimeAsync(200)
    expect(await both).toEqual([true, true])
    expect(calls).toEqual([
      ['prompt', false],
      ['', true],
      ['envelope', 'env']
    ])
  })
})

describe('PtyManager forgets a deleted node\'s agent', () => {
  it('drops agentByKey on delete, keeps it across a recycle', () => {
    const end = src.slice(src.indexOf("if (intent === 'delete') {"), src.indexOf('} else this.tombstones.delete(persistKey)'))
    expect(end).toContain('this.agentByKey.delete(persistKey)')
  })
})

// Review merge2: the split keyed on create()'s record alone, so after a restart an unmounted Cursor
// node got the one-shot paste+Enter; agent envelopes never split; and the bare Enter could answer a
// Cursor dialog that opened during the gap.
describe('PtyManager: separate submit after restart, for envelopes, and never into a dialog', () => {
  const PLAN = '  Ready to build?\n  → Yes, build locally (b)\n    No, propose changes (p or Esc)\n'
  const APPROVAL = ' Run this command?\n  → Run (once) (y)\n    Skip (esc or n)\n'
  const QUESTION = ' │ Question 1 of 1 │\n │   › [ ] Red │\n │ Space select · Enter next/submit · Esc to skip │\n └────┘\n'

  beforeEach(() => {
    initPlatform(fakePlatform())
    vi.useFakeTimers()
    execCalls.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  const resolver = (...agents: (string | undefined)[]) => ({
    placements: () => agents.map((agentId, i) => ({ projectId: `p${i}`, node: { agentId } })),
    refFor: () => undefined,
    projectIsRemote: () => false
  })

  async function rig(opts: { create?: string; placed?: (string | undefined)[]; screen?: () => Promise<string> }) {
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager() as unknown as Internals
    if (opts.create) mgr.agentByKey.set('n1', opts.create)
    if (opts.placed) mgr.setRelayNodeResolver(resolver(...opts.placed))
    mgr.liveSessionForPersistKey = () => ({})
    mgr.captureSession = opts.screen ?? (async () => 'idle composer')
    const calls: [string, boolean][] = []
    mgr.deliverText = async (_k, text, enter) => {
      calls.push([text, enter])
      return true
    }
    return { mgr, calls }
  }

  async function send(mgr: Internals): Promise<unknown> {
    const sent = mgr.sendText('n1', 'hi')
    await vi.advanceTimersByTimeAsync(400)
    return sent
  }

  it('no create(), every placement says cursor: sendText splits', async () => {
    const { mgr, calls } = await rig({ placed: ['cursor', 'cursor'] })
    expect(await send(mgr)).toBe(true)
    expect(calls).toEqual([['hi', false], ['', true]])
  })

  it('placements that disagree, or name no agent, keep the one-shot paste+Enter', async () => {
    for (const placed of [['cursor', 'claude'], [undefined], ['cursor', undefined]]) {
      const { mgr, calls } = await rig({ placed })
      expect(await send(mgr)).toBe(true)
      expect(calls).toEqual([['hi', true]])
    }
  })

  /** A clean pane at the pre-paste read, then `dialog` from the post-paste read on. */
  const opensAfterPaste = (dialog: string) => {
    let reads = 0
    return async () => (reads++ === 0 ? 'idle composer' : dialog)
  }

  it('a Cursor dialog that opens after the paste gets no Enter', async () => {
    for (const dialog of [PLAN, APPROVAL, QUESTION]) {
      const { mgr, calls } = await rig({ create: 'cursor', screen: opensAfterPaste(dialog) })
      expect(await send(mgr)).toBe('pasted-not-submitted')
      expect(calls).toEqual([['hi', false]])
    }
  })

  it('a Cursor dialog already on screen gets nothing written at all', async () => {
    for (const dialog of [PLAN, APPROVAL, QUESTION]) {
      const { mgr, calls } = await rig({ create: 'cursor', screen: async () => dialog })
      expect(await send(mgr)).toBe(false)
      expect(calls).toEqual([])
    }
  })

  it('a clean, empty or failed capture still gets the Enter', async () => {
    const screens = [async () => 'idle composer', async () => '', () => Promise.reject(new Error('gone'))]
    for (const screen of screens) {
      const { mgr, calls } = await rig({ create: 'cursor', screen })
      expect(await send(mgr)).toBe(true)
      expect(calls).toEqual([['hi', false], ['', true]])
    }
  })

  /** The paste/Enter shape of each tmux invocation an envelope made, local or over ssh. */
  const shapes = (): string[] =>
    execCalls
      .map((c) => c.join(' '))
      .filter((c) => c.includes('paste-buffer') || c.includes('Enter'))
      .map((c) => (c.includes('paste-buffer') ? (c.includes('Enter') ? 'paste+Enter' : 'paste') : 'Enter'))

  async function envelope(agent: string, ssh: boolean, screen = async () => 'idle composer') {
    const { mgr } = await rig({ create: agent, screen })
    mgr.tmuxPath = '/usr/bin/tmux'
    mgr.sessionByPersistKey = () =>
      ssh ? { sshRemote: { conn: { host: 'box', user: 'me' }, controlPath: '/tmp/cm.sock' } } : {}
    const sent = mgr.sendEnvelope('n1', 'envelope body')
    await vi.advanceTimersByTimeAsync(400)
    const ok = await sent
    return { ok, shapes: shapes(), files: execCalls.map((c) => c[0]) }
  }

  for (const ssh of [false, true]) {
    const leg = ssh ? 'ssh' : 'local'
    it(`${leg}: a cursor envelope is pasted, then submitted by a bare Enter`, async () => {
      const r = await envelope('cursor', ssh)
      expect(r).toMatchObject({ ok: true, shapes: ['paste', 'Enter'] })
      expect(new Set(r.files)).toEqual(new Set([ssh ? '/usr/bin/ssh' : '/usr/bin/tmux']))
    })

    it(`${leg}: a claude envelope keeps its one paste+Enter`, async () => {
      expect(await envelope('claude', ssh)).toMatchObject({ ok: true, shapes: ['paste+Enter'] })
    })

    it(`${leg}: a cursor envelope pasted before a dialog opens gets no Enter, and counts as written`, async () => {
      expect(await envelope('cursor', ssh, opensAfterPaste(PLAN))).toMatchObject({ ok: true, shapes: ['paste'] })
    })

    it(`${leg}: a cursor envelope meeting a dialog writes nothing and answers 'dialog'`, async () => {
      expect(await envelope('cursor', ssh, async () => PLAN)).toEqual({ ok: 'dialog', shapes: [], files: [] })
    })
  }

  it('an empty envelope is still refused before anything is written', async () => {
    const { mgr } = await rig({ create: 'cursor' })
    mgr.tmuxPath = '/usr/bin/tmux'
    expect(await mgr.sendEnvelope('n1', '')).toBe(false)
    expect(execCalls).toEqual([])
  })
})
