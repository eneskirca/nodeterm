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
/** An input box showing `rows` as wrapped rows, the way Claude draws a long draft. */
const rows = (shown: string[]): string =>
  [RULE, `❯ ${shown[0]}`, ...shown.slice(1).map((r) => `  ${r}`), RULE, '  ? for shortcuts'].join('\n')
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

  it('clears a long single line wrapped onto several rows: two Ctrl-Us per row on screen', async () => {
    const wrapped = ['w1 w2 w3', 'w4 w5 w6', 'w7 w8 w9', 'w10 w11', 'w12 w13', 'w14 w15']
    const sent = wrapped.join(' ')
    const { mgr, sendPaneKeys } = await manager({ plain: EMPTY, styled: [EMPTY, rows(wrapped), PLACEHOLDER] })

    const pending = mgr.interruptChat(NODE, 'claude', sent)
    await vi.runAllTimersAsync()
    const result = await pending

    // One line sent, six rows on screen: Ctrl-U clears a visual row (MEASURED, 2.1.319).
    expect(sendPaneKeys.mock.calls.map((c) => c[1])).toEqual(['\x1b', '\x15'.repeat(14)])
    expect(result).toEqual({ sent: true, restored: sent })
  })

  it('takes back a prompt taller than the box, which shows only its end, in rounds', async () => {
    const sent = 'a1 a2 a3 a4 b1 b2 b3 b4 c1 c2 c3 c4'
    const { mgr, sendPaneKeys } = await manager({
      plain: EMPTY,
      styled: [EMPTY, rows(['c1 c2', 'c3 c4']), rows(['a3 a4', 'b1 b2']), rows(['a1 a2']), PLACEHOLDER]
    })

    const pending = mgr.interruptChat(NODE, 'claude', sent)
    await vi.runAllTimersAsync()
    const result = await pending

    expect(sendPaneKeys.mock.calls.map((c) => c[1])).toEqual(['\x1b', '\x15'.repeat(6), '\x15'.repeat(6), '\x15'.repeat(4)])
    expect(result).toEqual({ sent: true, restored: sent })
  })

  it('stops clearing when what is left is not part of what was sent', async () => {
    const sent = 'a1 a2 a3 a4 b1 b2'
    const { mgr, sendPaneKeys } = await manager({
      plain: EMPTY,
      styled: [EMPTY, rows(['b1 b2']), rows(['typed meanwhile'])]
    })

    const pending = mgr.interruptChat(NODE, 'claude', sent)
    await vi.runAllTimersAsync()
    const result = await pending

    expect(sendPaneKeys.mock.calls.map((c) => c[1])).toEqual(['\x1b', '\x15'.repeat(4)])
    expect(result).toEqual({ sent: true, restored: null })
  })

  it('stops when a burst leaves the box as it was, even for text that repeats', async () => {
    const { mgr, sendPaneKeys } = await manager({ plain: EMPTY, styled: [EMPTY, draft('ok ok')] })

    const pending = mgr.interruptChat(NODE, 'claude', 'ok ok ok ok')
    await vi.runAllTimersAsync()
    const result = await pending

    expect(sendPaneKeys.mock.calls.map((c) => c[1])).toEqual(['\x1b', '\x15'.repeat(4)])
    expect(result).toEqual({ sent: true, restored: null })
  })

  it('does not take back text that is only the START of what was sent', async () => {
    const { mgr, sendPaneKeys } = await manager({ plain: EMPTY, styled: [draft('Write a')] })

    const pending = mgr.interruptChat(NODE, 'claude', 'Write a story')
    await vi.runAllTimersAsync()
    const result = await pending

    expect(sendPaneKeys.mock.calls.map((c) => c[1])).toEqual(['\x1b'])
    expect(result).toEqual({ sent: true, restored: null })
  })
})

describe('endsEarlierIn', () => {
  it('finds where the text ends, before the limit', async () => {
    const { endsEarlierIn } = await import('./pty-manager')

    expect(endsEarlierIn('a1a2b1b2c1c2', 'b1b2', 12)).toBe(8)
  })

  it('takes the latest place before the limit when the text repeats', async () => {
    const { endsEarlierIn } = await import('./pty-manager')

    expect(endsEarlierIn('abab', 'ab', 4)).toBe(2)
    expect(endsEarlierIn('abab', 'ab', 2)).toBeNull()
  })

  it('is null for text that is not in it, or would not end earlier', async () => {
    const { endsEarlierIn } = await import('./pty-manager')

    expect(endsEarlierIn('a1a2b1b2', 'zz', 8)).toBeNull()
    expect(endsEarlierIn('a1a2b1b2', 'a1a2b1b2', 8)).toBeNull()
  })
})
