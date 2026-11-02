// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { useAgentStatus } from '../state/agentStatus'
import { useSettings } from '../state/settings'

/**
 * The claude.ai thread look (pure half: lib/chatThread.ts). Pins the glue: the user message is a
 * bubble and the assistant's is not, one quiet action row per assistant turn with Copy (the app's
 * clipboard channel + "Copied") and a relative time from the transcript's `at`.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { session, reads } = vi.hoisted(() => {
  const reads: { messages: unknown[]; lastPage?: Record<string, unknown> } = { messages: [] }
  const session = {
    api: {
      chat: {
        // The trailing `page` argument is recorded, so a test can pin what the panel asks for.
        readTranscript: async (...args: unknown[]) => {
          reads.lastPage = args[5] as Record<string, unknown>
          return { messages: reads.messages, found: true, olderCursor: null, unmatchedResults: [] }
        }
      },
      pty: { sendText: vi.fn(async () => true as const) }
    }
  }
  return { session, reads }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'
import { chatClockTime } from '../lib/chatThread'

const NODE = 'n-thread'
const MIN = 60_000
let host: HTMLDivElement
let root: Root
const writeText = vi.fn()
// The Focus toggle persists through `useSettings.update`, whose coalesced save reaches this.
const saveSettings = vi.fn(async (_s: unknown) => undefined)

beforeEach(() => {
  writeText.mockClear()
  saveSettings.mockClear()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { clipboard: { writeText }, settings: { save: saveSettings } }
  useAgentStatus.setState((s) => ({ byId: { ...s.byId, [NODE]: { state: 'done' } as (typeof s.byId)[string] } }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useSettings.setState((s) => ({ settings: { ...s.settings, chatFocusView: false } }))
  useAgentStatus.setState((s) => {
    const byId = { ...s.byId }
    delete byId[NODE]
    return { byId }
  })
})

async function mount(messages: ChatMessage[]): Promise<void> {
  reads.messages = messages
  reads.lastPage = undefined
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId="s1" agentId="claude" />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const lastPageArg = (): Record<string, unknown> => {
  expect(reads.lastPage, 'readTranscript was not called with a page').toBeTruthy()
  return reads.lastPage!
}

const now = Date.now()
const thread: ChatMessage[] = [
  { role: 'user', parts: [{ kind: 'text', text: 'fix it' }], key: 0, at: now - 10 * MIN },
  { role: 'assistant', parts: [{ kind: 'text', text: 'Looking **now**.' }], key: 10, at: now - 9 * MIN },
  { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'ls' }], key: 20, at: now - 8 * MIN },
  { role: 'assistant', parts: [{ kind: 'text', text: 'Done.' }], key: 30, at: now - 5 * MIN },
  { role: 'user', parts: [{ kind: 'text', text: 'thanks' }], key: 40, at: now - 3 * MIN },
  { role: 'assistant', parts: [{ kind: 'text', text: 'Anytime.' }], key: 50, at: now - 2 * MIN }
]

describe('⌘M thread look', () => {
  it('a user message is a bubble; an assistant message is not', async () => {
    await mount(thread)
    const user = host.querySelector('.term-chat__msg--user')!
    const assistant = host.querySelector('.term-chat__msg--assistant')!
    expect(user.classList.contains('term-chat__bubble')).toBe(true)
    expect(assistant.classList.contains('term-chat__bubble')).toBe(false)
    // The link guard's sink is unchanged: markdown still renders into `.term-chat__text`.
    expect(assistant.querySelector('.term-chat__text strong')?.textContent).toBe('now')
  })

  it('keeps single line breaks, as Claude Code renders them — in prompts and in quoted replies', async () => {
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'This is a test\nof a multiline message' }], key: 0 },
      { role: 'assistant', parts: [{ kind: 'text', text: '> This is a test\n> of a multiline message' }], key: 10 }
    ])

    const user = host.querySelector('.term-chat__msg--user .term-chat__text')!
    const quote = host.querySelector('.term-chat__msg--assistant .term-chat__text blockquote')!

    expect(user.querySelector('br')).not.toBeNull()
    expect(quote.querySelector('br')).not.toBeNull()
  })

  it('one action row per assistant TURN (not per tool line), the latest always shown', async () => {
    await mount(thread)
    const rows = [...host.querySelectorAll('.term-chat__actions')]
    expect(rows).toHaveLength(2)
    expect(rows[0].closest('.term-chat__msg')?.textContent).toContain('Done.')
    expect(rows[0].classList.contains('term-chat__actions--latest')).toBe(false)
    expect(rows[1].classList.contains('term-chat__actions--latest')).toBe(true)
  })

  it('Copy writes the turn\'s markdown source through the app clipboard and says so', async () => {
    await mount(thread)
    const copy = host.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy message"]')[0]
    expect(copy.tabIndex).not.toBe(-1)
    await act(async () => copy.click())
    expect(writeText).toHaveBeenCalledWith('Looking **now**.\n\nDone.')
    expect(copy.closest('.term-chat__actions')?.textContent).toMatch(/Copied/)
  })

  it('shows the relative time from `at`, the absolute one in the tooltip', async () => {
    await mount(thread)
    const times = [...host.querySelectorAll('.term-chat__actions time')]
    expect(times.map((t) => t.textContent)).toEqual(['5 min ago', '2 min ago'])
    expect(times[1].getAttribute('dateTime')).toBe(new Date(now - 2 * MIN).toISOString())
    expect(times[1].getAttribute('title')).toBeTruthy()
  })

  it('no time when the transcript stated none, and no Copy for a turn of tool calls only', async () => {
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'ls' }], key: 10 }
    ])
    expect(host.querySelector('.term-chat__actions time')).toBeNull()
    expect(host.querySelector('button[aria-label="Copy message"]')).toBeNull()
  })

  it('a turn-ending message whose every part is folded keeps its action row but no empty body', async () => {
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0, at: now - 3 * MIN },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'a' }], key: 10, at: now - 2 * MIN },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'b' }], key: 20, at: now - MIN }
    ])
    const last = [...host.querySelectorAll('.term-chat__msg--assistant')].at(-1)!
    expect(last.classList.contains('term-chat__msg--folded')).toBe(true)
    expect(last.querySelector('.term-chat__actions time')?.textContent).toBe('1 min ago')
    expect(last.querySelector('.term-chat__tool')).toBeNull()
    // ONLY the action row: its calls are drawn in the block above it.
    expect(last.childElementCount).toBe(1)
  })

  it('while the agent is working, the trailing run of tool calls is not folded', async () => {
    // The afterEach drops NODE's entry, which restores the beforeEach's `done` for the next test.
    useAgentStatus.setState((s) => ({ byId: { ...s.byId, [NODE]: { state: 'working' } as (typeof s.byId)[string] } }))
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'a' }], key: 10 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Read', arg: 'b' }], key: 20 }
    ])
    expect(host.querySelector('.term-chat__tool-group')).toBeNull()
    expect(host.querySelectorAll('.term-chat__tool')).toHaveLength(2)
  })

  it('while the agent waits on a prompt mid-turn, the trailing run of tool calls is not folded', async () => {
    // `waiting` (a PermissionRequest) refuses with `dialog`: the turn is still live, so its calls stay
    // chips rather than folding closed on every prompt. The afterEach restores `done`.
    useAgentStatus.setState((s) => ({ byId: { ...s.byId, [NODE]: { state: 'waiting' } as (typeof s.byId)[string] } }))
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'a' }], key: 10 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Read', arg: 'b' }], key: 20 }
    ])
    expect(host.querySelector('.term-chat__tool-group')).toBeNull()
    expect(host.querySelectorAll('.term-chat__tool')).toHaveLength(2)
  })

  it('shows the clock time under a user bubble and a day divider at each day start', async () => {
    // `thread` is stamped off the wall clock, so for ten minutes after midnight its first stamps fall
    // on yesterday; re-anchored at today's noon its stamps are all today whenever this runs.
    const noon = new Date(now).setHours(12, 0, 0, 0)
    await mount(thread.map((m) => ({ ...m, at: m.at! - now + noon })))
    const time = host.querySelector('.term-chat__msg--user time.term-chat__time--user')
    expect(time?.textContent).toBe(chatClockTime(noon - 10 * MIN))
    expect(time?.classList.contains('term-chat__time')).toBe(true)
    expect(time?.getAttribute('dateTime')).toBe(new Date(noon - 10 * MIN).toISOString())
    expect(time?.getAttribute('title')).toBeTruthy()
    const days = [...host.querySelectorAll('.term-chat__day')]
    expect(days.map((d) => d.textContent)).toEqual(['Today'])
    expect(days[0].getAttribute('role')).toBe('separator')
    expect(days[0].nextElementSibling?.classList.contains('term-chat__msg--user')).toBe(true)
  })

  it('no clock time under a user bubble the transcript did not stamp', async () => {
    await mount([{ role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0 }])
    expect(host.querySelector('.term-chat__msg--user')).not.toBeNull()
    expect(host.querySelector('.term-chat__time--user')).toBeNull()
    expect(host.querySelector('.term-chat__day')).toBeNull()
  })

  it('a day that starts on a folded turn end still gets its divider, before the folded row', async () => {
    const midnight = new Date(now).setHours(0, 0, 0, 0)
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0, at: midnight - 120 * MIN },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'a' }], key: 10, at: midnight - 60 * MIN },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'b' }], key: 20, at: midnight + MIN }
    ])
    const days = [...host.querySelectorAll('.term-chat__day')]
    expect(days.map((d) => d.textContent)).toEqual(['Yesterday', 'Today'])
    expect(days[1].nextElementSibling?.classList.contains('term-chat__msg--folded')).toBe(true)
  })

  it('a thinking part is a closed fold labelled with the duration the parser stamped', async () => {
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0 },
      { role: 'assistant', parts: [{ kind: 'thinking', text: 'hmm **deep**', ms: 12_400 }], key: 10 },
      { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }], key: 20 }
    ])
    const d = host.querySelector<HTMLDetailsElement>('details.term-chat__thinking')!
    expect(d.open).toBe(false)
    expect(d.querySelector('summary')?.textContent).toBe('Thought for 12s')
    expect(d.querySelector('.term-chat__text strong')?.textContent).toBe('deep')
  })

  it('a thinking fold without a stamped duration just says Thinking, whatever its neighbours\' times', async () => {
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0, at: now - 30_000 },
      { role: 'assistant', parts: [{ kind: 'thinking', text: 'hmm' }], key: 10, at: now - 20_000 },
      { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }], key: 20, at: now - 8_000 }
    ])
    expect(host.querySelector('details.term-chat__thinking > summary')?.textContent).toBe('Thinking')
  })

  it('renders an image part as a thumbnail that enlarges on click', async () => {
    await mount([{ role: 'user', parts: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }], key: 0 }])
    const img = host.querySelector<HTMLImageElement>('.term-chat__msg--user img.term-chat__image')!
    expect(img.src).toBe('data:image/png;base64,AAAA')
    expect(img.alt).toBe('Attached image')
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.classList.contains('term-chat__image--full')).toBe(false)
    await act(async () => img.click())
    expect(img.classList.contains('term-chat__image--full')).toBe(true)
    await act(async () => img.click())
    expect(img.classList.contains('term-chat__image--full')).toBe(false)
  })

  it('an Edit renders as a diff chip with counts and colored lines', async () => {
    await mount([
      {
        role: 'assistant',
        parts: [
          {
            kind: 'tool',
            name: 'Edit',
            arg: '/a.ts',
            diff: { filePath: '/a.ts', oldText: 'a\nb', newText: 'a\nc' },
            result: 'The file /a.ts has been updated.'
          }
        ],
        key: 0
      }
    ])
    expect(host.querySelector('.term-chat__diff-counts')?.textContent).toBe('+1 −1')
    expect(host.querySelectorAll('.term-chat__diff-line--add')).toHaveLength(1)
    const chip = host.querySelector<HTMLDetailsElement>('details.term-chat__tool.term-chat__tool--diff')!
    expect(chip.open).toBe(false)
    expect(chip.querySelector('summary .term-chat__tool-name')?.textContent).toBe('Edit')
    expect(chip.querySelector('summary .term-chat__tool-arg')?.textContent).toBe('/a.ts')
    const lines = [...chip.querySelectorAll('pre.term-chat__diff > .term-chat__diff-line')]
    expect(lines.map((l) => [l.className, l.textContent])).toEqual([
      ['term-chat__diff-line term-chat__diff-line--ctx', ' a'],
      ['term-chat__diff-line term-chat__diff-line--del', '-b'],
      ['term-chat__diff-line term-chat__diff-line--add', '+c']
    ])
    // The result follows the diff, as on the plain chip.
    expect(chip.querySelector('pre.term-chat__diff + pre.term-chat__tool-result')?.textContent).toBe(
      'The file /a.ts has been updated.'
    )
  })

  it('a Write with no result is all added lines; a tool without a diff stays the plain chip', async () => {
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0 },
      {
        role: 'assistant',
        parts: [{ kind: 'tool', name: 'Write', arg: '/b.ts', diff: { filePath: '/b.ts', oldText: '', newText: 'x\ny\n' } }],
        key: 10
      },
      { role: 'assistant', parts: [{ kind: 'text', text: 'Done.' }], key: 20 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Edit', arg: '/c.ts' }], key: 30 }
    ])
    const diffs = host.querySelectorAll('.term-chat__tool--diff')
    expect(diffs).toHaveLength(1)
    expect(diffs[0].querySelector('.term-chat__diff-counts')?.textContent).toBe('+2 −0')
    expect(diffs[0].querySelector('.term-chat__tool-result')).toBeNull()
    const plain = [...host.querySelectorAll('.term-chat__tool')].filter((t) => !t.classList.contains('term-chat__tool--diff'))
    expect(plain).toHaveLength(1)
    expect(plain[0].querySelector('.term-chat__diff')).toBeNull()
  })

  it('a diff chip inside a folded tool run is drawn as a diff chip there too', async () => {
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Read', arg: '/a.ts' }], key: 10 },
      {
        role: 'assistant',
        parts: [{ kind: 'tool', name: 'Edit', arg: '/a.ts', diff: { filePath: '/a.ts', oldText: 'a', newText: 'b' } }],
        key: 20
      },
      { role: 'assistant', parts: [{ kind: 'text', text: 'Done.' }], key: 30 }
    ])
    const group = host.querySelector('.term-chat__tool-group')!
    expect(group.querySelector('.term-chat__tool-group-count')?.textContent).toBe('2 tool calls')
    expect(group.querySelector('.term-chat__tool-group-body .term-chat__tool--diff .term-chat__diff-counts')?.textContent).toBe(
      '+1 −1'
    )
  })

  it('asks the reader for rich parts', async () => {
    await mount([])
    expect(lastPageArg().rich).toBe(true)
  })

  it('a day that starts inside a folded tool run keeps its divider (drawn where the run ends)', async () => {
    const midnight = new Date(now).setHours(0, 0, 0, 0)
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0, at: midnight - 120 * MIN },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'a' }], key: 10, at: midnight - 60 * MIN },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'b' }], key: 20, at: midnight + MIN },
      { role: 'assistant', parts: [{ kind: 'text', text: 'Done.' }], key: 30, at: midnight + 2 * MIN }
    ])
    const days = [...host.querySelectorAll('.term-chat__day')]
    expect(days.map((d) => d.textContent)).toEqual(['Yesterday', 'Today'])
    expect(days[1].nextElementSibling?.textContent).toContain('Done.')
  })
})

describe('⌘M Focus view and the todo-list card', () => {
  const todo = (key: number, body: string, result?: string): ChatMessage => ({
    role: 'assistant',
    parts: [{ kind: 'tool', name: 'TodoWrite', arg: '', body, ...(result ? { result } : {}) }],
    key
  })
  const TODO_RESULT = 'Todos have been modified successfully. Ensure that you continue to use the todo list'
  const focusOn = (): void => useSettings.setState((s) => ({ settings: { ...s.settings, chatFocusView: true } }))

  it('only the latest todo list is a card; an older one is the plain chip (Focus off too)', async () => {
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0 },
      todo(10, '- [ ] a\n- [ ] b'),
      { role: 'assistant', parts: [{ kind: 'text', text: 'working' }], key: 20 },
      todo(30, '- [x] a\n- [ ] **b** _(in progress)_', TODO_RESULT)
    ])
    const cards = [...host.querySelectorAll('.term-chat__tool-card')]
    expect(cards).toHaveLength(1)
    expect(cards[0].classList.contains('term-chat__todo')).toBe(true)
    // The CLI's canned reply to a TodoWrite is plumbing: the card shows the list, not the result.
    expect(cards[0].querySelector('.term-chat__tool-result')).toBeNull()
    expect(cards[0].textContent).not.toContain('Todos have been modified')
    expect(cards[0].querySelector('.term-chat__tool-card-title')?.textContent).toBe('Todo list')
    const boxes = [...cards[0].querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, true],
      [false, true]
    ])
    expect(cards[0].querySelector('strong')?.textContent).toBe('b')
    const chips = [...host.querySelectorAll('details.term-chat__tool')]
    expect(chips).toHaveLength(1)
    expect(chips[0].querySelector('.term-chat__tool-name')?.textContent).toBe('TodoWrite')
    expect(host.querySelector('.term-chat__focus')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('a superseded todo list folds into the tool block around it, drawn there as its chip', async () => {
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'a' }], key: 10 },
      todo(20, '- [ ] old', TODO_RESULT),
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'b' }], key: 30 },
      todo(40, '- [x] latest')
    ])
    const groups = [...host.querySelectorAll('.term-chat__tool-group')]
    expect(groups).toHaveLength(1)
    expect(groups[0].querySelector('.term-chat__tool-group-count')?.textContent).toBe('3 tool calls')
    const names = [...groups[0].querySelectorAll('.term-chat__tool-group-body .term-chat__tool-name')].map((n) => n.textContent)
    expect(names).toEqual(['Bash', 'TodoWrite', 'Bash'])
    expect(groups[0].querySelector('.term-chat__tool-card')).toBeNull()
    expect(host.querySelectorAll('.term-chat__tool-card')).toHaveLength(1)
  })

  it('Focus hides chips, groups and thinking; keeps text, the latest todo card and a question card', async () => {
    focusOn()
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'ls' }], key: 10 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Read', arg: '/a' }], key: 20 },
      { role: 'assistant', parts: [{ kind: 'thinking', text: 'hmm', ms: 2000 }], key: 30 },
      { role: 'assistant', parts: [{ kind: 'text', text: 'answer' }], key: 40 },
      todo(50, '- [ ] old'),
      todo(60, '- [ ] latest'),
      {
        role: 'assistant',
        parts: [
          {
            kind: 'tool',
            name: 'AskUserQuestion',
            arg: '',
            body: 'Pick one?',
            questions: [{ question: 'Pick one?', multiSelect: false, options: [{ label: 'A' }] }]
          }
        ],
        key: 70
      }
    ])
    expect(host.querySelector('.term-chat__tool-group')).toBeNull()
    expect(host.querySelector('details.term-chat__thinking')).toBeNull()
    expect(host.querySelector('details.term-chat__tool')).toBeNull()
    const cards = [...host.querySelectorAll('.term-chat__tool-card')]
    expect(cards.map((c) => c.querySelector('.term-chat__tool-card-title')?.textContent)).toEqual(['Todo list', 'Question'])
    expect(cards[0].textContent).toContain('latest')
    // A message with nothing left to draw is not drawn at all: the answer, the todo card, the question.
    expect(host.querySelectorAll('.term-chat__msg--assistant')).toHaveLength(3)
    expect(host.querySelector('.term-chat__msg--assistant')?.textContent).toContain('answer')
    expect(host.querySelector('.term-chat__focus')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('in Focus, a turn that ends on a hidden call keeps its action row (the folded wrapper)', async () => {
    focusOn()
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0, at: now - 3 * MIN },
      { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }], key: 10, at: now - 2 * MIN },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'ls' }], key: 20, at: now - MIN }
    ])
    const last = [...host.querySelectorAll('.term-chat__msg--assistant')].at(-1)!
    expect(last.classList.contains('term-chat__msg--folded')).toBe(true)
    expect(last.childElementCount).toBe(1)
    expect(last.querySelector('.term-chat__actions time')?.textContent).toBe('1 min ago')
    expect(host.querySelector('.term-chat__tool')).toBeNull()
  })

  it('the bar toggle flips the view and persists the setting', async () => {
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0 },
      { role: 'assistant', parts: [{ kind: 'thinking', text: 'hmm' }], key: 10 },
      { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }], key: 20 }
    ])
    const toggle = host.querySelector<HTMLButtonElement>('button.term-chat__focus')!
    expect(toggle.textContent).toBe('Focus')
    expect(toggle.title).toBe('Focus view: hide tool calls and thinking')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(host.querySelector('details.term-chat__thinking')).not.toBeNull()

    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('details.term-chat__thinking')).toBeNull()
    expect(useSettings.getState().settings.chatFocusView).toBe(true)
    // The store's coalesced save (300 ms) writes it to disk.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350))
    })
    expect(saveSettings.mock.calls.at(-1)?.[0]).toMatchObject({ chatFocusView: true })

    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(host.querySelector('details.term-chat__thinking')).not.toBeNull()
    expect(useSettings.getState().settings.chatFocusView).toBe(false)
  })
})
