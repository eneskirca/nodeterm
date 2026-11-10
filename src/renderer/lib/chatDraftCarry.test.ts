// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatDraftPutResult, ChatDraftTakeResult } from '@shared/text-delivery'
import { useChatDraft } from '../state/chatDraft'
import { CARRY_TO_TERMINAL_WAIT_MS, carryDraftToChat, carryDraftToTerminal, type DraftCarryPty } from './chatDraftCarry'

const NODE = 'n1'
const draft = () => useChatDraft.getState().drafts[NODE] ?? ''
const note = () => useChatDraft.getState().notes[NODE] ?? null

function pty(put: Promise<ChatDraftPutResult> | ChatDraftPutResult, take: ChatDraftTakeResult = { taken: false, reason: 'empty' }) {
  return {
    putChatDraft: vi.fn<DraftCarryPty['putChatDraft']>(async () => put),
    takeChatDraft: vi.fn<DraftCarryPty['takeChatDraft']>(async () => take)
  }
}

let toasts: string[]
const onToast = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail.message)

beforeEach(() => {
  useChatDraft.setState({ drafts: {}, notes: {} })
  toasts = []
  window.addEventListener('nodeterm:toast', onToast)
})
afterEach(() => {
  window.removeEventListener('nodeterm:toast', onToast)
  vi.useRealTimers()
})

describe('carryDraftToTerminal', () => {
  it('moves the chat draft: typed into the terminal, then emptied here', async () => {
    useChatDraft.getState().setDraft(NODE, 'half a thought')
    const p = pty({ put: true })

    await carryDraftToTerminal(p, NODE, 'claude')

    expect(p.putChatDraft).toHaveBeenCalledWith(NODE, 'claude', 'half a thought')
    expect(draft()).toBe('')
  })

  it('keeps the chat draft, and says why, when the terminal already has one', async () => {
    useChatDraft.getState().setDraft(NODE, 'half a thought')

    await carryDraftToTerminal(pty({ put: false, reason: 'has-draft' }), NODE, 'claude')

    expect(draft()).toBe('half a thought')
    expect(toasts).toEqual([expect.stringMatching(/terminal already has a draft/)])
  })

  it('does nothing with an empty draft, or for an agent it cannot carry for', async () => {
    const a = pty({ put: true })
    useChatDraft.getState().setDraft(NODE, 'x')
    const b = pty({ put: true })

    useChatDraft.setState({ drafts: {} })
    await carryDraftToTerminal(a, NODE, 'claude')
    useChatDraft.getState().setDraft(NODE, 'x')
    await carryDraftToTerminal(b, NODE, 'codex')

    expect(a.putChatDraft).not.toHaveBeenCalled()
    expect(b.putChatDraft).not.toHaveBeenCalled()
    expect(draft()).toBe('x')
  })

  it('stops waiting after its limit, and still empties the draft when the typing lands', async () => {
    vi.useFakeTimers()
    useChatDraft.getState().setDraft(NODE, 'slow')
    let land: (r: ChatDraftPutResult) => void = () => {}
    const p = pty(new Promise<ChatDraftPutResult>((r) => (land = r)))

    const flip = carryDraftToTerminal(p, NODE, 'claude')
    await vi.advanceTimersByTimeAsync(CARRY_TO_TERMINAL_WAIT_MS)
    await flip
    const beforeLanding = draft()
    land({ put: true })
    await vi.advanceTimersByTimeAsync(0)

    expect(beforeLanding).toBe('slow')
    expect(draft()).toBe('')
  })

  it('leaves a draft the user changed while it was typed', async () => {
    useChatDraft.getState().setDraft(NODE, 'first')
    let land: (r: ChatDraftPutResult) => void = () => {}
    const p = pty(new Promise<ChatDraftPutResult>((r) => (land = r)))

    const flip = carryDraftToTerminal(p, NODE, 'claude')
    useChatDraft.getState().setDraft(NODE, 'first, and more')
    land({ put: true })
    await flip

    expect(draft()).toBe('first, and more')
  })
})

describe('carryDraftToChat', () => {
  it('fills the empty composer with the terminal draft', async () => {
    const p = pty({ put: true }, { taken: true, text: 'from the terminal' })

    await carryDraftToChat(p, NODE, 'claude')

    expect(draft()).toBe('from the terminal')
  })

  it('takes nothing when the chat composer already has a draft', async () => {
    useChatDraft.getState().setDraft(NODE, 'chat draft')
    const p = pty({ put: true }, { taken: true, text: 'terminal draft' })

    await carryDraftToChat(p, NODE, 'claude')

    expect(p.takeChatDraft).not.toHaveBeenCalled()
    expect(draft()).toBe('chat draft')
  })

  it('says why a terminal draft stayed in the terminal', async () => {
    await carryDraftToChat(pty({ put: true }, { taken: false, reason: 'multi-line' }), NODE, 'claude')

    expect(note()).toBe(
      "Multiline draft messages can't be copied from the terminal to chat view. Your draft is still available in the terminal."
    )
  })

  it('says nothing when there was nothing to take', async () => {
    await carryDraftToChat(pty({ put: true }, { taken: false, reason: 'empty' }), NODE, 'claude')

    expect(note()).toBeNull()
  })

  it('puts the taken draft first when the user typed in the composer meanwhile', async () => {
    let land: (r: ChatDraftTakeResult) => void = () => {}
    const p = pty({ put: true })
    p.takeChatDraft.mockImplementation(() => new Promise<ChatDraftTakeResult>((r) => (land = r)))

    const carry = carryDraftToChat(p, NODE, 'claude')
    useChatDraft.getState().setDraft(NODE, 'typed meanwhile')
    land({ taken: true, text: 'from the terminal' })
    await carry

    expect(draft()).toBe('from the terminal\ntyped meanwhile')
  })

  it('clears the note once the draft is edited', async () => {
    await carryDraftToChat(pty({ put: true }, { taken: false, reason: 'placeholder' }), NODE, 'claude')

    useChatDraft.getState().setDraft(NODE, 'x')

    expect(note()).toBeNull()
  })
})

describe('a pty method that throws instead of rejecting', () => {
  const throwing = () => {
    throw new Error('not a function')
  }

  it('leaves the chat draft in place on the way to the terminal', async () => {
    useChatDraft.getState().setDraft(NODE, 'half a thought')
    const p = pty({ put: true })
    p.putChatDraft.mockImplementation(throwing)

    await expect(carryDraftToTerminal(p, NODE, 'claude')).resolves.toBeUndefined()

    expect(draft()).toBe('half a thought')
  })

  it('leaves the composer empty on the way to chat', async () => {
    const p = pty({ put: true })
    p.takeChatDraft.mockImplementation(throwing)

    await expect(carryDraftToChat(p, NODE, 'claude')).resolves.toBeUndefined()

    expect(draft()).toBe('')
  })
})
