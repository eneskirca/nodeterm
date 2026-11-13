// Context Link's flat-line reading of an opencode export, in both measured shapes. Issue #1438:
// opencode 2.x messages carry no `info` / `parts`, so the 1.x-only reader dropped every USER
// message (its prompt is a top-level `text`) and a summary showed one side of the conversation.
import { describe, expect, it } from 'vitest'
import { linesFromOpencodeExport, renderContextLink, type ContextLinkFetch } from './context-link-render'

/** The shape of a real `opencode session export` (@opencode/cli 2.2.7), values replaced. */
const V2_EXPORT = JSON.stringify({
  info: { id: 'ses_fixture', title: 'Fixture', model: { id: 'demo', providerID: 'opencode', variant: 'default' } },
  messages: [
    { id: 'msg_0', time: { created: 1 }, type: 'system', text: 'SYSTEM TEXT NEVER SHOWN' },
    { id: 'msg_1', time: { created: 2 }, text: 'Read note.txt please', files: [], type: 'user' },
    { id: 'msg_s', time: { created: 2 }, type: 'synthetic', text: 'SYNTHETIC TEXT NEVER SHOWN' },
    {
      id: 'msg_2',
      time: { created: 3 },
      type: 'assistant',
      agent: 'build',
      content: [
        { type: 'reasoning', text: 'REASONING NEVER SHOWN' },
        {
          type: 'tool',
          id: 'call_1',
          name: 'read',
          executed: false,
          state: { status: 'completed', input: { path: 'note.txt' }, content: [{ type: 'text', text: '1: hello' }] }
        }
      ],
      finish: 'tool-calls'
    },
    { id: 'msg_3', time: { created: 4 }, type: 'assistant', content: [{ type: 'text', text: 'It says hello.' }] },
    { id: 'msg_4', time: { created: 5 }, type: 'idle', outcome: 'succeeded' }
  ]
})

const V1_EXPORT = JSON.stringify({
  info: { id: 'ses_fixture' },
  messages: [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'Run the tests' }] },
    {
      info: { role: 'assistant' },
      parts: [
        { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, output: 'ok' } },
        { type: 'text', text: 'All green.' }
      ]
    }
  ]
})

describe('linesFromOpencodeExport', () => {
  it('2.x: both speakers, the tool call, and none of the harness entries', () => {
    expect(linesFromOpencodeExport(V2_EXPORT)).toEqual([
      'user: Read note.txt please',
      '  $ read note.txt',
      'assistant: It says hello.'
    ])
  })

  it('1.x: unchanged', () => {
    expect(linesFromOpencodeExport(V1_EXPORT)).toEqual(['user: Run the tests', '  $ bash npm test', 'assistant: All green.'])
  })

  it('not JSON is null (an unreadable export), an empty document is no lines', () => {
    expect(linesFromOpencodeExport('USAGE\n  opencode <subcommand>')).toBeNull()
    expect(linesFromOpencodeExport('{"info":{},"messages":[]}')).toEqual([])
  })
})

describe('renderContextLink — an opencode node', () => {
  const doc = { self: 'node-A', links: [{ id: 'node-O', title: 'API project', tmux: '', transcriptPath: '', cwd: '', agent: 'opencode', sessionId: 'ses_fixture' }] }
  const fetch = (out: string | null): ContextLinkFetch => ({
    transcript: async () => null,
    terminal: async () => '',
    opencodeExport: async () => out
  })

  it('summarises a 2.x session with the user turns in it', async () => {
    const out = await renderContextLink(doc as never, 'summary', { n: '15' }, fetch(V2_EXPORT))
    expect(out).toContain('user: Read note.txt please')
    expect(out).toContain('assistant: It says hello.')
  })

  it('a failed export does not claim opencode is missing', async () => {
    const out = await renderContextLink(doc as never, 'summary', {}, fetch(null))
    expect(out).toContain('Could not export "API project" session')
    expect(out).toContain('export failed')
    expect(out).not.toContain('is opencode installed')
  })
})
