// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatTranscriptResult } from '@shared/types'
import type { AnswerPermissionPayload, ChatQuestion, HeldPermission } from '@shared/agents/permission-answer'
import { useAgentStatus } from '../state/agentStatus'

/**
 * Answer controls on the ⌘M Plan / Question card (pure mapping: `lib/chatAnswer.test.ts`). Pins the
 * glue: controls only on the card the held ticket belongs to, the structured answer handed to
 * `answerPermission`, "Sent" on success, a quiet retryable error on refusal, and the composer copy.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { session, answerPermission, reads } = vi.hoisted(() => {
  const reads: { messages: unknown[] } = { messages: [] }
  const answerPermission = vi.fn(async (_p: unknown) => true)
  const session = {
    api: {
      chat: {
        readTranscript: async () => ({ messages: reads.messages, found: true, olderCursor: null, unmatchedResults: [] })
      },
      pty: { sendText: vi.fn(async () => true as const) },
      answerPermission
    }
  }
  return { session, answerPermission, reads }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'

const NODE = 'n-chat-answers'
let host: HTMLDivElement
let root: Root

const SINGLE: ChatQuestion = {
  question: 'Pick one?',
  multiSelect: false,
  options: [{ label: 'A', description: 'first' }, { label: 'B' }]
}
const MULTI: ChatQuestion = { question: 'Which surfaces?', multiSelect: true, options: [{ label: 'Desktop' }, { label: 'Server' }] }

const planMsg = (key: number, result?: string): ChatMessage => ({
  role: 'assistant',
  key,
  parts: [{ kind: 'tool', name: 'ExitPlanMode', arg: '', body: `# Plan ${key}`, ...(result ? { result } : {}) }]
})
const askMsg = (key: number, questions: ChatQuestion[], result?: string): ChatMessage => ({
  role: 'assistant',
  key,
  parts: [{ kind: 'tool', name: 'AskUserQuestion', arg: '', body: 'questions', questions, ...(result ? { result } : {}) }]
})

async function hold(state: 'blocked' | 'waiting', held: HeldPermission | undefined): Promise<void> {
  await act(async () => {
    useAgentStatus.getState().setState(NODE, state, 'claude', false, held?.pendingId, true, false, held)
  })
}
async function mount(messages: ChatMessage[]): Promise<void> {
  reads.messages = messages
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId="s1" agentId="claude" />)
  })
}
const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.term-chat__tool-card')]
const button = (scope: ParentNode, text: string): HTMLButtonElement =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.click()
  })
}
const type = async (el: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const sent = (): AnswerPermissionPayload => answerPermission.mock.calls.at(-1)![0] as AnswerPermissionPayload
/** Unavailable controls are aria-disabled (they keep keyboard focus), never `disabled`. */
const off = (b: HTMLButtonElement): boolean => b.disabled || b.getAttribute('aria-disabled') === 'true'
const statusText = (): string => host.querySelector('.term-chat__answer-status')?.textContent ?? ''

beforeEach(() => {
  answerPermission.mockReset()
  answerPermission.mockResolvedValue(true)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useAgentStatus.setState((s) => {
    const byId = { ...s.byId }
    delete byId[NODE]
    return { byId }
  })
})

describe('plan card', () => {
  const HELD = { pendingId: 'n-p-1', toolName: 'ExitPlanMode' }

  it('the held plan card gets the approve buttons; each sends its mode', async () => {
    await hold('blocked', HELD)
    await mount([planMsg(0)])
    const card = cards()[0]
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Approve · previous mode',
      'Approve · accept edits',
      'Approve · ask before edits',
      'Revise…'
    ])
    await click(button(card, 'Approve · accept edits'))
    expect(sent()).toEqual({ nodeId: NODE, pendingId: 'n-p-1', answer: { kind: 'plan', mode: 'acceptEdits' } })
    expect(statusText()).toBe('Sent — waiting for Claude Code…')
    // Sent: the controls lock, so a second click cannot send a second answer…
    expect(off(button(card, 'Approve · previous mode'))).toBe(true)
    await click(button(card, 'Approve · previous mode'))
    expect(answerPermission).toHaveBeenCalledTimes(1)
    // …and they stay FOCUSABLE (aria-disabled, not disabled), so keyboard focus is not dropped to <body>.
    expect(button(card, 'Approve · accept edits').disabled).toBe(false)
  })

  it('"Revise…" opens a feedback box; Send feedback sends plan-revise', async () => {
    await hold('blocked', HELD)
    await mount([planMsg(0)])
    await click(button(cards()[0], 'Revise…'))
    const ta = cards()[0].querySelector('textarea') as HTMLTextAreaElement
    expect(off(button(cards()[0], 'Send feedback'))).toBe(true) // nothing typed yet
    await type(ta, '  split step 2  ')
    await click(button(cards()[0], 'Send feedback'))
    expect(sent().answer).toEqual({ kind: 'plan-revise', message: 'split step 2' })
  })

  it('a refusal shows a quiet error pointing at the terminal and keeps the buttons usable', async () => {
    answerPermission.mockResolvedValueOnce(false)
    await hold('blocked', HELD)
    await mount([planMsg(0)])
    await click(button(cards()[0], 'Approve · previous mode'))
    expect(statusText()).toMatch(/^Couldn't send — answer in the terminal/)
    expect(statusText()).not.toContain('Sent')
    expect(off(button(cards()[0], 'Approve · previous mode'))).toBe(false)
    // Retry works.
    await click(button(cards()[0], 'Approve · previous mode'))
    expect(answerPermission).toHaveBeenCalledTimes(2)
    expect(statusText()).toBe('Sent — waiting for Claude Code…')
  })

  it('a hold that ended while the user was choosing is not answered (read as a refusal)', async () => {
    await hold('blocked', HELD)
    await mount([planMsg(0)])
    const approve = button(cards()[0], 'Approve · previous mode')
    // Replaced in the store under the rendered card, without a re-render having happened yet.
    useAgentStatus.getState().byId[NODE]!.held = { pendingId: 'n-p-2', toolName: 'ExitPlanMode' }
    await click(approve)
    expect(answerPermission).not.toHaveBeenCalled()
    expect(statusText()).toMatch(/^Couldn't send/)
  })

  it('an older plan card stays read-only; only the newest unanswered one gets controls', async () => {
    await hold('blocked', HELD)
    await mount([planMsg(0, 'User rejected'), planMsg(10)])
    expect(cards()[0].querySelector('.term-chat__answer')).toBeNull()
    expect(cards()[1].querySelector('.term-chat__answer')).not.toBeNull()
  })

  it('no controls without a held ticket (old hook script), or once the node is working again', async () => {
    await hold('blocked', undefined)
    await mount([planMsg(0)])
    expect(host.querySelector('.term-chat__answer')).toBeNull()
    await hold('blocked', HELD)
    expect(host.querySelector('.term-chat__answer')).not.toBeNull()
    await act(async () => {
      useAgentStatus.getState().setState(NODE, 'working', 'claude')
    })
    expect(host.querySelector('.term-chat__answer')).toBeNull()
  })

  it('the composer points at the card while controls are up, at the terminal otherwise', async () => {
    await hold('blocked', HELD)
    await mount([planMsg(0)])
    const ta = host.querySelector('.term-chat__compose textarea') as HTMLTextAreaElement
    expect(ta.placeholder).toContain('answer on the card above')
    // The status row at the end says the same.
    expect(host.querySelector('.term-chat__activity')?.textContent).toContain('answer on the card above')
    await hold('blocked', undefined)
    await act(async () => {
      useAgentStatus.getState().setState(NODE, 'blocked', 'claude', false, 'n-p-9', true, false, { pendingId: 'n-p-9', toolName: 'Bash' })
    })
    expect(ta.placeholder).toContain('waiting for an answer in the terminal')
  })
})

describe('question card', () => {
  const held = (questions: string[]): HeldPermission => ({ pendingId: 'n-q-1', toolName: 'AskUserQuestion', questions })
  const radio = (label: string): HTMLInputElement =>
    [...host.querySelectorAll<HTMLLabelElement>('.term-chat__answer-option')]
      .find((l) => l.querySelector('span')?.textContent === label)!
      .querySelector('input') as HTMLInputElement

  it('single choice: radio options, Submit sends the label', async () => {
    await hold('waiting', held(['Pick one?']))
    await mount([askMsg(0, [SINGLE])])
    expect(radio('A').type).toBe('radio')
    const submit = button(cards()[0], 'Submit')
    expect(off(submit)).toBe(true)
    await click(radio('B'))
    expect(off(submit)).toBe(false)
    await click(submit)
    expect(sent()).toEqual({
      nodeId: NODE,
      pendingId: 'n-q-1',
      answer: { kind: 'question', answers: { 'Pick one?': 'B' } }
    })
  })

  it('multi choice: checkboxes, labels sent in option order', async () => {
    await hold('waiting', held(['Which surfaces?']))
    await mount([askMsg(0, [MULTI])])
    expect(radio('Desktop').type).toBe('checkbox')
    await click(radio('Server'))
    await click(radio('Desktop'))
    await click(button(cards()[0], 'Submit'))
    expect(sent().answer).toEqual({ kind: 'question', answers: { 'Which surfaces?': ['Desktop', 'Server'] } })
  })

  it('"Other": typing picks it and sends free text', async () => {
    await hold('waiting', held(['Pick one?']))
    await mount([askMsg(0, [SINGLE])])
    await click(radio('A'))
    await type(host.querySelector('.term-chat__answer-text') as HTMLInputElement, 'neither')
    expect(radio('Other').checked).toBe(true)
    expect(radio('A').checked).toBe(false)
    await click(button(cards()[0], 'Submit'))
    expect(sent().answer).toEqual({ kind: 'question', answers: { 'Pick one?': 'neither' }, freeText: ['Pick one?'] })
  })

  it('"Chat about this" declines the question without picking anything — available at once', async () => {
    await hold('waiting', held(['Pick one?']))
    await mount([askMsg(0, [SINGLE])])
    const chat = button(cards()[0], 'Chat about this')
    expect(off(chat)).toBe(false)

    await click(chat)

    expect(sent()).toEqual({ nodeId: NODE, pendingId: 'n-q-1', answer: { kind: 'question-clarify' } })
  })

  it('several questions: Submit waits for all of them', async () => {
    await hold('waiting', held(['Pick one?', 'Which surfaces?']))
    await mount([askMsg(0, [SINGLE, MULTI])])
    await click(radio('A'))
    expect(off(button(cards()[0], 'Submit'))).toBe(true)
    await click(radio('Server'))
    await click(button(cards()[0], 'Submit'))
    expect(sent().answer).toEqual({ kind: 'question', answers: { 'Pick one?': 'A', 'Which surfaces?': ['Server'] } })
  })

  it('multi choice + "Other": ticked labels and the typed text go as ONE free-text answer', async () => {
    await hold('waiting', held(['Which surfaces?']))
    await mount([askMsg(0, [MULTI])])
    expect(radio('Other').type).toBe('checkbox')
    await click(radio('Server'))
    await type(host.querySelector('.term-chat__answer-text') as HTMLInputElement, 'Watch')
    expect(radio('Other').checked).toBe(true)
    expect(radio('Server').checked).toBe(true) // a multi choice keeps its ticks
    await click(button(cards()[0], 'Submit'))
    expect(sent().answer).toEqual({
      kind: 'question',
      answers: { 'Which surfaces?': 'Server, Watch' },
      freeText: ['Which surfaces?']
    })
  })

  it('multi choice + "Other" whose JOINED answer is over the cap: Submit is off and says why', async () => {
    const { CHAT_ANSWER_TEXT_MAX } = await import('../lib/chatAnswer')
    await hold('waiting', held(['Which surfaces?']))
    await mount([askMsg(0, [MULTI])])
    await click(radio('Desktop'))
    await click(radio('Server'))
    // The typed part alone fits the field's own maxLength; with the labels it does not.
    await type(host.querySelector('.term-chat__answer-text') as HTMLInputElement, 'x'.repeat(CHAT_ANSWER_TEXT_MAX - 5))
    expect(off(button(cards()[0], 'Submit'))).toBe(true)
    expect(host.querySelector('.term-chat__answer-hint')?.textContent).toContain('too long')
    await click(button(cards()[0], 'Submit'))
    expect(answerPermission).not.toHaveBeenCalled()
  })

  it('a question with no options is answered by its text field alone', async () => {
    const FREE: ChatQuestion = { question: 'Name?', multiSelect: false, options: [] }
    await hold('waiting', held(['Name?']))
    await mount([askMsg(0, [FREE])])
    expect(host.querySelectorAll('.term-chat__answer-option')).toHaveLength(0) // no radios, no "Other"
    const field = host.querySelector('.term-chat__answer-text') as HTMLInputElement
    expect(field.getAttribute('aria-label')).toBe('Your answer: Name?')
    expect(off(button(cards()[0], 'Submit'))).toBe(true)
    await type(field, ' Ada ')
    await click(button(cards()[0], 'Submit'))
    expect(sent().answer).toEqual({ kind: 'question', answers: { 'Name?': 'Ada' }, freeText: ['Name?'] })
  })

  it('a card whose questions do not match the held request stays read-only', async () => {
    await hold('waiting', held(['Something else?']))
    await mount([askMsg(0, [SINGLE])])
    expect(host.querySelector('.term-chat__answer')).toBeNull()
    expect(host.querySelector('.term-chat__compose textarea')!.getAttribute('placeholder')).toContain(
      'waiting for an answer in the terminal'
    )
  })

  it('an answered question card stays read-only and shows its result', async () => {
    await hold('waiting', held(['Pick one?']))
    await mount([askMsg(0, [SINGLE], 'User answered: B')])
    expect(host.querySelector('.term-chat__answer')).toBeNull()
    expect(cards()[0].textContent).toContain('User answered: B')
  })

  it('a read-only transcript (closed node) never shows controls', async () => {
    await hold('waiting', held(['Pick one?']))
    reads.messages = [askMsg(0, [SINGLE])]
    await act(async () => {
      root.render(<ChatPanel nodeId={NODE} sessionId="s1" agentId="claude" readOnly />)
    })
    expect(host.querySelector('.term-chat__answer')).toBeNull()
  })
})
