// `PtyManager.interruptChat` — Esc from the ⌘M chat view. The screen is read before the Esc (a dialog
// would be cancelled by it), and an Esc that beat the reply's first token has its prompt taken back
// out of Claude's input box (MEASURED on Claude Code 2.1.318: Claude puts it back there).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import type { PaneKeysResult } from '../shared/types'

vi.mock('node-pty', () => ({ spawn: () => ({}) }))

const NODE = 'node-1'
const RULE = '─'.repeat(80)
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const screen = (promptLine: string): string => [RULE, promptLine, RULE, '  ? for shortcuts'].join('\n')
const EMPTY = screen('❯ ')
const PLACEHOLDER = screen(`❯ ${DIM}finish the story${RESET}`)
const draft = (text: string): string => screen(`❯ ${text}`)
const TRUST = [RULE, ' Accessing workspace:', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join('\n')

type Private = { captureStyledScreen: (key: string) => Promise<string> }

async function manager(opts: { plain: string; styled?: string[]; keys?: PaneKeysResult }) {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager()
  vi.spyOn(mgr, 'captureSession').mockResolvedValue(opts.plain)
  const styled = [...(opts.styled ?? [])]
  const last = styled.at(-1) ?? EMPTY
  vi.spyOn(mgr as unknown as Private, 'captureStyledScreen').mockImplementation(async () => styled.shift() ?? last)
  const sendPaneKeys = vi.spyOn(mgr, 'sendPaneKeys').mockResolvedValue(opts.keys ?? { ok: true })
  return { mgr, sendPaneKeys }
}

describe('PtyManager.interruptChat', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    initPlatform(fakePlatform())
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  it('sends a lone Esc to a working claude', async () => {
    const { mgr, sendPaneKeys } = await manager({ plain: EMPTY })

    const result = await mgr.interruptChat(NODE, 'claude')

    expect(sendPaneKeys).toHaveBeenCalledTimes(1)
    expect(sendPaneKeys).toHaveBeenCalledWith(NODE, '\x1b')
    expect(result).toEqual({ sent: true, restored: null })
  })

  it('refuses before writing when a dialog owns the screen, and returns its text', async () => {
    const { mgr, sendPaneKeys } = await manager({ plain: TRUST })

    const result = await mgr.interruptChat(NODE, 'claude')

    expect(sendPaneKeys).not.toHaveBeenCalled()
    expect(result).toEqual({ sent: false, reason: 'dialog', dialog: expect.stringContaining('No, exit') })
  })

  it('an empty capture is not evidence of a dialog: the Esc is sent', async () => {
    const { mgr, sendPaneKeys } = await manager({ plain: '' })

    const result = await mgr.interruptChat(NODE, 'claude')

    expect(sendPaneKeys).toHaveBeenCalledWith(NODE, '\x1b')
    expect(result).toEqual({ sent: true, restored: null })
  })

  it('refuses an agent whose interrupt is not measured, without reading or writing', async () => {
    const { mgr, sendPaneKeys } = await manager({ plain: EMPTY })

    const result = await mgr.interruptChat(NODE, 'codex')

    expect(sendPaneKeys).not.toHaveBeenCalled()
    expect(result).toEqual({ sent: false, reason: 'unsupported' })
  })

  it("passes on sendPaneKeys's refusal", async () => {
    const { mgr } = await manager({ plain: EMPTY, keys: { ok: false, reason: 'unsupported-backend' } })

    const result = await mgr.interruptChat(NODE, 'claude', 'hello')

    expect(result).toEqual({ sent: false, reason: 'unsupported-backend' })
  })

  it('takes the interrupted prompt back out of the input box and clears it with Ctrl-U, never Ctrl-C', async () => {
    const { mgr, sendPaneKeys } = await manager({
      plain: EMPTY,
      styled: [EMPTY, draft('Write a story'), draft('Write a story'), PLACEHOLDER]
    })

    const pending = mgr.interruptChat(NODE, 'claude', 'Write a\nstory')
    await vi.runAllTimersAsync()
    const result = await pending

    // Two lines: two Ctrl-Us per line plus two spares (a Ctrl-U on an empty box does nothing).
    expect(sendPaneKeys.mock.calls.map((c) => c[1])).toEqual(['\x1b', '\x15'.repeat(6)])
    expect(result).toEqual({ sent: true, restored: 'Write a\nstory' })
  })

  it("leaves the user's own text in the box alone", async () => {
    const { mgr, sendPaneKeys } = await manager({ plain: EMPTY, styled: [draft('something else')] })

    const pending = mgr.interruptChat(NODE, 'claude', 'Write a story')
    await vi.runAllTimersAsync()
    const result = await pending

    expect(sendPaneKeys.mock.calls.map((c) => c[1])).toEqual(['\x1b'])
    expect(result).toEqual({ sent: true, restored: null })
  })

  it('gives up when nothing comes back into the box (an Esc mid-reply)', async () => {
    const { mgr, sendPaneKeys } = await manager({ plain: EMPTY, styled: [PLACEHOLDER] })

    const pending = mgr.interruptChat(NODE, 'claude', 'Write a story')
    await vi.runAllTimersAsync()
    const result = await pending

    expect(sendPaneKeys.mock.calls.map((c) => c[1])).toEqual(['\x1b'])
    expect(result).toEqual({ sent: true, restored: null })
  })

  it('does not report a restore when the box does not read empty after the Ctrl-C', async () => {
    const { mgr } = await manager({ plain: EMPTY, styled: [draft('Write a story')] })

    const pending = mgr.interruptChat(NODE, 'claude', 'Write a story')
    await vi.runAllTimersAsync()
    const result = await pending

    expect(result).toEqual({ sent: true, restored: null })
  })
})
