// `PtyManager.putChatDraft` / `takeChatDraft` — carrying a half-typed draft between the ⌘M chat
// composer and Claude's own input box on a flip. The draft MOVES, so the rules are about never
// leaving it in both places and never losing it: type only into an empty box, take only what can be
// read back exactly, and hand a taken draft over only once the box reads empty. The screen reader is
// tested in shared/agents/claude-screen.draft-line.test.ts; this file pins the dispatch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import capture from '../shared/agents/__fixtures__/claude/draft-line-capture.json'

vi.mock('node-pty', () => ({ spawn: () => ({}) }))

const NODE = 'node-1'
const S = capture.screens as Record<string, string>
const DIALOG = S.empty.replace(/\n[^\n]*auto mode on[^\n]*/, '\n Enter to confirm · Esc to cancel')

type Internals = {
  sendTyped: (k: string, t: string, a: string, o?: unknown) => Promise<unknown>
}

async function manager(screens: string[], opts: { typed?: unknown; keysOk?: boolean } = {}) {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager()
  const queue = [...screens]
  // Each capture takes the next screen; the last one repeats.
  const snapshot = vi
    .spyOn(mgr, 'captureSnapshot')
    .mockImplementation(async () => (queue.length > 1 ? queue.shift()! : queue[0]))
  const typed = vi.spyOn(mgr as unknown as Internals, 'sendTyped').mockResolvedValue('typed' in opts ? opts.typed : true)
  const keys = vi
    .spyOn(mgr, 'sendPaneKeys')
    .mockResolvedValue(opts.keysOk === false ? { ok: false, reason: 'failed' } : { ok: true })
  return { mgr, snapshot, typed, keys }
}

beforeEach(() => {
  vi.resetModules()
  initPlatform(fakePlatform())
})
afterEach(() => {
  vi.useRealTimers()
  resetPlatformForTests()
})

describe('PtyManager.putChatDraft (chat → terminal)', () => {
  it('types the draft into an empty box, without the Enter', async () => {
    const { mgr, typed } = await manager([S.empty])

    const result = await mgr.putChatDraft(NODE, 'claude', 'line one\nline two')

    expect(result).toEqual({ put: true })
    expect(typed).toHaveBeenCalledWith(NODE, 'line one\nline two', 'claude', { submit: false })
  })

  it('does not merge into a draft the terminal already has', async () => {
    const { mgr, typed } = await manager([S.line])

    const result = await mgr.putChatDraft(NODE, 'claude', 'from chat')

    expect(result).toEqual({ put: false, reason: 'has-draft' })
    expect(typed).not.toHaveBeenCalled()
  })

  it.each([
    ['a dialog', DIALOG],
    ['an unreadable screen', '']
  ])('types nothing over %s', async (_name, screen) => {
    const { mgr, typed } = await manager([screen])

    const result = await mgr.putChatDraft(NODE, 'claude', 'from chat')

    expect(result).toEqual({ put: false, reason: 'unreadable' })
    expect(typed).not.toHaveBeenCalled()
  })

  it('reports typing it could not confirm, a failed transport and a backend with no typed path', async () => {
    const a = await manager([S.empty], { typed: 'pasted-not-submitted' })
    const b = await manager([S.empty], { typed: false })
    const c = await manager([S.empty], { typed: null })

    const results = [
      await a.mgr.putChatDraft(NODE, 'claude', 'x'),
      await b.mgr.putChatDraft(NODE, 'claude', 'x'),
      await c.mgr.putChatDraft(NODE, 'claude', 'x')
    ]

    expect(results).toEqual([
      { put: false, reason: 'unconfirmed' },
      { put: false, reason: 'failed' },
      { put: false, reason: 'unsupported' }
    ])
  })

  it('refuses an agent whose composer is not measured, without reading the screen', async () => {
    const { mgr, snapshot, typed } = await manager([S.empty])

    const result = await mgr.putChatDraft(NODE, 'codex', 'x')

    expect(result).toEqual({ put: false, reason: 'unsupported' })
    expect(snapshot).not.toHaveBeenCalled()
    expect(typed).not.toHaveBeenCalled()
  })
})

describe('PtyManager.takeChatDraft (terminal → chat)', () => {
  it('takes a one-row draft, clearing the whole row first', async () => {
    const { mgr, keys } = await manager([S.line, S.empty])

    const result = await mgr.takeChatDraft(NODE, 'claude')

    expect(result).toEqual({ taken: true, text: 'fix the  login bug, then run tests' })
    // Ctrl-E first: Ctrl-U alone leaves whatever is right of the cursor.
    expect(keys).toHaveBeenCalledWith(NODE, '\x05\x15')
  })

  it.each([
    ['wrapped', 'multi-line'],
    ['multiline', 'multi-line'],
    ['pasted', 'placeholder'],
    ['shellmode', 'not-prompt']
  ])('leaves a %s draft where it is', async (name, reason) => {
    const { mgr, keys } = await manager([S[name]])

    const result = await mgr.takeChatDraft(NODE, 'claude')

    expect(result).toEqual({ taken: false, reason })
    expect(keys).not.toHaveBeenCalled()
  })

  it('has nothing to take from an empty box or an unreadable screen', async () => {
    const a = await manager([S.empty])
    const b = await manager([''])

    const results = [await a.mgr.takeChatDraft(NODE, 'claude'), await b.mgr.takeChatDraft(NODE, 'claude')]

    expect(results).toEqual([
      { taken: false, reason: 'empty' },
      { taken: false, reason: 'unreadable' }
    ])
    expect(a.keys).not.toHaveBeenCalled()
    expect(b.keys).not.toHaveBeenCalled()
  })

  it('hands nothing over when the box does not read empty after clearing', async () => {
    vi.useFakeTimers()
    const { mgr } = await manager([S.line])

    const pending = mgr.takeChatDraft(NODE, 'claude')
    await vi.advanceTimersByTimeAsync(5000)

    expect(await pending).toEqual({ taken: false, reason: 'not-cleared' })
  })

  it('hands nothing over when the clearing keys could not be sent', async () => {
    const { mgr } = await manager([S.line], { keysOk: false })

    const result = await mgr.takeChatDraft(NODE, 'claude')

    expect(result).toEqual({ taken: false, reason: 'failed' })
  })

  it('refuses an agent whose composer is not measured, without reading the screen', async () => {
    const { mgr, snapshot } = await manager([S.line])

    const result = await mgr.takeChatDraft(NODE, 'codex')

    expect(result).toEqual({ taken: false, reason: 'unsupported' })
    expect(snapshot).not.toHaveBeenCalled()
  })
})
