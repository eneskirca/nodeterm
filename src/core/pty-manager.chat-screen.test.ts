// `PtyManager.readChatScreen` — the ⌘M chat view's one screen read: the dialog check and the prompt
// Claude suggests next, from a STYLED capture (only styling tells a dim suggestion from typed text).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

vi.mock('node-pty', () => ({ spawn: () => ({}) }))

const NODE = 'node-1'
const RULE = '─'.repeat(80)
const SUGGESTING = [RULE, '\x1b[39m❯ \x1b[2mrun it in the background\x1b[0m', RULE, '  ? for shortcuts'].join('\n')
const TRUST = [RULE, ' Accessing workspace:', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join('\n')

type Private = { captureStyledScreen: (key: string) => Promise<string> }

async function manager(styled: string, plain: string) {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager()
  const captureStyled = vi.spyOn(mgr as unknown as Private, 'captureStyledScreen').mockResolvedValue(styled)
  const captureSession = vi.spyOn(mgr, 'captureSession').mockResolvedValue(plain)
  return { mgr, captureStyled, captureSession }
}

describe('PtyManager.readChatScreen', () => {
  beforeEach(() => {
    vi.resetModules()
    initPlatform(fakePlatform())
  })
  afterEach(() => {
    resetPlatformForTests()
  })

  it("reads Claude's prompt and its suggestion from one styled capture", async () => {
    const { mgr, captureSession } = await manager(SUGGESTING, '')

    const result = await mgr.readChatScreen(NODE, 'claude')

    expect(result).toEqual({ screen: { kind: 'prompt' }, suggestion: 'run it in the background' })
    expect(captureSession).not.toHaveBeenCalled()
  })

  it('still answers the dialog check from the plain capture when no styled one exists', async () => {
    const { mgr } = await manager('', TRUST)

    const result = await mgr.readChatScreen(NODE, 'claude')

    expect(result.screen.kind).toBe('dialog')
    expect(result.suggestion).toBeNull()
  })

  it('reads nothing for an agent without a measured screen reader', async () => {
    const { mgr, captureStyled, captureSession } = await manager(SUGGESTING, SUGGESTING)

    const result = await mgr.readChatScreen(NODE, 'codex')

    expect(result).toEqual({ screen: { kind: 'unknown' }, suggestion: null })
    expect(captureStyled).not.toHaveBeenCalled()
    expect(captureSession).not.toHaveBeenCalled()
  })
})
