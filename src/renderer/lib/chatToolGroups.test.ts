import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatPart } from '@shared/types'
import { BACKGROUND_TASK_TOOL } from '@shared/chat-system-records'
import { COMMAND_OUTPUT_TOOL } from '@shared/chat-command'
import { groupToolCalls, partPosition, toolGroupSummary } from './chatToolGroups'

const tool = (name: string, extra: Partial<Extract<ChatPart, { kind: 'tool' }>> = {}): ChatPart => ({
  kind: 'tool',
  name,
  arg: '',
  ...extra
})
const call = (name: string, key?: number): ChatMessage => ({ role: 'assistant', parts: [tool(name)], key })
const say = (text: string): ChatMessage => ({ role: 'assistant', parts: [{ kind: 'text', text }] })
const think = (text: string): ChatMessage => ({ role: 'assistant', parts: [{ kind: 'thinking', text }] })
const user = (text: string): ChatMessage => ({ role: 'user', parts: [{ kind: 'text', text }] })

/** Each group as the positions of its members, in thread order. */
function runs(messages: ChatMessage[]): string[][] {
  const layout = groupToolCalls(messages)
  return [...layout.groupAt.values()].map((g) => g.members.map((m) => partPosition(m.message, m.part)))
}

describe('groupToolCalls', () => {
  it('folds consecutive tool calls across messages, one call per transcript line', () => {
    const messages = [user('go'), call('Bash'), call('Read'), call('Bash')]

    const layout = groupToolCalls(messages)

    expect(runs(messages)).toEqual([['1:0', '2:0', '3:0']])
    expect([...layout.absorbed]).toEqual(['2:0', '3:0'])
  })

  it('leaves a single tool call as a plain chip', () => {
    const messages = [say('looking'), call('Read'), say('found it')]

    const layout = groupToolCalls(messages)

    expect(layout.groupAt.size).toBe(0)
    expect(layout.absorbed.size).toBe(0)
  })

  it('starts a new block after text and after a thinking summary, like the TUI', () => {
    const messages = [call('Bash'), call('Bash'), think('so the test is flaky'), call('Read'), call('Edit'), say('done'), call('Bash'), call('Bash')]

    const result = runs(messages)

    expect(result).toEqual([
      ['0:0', '1:0'],
      ['3:0', '4:0'],
      ['6:0', '7:0']
    ])
  })

  it('folds several tool parts inside one message, and stops at a text part between them', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', parts: [tool('Read'), tool('Grep'), { kind: 'text', text: 'hmm' }, tool('Bash')] },
      call('Bash')
    ]

    const result = runs(messages)

    expect(result).toEqual([
      ['0:0', '0:1'],
      ['0:3', '1:0']
    ])
  })

  it('never folds a plan or question card, the user turn, a system record, or a local command', () => {
    const messages: ChatMessage[] = [
      call('Bash'),
      { role: 'assistant', parts: [tool('ExitPlanMode', { body: '# plan' })] },
      call('Bash'),
      user('ok'),
      call('Bash'),
      { role: 'assistant', parts: [tool(BACKGROUND_TASK_TOOL)] },
      call('Bash'),
      { role: 'assistant', parts: [tool('/model')] },
      { role: 'assistant', parts: [tool('!')] },
      { role: 'assistant', parts: [tool(COMMAND_OUTPUT_TOOL)] },
      call('Bash')
    ]

    const layout = groupToolCalls(messages)

    expect(layout.groupAt.size).toBe(0)
  })

  it('keys a group by its first line offset, so it keeps its key while the run grows', () => {
    const before = groupToolCalls([user('go'), call('Bash', 100), call('Read', 200)])
    const after = groupToolCalls([user('go'), call('Bash', 100), call('Read', 200), call('Edit', 300)])

    const keyBefore = before.groupAt.get('1:0')?.key
    const keyAfter = after.groupAt.get('1:0')?.key

    expect(keyBefore).toBe('k100:0')
    expect(keyAfter).toBe(keyBefore)
  })

  it('keys an unpaged thread by position', () => {
    const layout = groupToolCalls([user('go'), call('Bash'), call('Read')])

    expect(layout.groupAt.get('1:0')?.key).toBe('i1:0')
  })
})

describe('toolGroupSummary', () => {
  it('counts the calls and lists the tools, most-used first', () => {
    const messages = [call('Read'), call('Bash'), call('Bash'), call('Edit'), call('Bash')]
    const group = [...groupToolCalls(messages).groupAt.values()][0]

    const summary = toolGroupSummary(messages, group)

    expect(summary).toEqual({ count: '5 tool calls', names: 'Bash ×3, Read, Edit' })
  })

  it('names at most three tools and counts the rest', () => {
    const messages = ['A', 'B', 'C', 'D', 'E'].map((n) => call(n))
    const group = [...groupToolCalls(messages).groupAt.values()][0]

    const summary = toolGroupSummary(messages, group)

    expect(summary.names).toBe('A, B, C +2 more')
  })
})
