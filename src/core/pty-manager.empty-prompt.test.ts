// `PtyManager.sendToEmptyPrompt` — the app's own link notes (issue #1144). A note may only be typed
// into an EMPTY composer: the reporter's draft was merged with the context-link note and the Enter
// submitted both. The composer reader is tested in shared/agents/claude-composer.test.ts; this file
// pins the dispatch: read first, write only on `empty`, and never for an agent we cannot read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import capture from '../shared/agents/__fixtures__/claude/composer-capture.json'

vi.mock('node-pty', () => ({ spawn: () => ({}) }))

const NODE = 'node-1'
const S = capture.screens as Record<string, string>

type Internals = { sendTextNow: (k: string, t: string, o?: unknown) => Promise<unknown> }

async function manager(screen: string, delivered: boolean | 'pasted-not-submitted' = true) {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager()
  const snapshot = vi.spyOn(mgr, 'captureSnapshot').mockResolvedValue(screen)
  const now = vi.spyOn(mgr as unknown as Internals, 'sendTextNow').mockResolvedValue(delivered)
  return { mgr, snapshot, now }
}

describe('PtyManager.sendToEmptyPrompt (#1144)', () => {
  beforeEach(() => {
    vi.resetModules()
    initPlatform(fakePlatform())
  })
  afterEach(() => {
    resetPlatformForTests()
  })

  it('types the note into an empty claude composer', async () => {
    const { mgr, now } = await manager(S.empty)
    expect(await mgr.sendToEmptyPrompt(NODE, 'note', 'claude')).toEqual({ sent: true })
    expect(now).toHaveBeenCalledWith(NODE, 'note', { typedFor: 'claude' })
  })

  it.each([
    ['draft', 'draft'],
    ['multiline', 'draft'],
    ['pasted', 'draft'],
    ['shellmode', 'draft']
  ])('writes nothing over a %s composer', async (name, reason) => {
    const { mgr, now } = await manager(S[name])
    expect(await mgr.sendToEmptyPrompt(NODE, 'note', 'claude')).toEqual({ sent: false, reason })
    expect(now).not.toHaveBeenCalled()
  })

  it('an unreadable screen is NOT evidence of emptiness (unlike the chat send)', async () => {
    const { mgr, now } = await manager('')
    expect(await mgr.sendToEmptyPrompt(NODE, 'note', 'claude')).toEqual({ sent: false, reason: 'unknown' })
    expect(now).not.toHaveBeenCalled()
  })

  it('a dialog owns the keyboard: nothing is written (its Enter would answer it)', async () => {
    const dialog = S.empty.replace(/\n[^\n]*manual mode on[^\n]*/, '\n Enter to confirm · Esc to cancel')
    const { mgr, now } = await manager(dialog)
    expect(await mgr.sendToEmptyPrompt(NODE, 'note', 'claude')).toEqual({ sent: false, reason: 'no-prompt' })
    expect(now).not.toHaveBeenCalled()
  })

  it('an agent without a measured composer reader is refused without a capture', async () => {
    const { mgr, snapshot, now } = await manager(S.empty)
    expect(await mgr.sendToEmptyPrompt(NODE, 'note', 'codex')).toEqual({ sent: false, reason: 'unsupported' })
    expect(snapshot).not.toHaveBeenCalled()
    expect(now).not.toHaveBeenCalled()
  })

  it('reports an Enter that was withheld, and a failed transport, as not sent', async () => {
    const a = await manager(S.empty, 'pasted-not-submitted')
    expect(await a.mgr.sendToEmptyPrompt(NODE, 'note', 'claude')).toEqual({ sent: false, reason: 'not-submitted' })
    const b = await manager(S.empty, false)
    expect(await b.mgr.sendToEmptyPrompt(NODE, 'note', 'claude')).toEqual({ sent: false, reason: 'failed' })
  })

  it('reads and writes inside the pane write chain: a write already in flight finishes first', async () => {
    const { mgr, snapshot } = await manager(S.empty)
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    ;(vi.mocked((mgr as unknown as Internals).sendTextNow)).mockImplementation(async (_k: string, t: string) => {
      order.push(`write ${t}`)
      if (t === 'slow') await gate
      return true
    })
    snapshot.mockImplementation(async () => {
      order.push('capture')
      return S.empty
    })
    const first = mgr.sendText(NODE, 'slow')
    const note = mgr.sendToEmptyPrompt(NODE, 'note', 'claude')
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['write slow'])
    release()
    await Promise.all([first, note])
    expect(order).toEqual(['write slow', 'capture', 'write note'])
  })
})
