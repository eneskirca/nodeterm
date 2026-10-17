import { describe, expect, it } from 'vitest'
import { renderAntigravityTranscript } from './render-antigravity'

const SAMPLE_TRANSCRIPT = [
  JSON.stringify({
    step_index: 0,
    type: 'USER_INPUT',
    status: 'DONE',
    content:
      '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Argon (Medium).\n</USER_SETTINGS_CHANGE>\n<USER_REQUEST>\nFix the context link bug in NodeTerm\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>'
  }),
  JSON.stringify({
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    thinking: 'Let us inspect config.ts first.',
    content: 'I will inspect `config.ts` now.',
    tool_calls: [
      {
        id: 'tc-1',
        name: 'view_file',
        args: { AbsolutePath: 'C:/Desenv/particular/nodeterm/src/shared/agents/config.ts' }
      }
    ]
  }),
  JSON.stringify({
    step_index: 2,
    type: 'SYSTEM_MESSAGE',
    status: 'DONE',
    content: 'System reminder'
  }),
  JSON.stringify({
    step_index: 3,
    type: 'CHECKPOINT',
    status: 'DONE',
    content: 'Compacted summary'
  }),
  JSON.stringify({
    step_index: 4,
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: 'All capabilities are now wired.'
  })
].join('\n')

describe('renderAntigravityTranscript', () => {
  it('renders user and assistant turns to Markdown while omitting harness metadata and checkpoints', () => {
    const md = renderAntigravityTranscript(SAMPLE_TRANSCRIPT)
    expect(md).toContain('## User\n\nFix the context link bug in NodeTerm')
    expect(md).toContain('## Assistant\n\nI will inspect `config.ts` now.')
    expect(md).toContain('$ view_file C:/Desenv/particular/nodeterm/src/shared/agents/config.ts')
    expect(md).toContain('## Assistant\n\nAll capabilities are now wired.')
    expect(md).not.toContain('USER_SETTINGS_CHANGE')
    expect(md).not.toContain('System reminder')
    expect(md).not.toContain('Compacted summary')
  })
})
