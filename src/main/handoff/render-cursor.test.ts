import { describe, expect, it } from 'vitest'
import { renderCursorTranscript } from './render-cursor'

const line = (o: unknown): string => JSON.stringify(o)
const NDJSON = [
  line({ role: 'system', content: 'SYSTEM PROMPT' }),
  line({ role: 'user', content: '<user_info>secret-rule-text</user_info>' }),
  line({ role: 'user', content: [{ type: 'text', text: '<user_query>\nRun echo and tell me the word.\n</user_query>' }] }),
  line({ role: 'assistant', content: [{ type: 'reasoning', text: 'ENCRYPTED' }, { type: 'text', text: 'On it.' }] }),
  line({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'Write', args: { path: '/w/a.txt', contents: 'hi' } }] }),
  line({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Write', result: 'Command completed in 9 ms.' }] })
].join('\n')

describe('renderCursorTranscript', () => {
  it('renders typed prompts, replies, and full tool args and results, without injected context', () => {
    const md = renderCursorTranscript(NDJSON)
    expect(md).toContain('## User\n\nRun echo and tell me the word.')
    expect(md).toContain('## Assistant\n\nOn it.')
    expect(md).toContain('### Tool call: Write')
    expect(md).toContain('"contents": "hi"')
    expect(md).toContain('Command completed in 9 ms.')
    for (const leak of ['secret-rule-text', 'SYSTEM PROMPT', 'ENCRYPTED']) expect(md).not.toContain(leak)
  })
  it('answers an empty string for empty or junk input', () => {
    expect(renderCursorTranscript('')).toBe('')
    expect(renderCursorTranscript('{not json\n')).toBe('')
  })
})
