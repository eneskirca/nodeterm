import { describe, it, expect } from 'vitest'
import { decideFromPane, decideFromTranscriptTail, decideNode } from './agent-resync-decide'

const assistantText = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

const assistantToolUse = (id: string, name: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name }] } })

const toolResult = (id: string): string =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } })

describe('decideFromPane', () => {
  it('a shell owning the pane means the CLI exited', () => {
    expect(decideFromPane('zsh')).toBe('ended')
    expect(decideFromPane('-bash')).toBe('ended')
  })

  it('the CLI still owning the pane decides nothing — it cannot tell mid-turn from waiting', () => {
    expect(decideFromPane('claude')).toBe('undecided')
  })

  it('a failed or empty probe decides nothing', () => {
    expect(decideFromPane(null)).toBe('undecided')
    expect(decideFromPane('')).toBe('undecided')
  })
})

describe('decideFromTranscriptTail', () => {
  it('a closed assistant message with no outstanding tool call means the turn ended', () => {
    const tail = [assistantToolUse('t1', 'Bash'), toolResult('t1'), assistantText('All done.')].join('\n')
    expect(decideFromTranscriptTail(tail)).toBe('ended')
  })

  it('an unanswered tool_use means it is still working — this is the long Bash call', () => {
    const tail = [assistantText('Let me check.'), assistantToolUse('t9', 'Bash')].join('\n')
    expect(decideFromTranscriptTail(tail)).toBe('working')
  })

  it('a tool_result for a tool_use opened before the tail window is ignored, not miscounted', () => {
    const tail = [toolResult('opened-earlier'), assistantText('Finished.')].join('\n')
    expect(decideFromTranscriptTail(tail)).toBe('ended')
  })

  it('a truncated first line is skipped rather than poisoning the verdict', () => {
    const tail = ['{"type":"assist', assistantText('Finished.')].join('\n')
    expect(decideFromTranscriptTail(tail)).toBe('ended')
  })

  it('a tail ending on a user prompt decides nothing', () => {
    const tail = [assistantText('Done.'), JSON.stringify({ type: 'user', message: { content: 'go on' } })].join('\n')
    expect(decideFromTranscriptTail(tail)).toBe('undecided')
  })

  it('a tool_use we cannot track decides nothing — never that the turn finished', () => {
    const tail = [
      assistantText('Let me check.'),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })
    ].join('\n')
    expect(decideFromTranscriptTail(tail)).toBe('undecided')
  })

  it('a tool_use alongside text in the same message still counts as an open call', () => {
    const tail = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Running it.' }, { type: 'tool_use', id: 't3', name: 'Bash' }] }
    })
    expect(decideFromTranscriptTail(tail)).toBe('working')
  })

  it('an empty or unparseable tail decides nothing', () => {
    expect(decideFromTranscriptTail('')).toBe('undecided')
    expect(decideFromTranscriptTail('not json at all')).toBe('undecided')
  })
})

describe('decideNode', () => {
  it('the pane wins when it is decisive — no transcript read needed', () => {
    expect(decideNode('zsh', null)).toBe('ended')
  })

  it('a shell in the pane beats a transcript that still looks busy — the CLI is gone either way', () => {
    expect(decideNode('zsh', assistantToolUse('t1', 'Bash'))).toBe('ended')
  })

  it('falls through to the transcript when the CLI still owns the pane', () => {
    expect(decideNode('claude', assistantText('Finished.'))).toBe('ended')
    expect(decideNode('claude', assistantToolUse('t1', 'Bash'))).toBe('working')
  })

  it('an unread transcript decides nothing', () => {
    expect(decideNode('claude', null)).toBe('undecided')
  })
})
