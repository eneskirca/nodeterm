import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  antigravityParse,
  extractAntigravityModelSelection,
  extractAntigravityUserText,
  linesFromAntigravity,
  renderTranscriptLines
} from './context-link-render'
import { antigravityWindowFor } from './model-window'
import {
  antigravityContextParse,
  pickAntigravityTokens,
  rememberAntigravityModel
} from './antigravity-session'
import { chatFromAntigravity, readAntigravityChatTranscript } from './antigravity-chat'
import { locateAntigravity } from './handoff/locate'
import { listRecentConversations, resetRecentConversationsCacheForTests, type RecentRoots } from './recent-conversations'

const SESSION_ID = '6a7d832d-57cf-4620-882b-bdab326e9101'

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
    ],
    input_tokens: 12400,
    cache_read_tokens: 8000,
    output_tokens: 150
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
    content: 'All capabilities are now wired.',
    input_tokens: 25000,
    cache_read_tokens: 15000,
    output_tokens: 210
  })
].join('\n')

describe('Antigravity transcript parsing & context-link rendering', () => {
  it('extracts user request text and model selection from USER_INPUT', () => {
    const raw =
      '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Argon (High).\n</USER_SETTINGS_CHANGE>\n<USER_REQUEST>\nHello Argon\n</USER_REQUEST>'
    expect(extractAntigravityModelSelection(raw)).toBe('Gemini 4 Argon (High)')
    expect(extractAntigravityUserText(raw)).toBe('Hello Argon')
  })

  it('parses human, assistant, and tool call lines while skipping SYSTEM_MESSAGE and CHECKPOINT without counting them as errors', () => {
    const parsed = antigravityParse(SAMPLE_TRANSCRIPT)
    expect(parsed.skipped).toBe(0)
    expect(parsed.lines).toHaveLength(5)

    const lines = linesFromAntigravity(SAMPLE_TRANSCRIPT)
    expect(lines).toEqual([
      'user: Fix the context link bug in NodeTerm',
      'assistant: I will inspect `config.ts` now.',
      '  $ view_file C:/Desenv/particular/nodeterm/src/shared/agents/config.ts',
      'assistant: All capabilities are now wired.'
    ])
    expect(renderTranscriptLines('antigravity', SAMPLE_TRANSCRIPT)).toEqual(lines)
  })
})

describe('Antigravity context window & token usage', () => {
  it('maps Gemini/Argon/Claude 4.6 models to 1M and GPT-OSS models to 128k', () => {
    expect(antigravityWindowFor('gemini-4-argon-medium')).toBe(1_000_000)
    expect(antigravityWindowFor('Gemini 4 Argon (High)')).toBe(1_000_000)
    expect(antigravityWindowFor('gemini-3.1-pro-high')).toBe(1_000_000)
    expect(antigravityWindowFor('claude-opus-4-6-thinking')).toBe(1_000_000)
    expect(antigravityWindowFor('Claude Sonnet 4.6 (Thinking)')).toBe(1_000_000)
    expect(antigravityWindowFor('gpt-oss-120b-medium')).toBe(128_000)
    expect(antigravityWindowFor(null)).toBeNull()
  })

  it('computes used tokens as input_tokens + cache_read_tokens from the latest PLANNER_RESPONSE', () => {
    const tok = pickAntigravityTokens(SAMPLE_TRANSCRIPT)
    expect(tok).toEqual({
      usedTokens: 40_000,
      model: 'Gemini 4 Argon (Medium)'
    })
    expect(antigravityContextParse(SAMPLE_TRANSCRIPT)).toEqual({
      used: 40_000,
      window: 1_000_000,
      model: 'Gemini 4 Argon (Medium)'
    })
  })

  it('falls back to the last hook-reported model when the transcript chunk has no USER_SETTINGS_CHANGE', () => {
    rememberAntigravityModel('gpt-oss-120b-medium')
    const partial = JSON.stringify({
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      content: 'Done.',
      input_tokens: 10_000,
      cache_read_tokens: 5_000
    })
    expect(antigravityContextParse(partial)).toEqual({
      used: 15_000,
      window: 128_000,
      model: 'gpt-oss-120b-medium'
    })
  })
})

describe('Antigravity chat view, locator, and recent conversations', () => {
  let home: string

  beforeEach(() => {
    resetRecentConversationsCacheForTests()
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-agy-test-'))
    vi.spyOn(os, 'homedir').mockReturnValue(home)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('converts an Antigravity transcript into ChatMessages for ⌘M', () => {
    const chat = chatFromAntigravity(SAMPLE_TRANSCRIPT)
    expect(chat.skipped).toBe(0)
    expect(chat.messages).toHaveLength(3)
    expect(chat.messages[0]).toEqual({
      role: 'user',
      parts: [{ kind: 'text', text: 'Fix the context link bug in NodeTerm' }]
    })
    expect(chat.messages[1].role).toBe('assistant')
    expect(chat.messages[1].parts).toEqual([
      { kind: 'text', text: 'I will inspect `config.ts` now.' },
      {
        kind: 'tool',
        name: 'view_file',
        arg: 'C:/Desenv/particular/nodeterm/src/shared/agents/config.ts'
      }
    ])
  })

  it('locates transcript_full.jsonl on disk, reads paged chat transcripts, and lists recent conversations with cwd from history.jsonl', async () => {
    const agyRoot = path.join(home, '.gemini', 'antigravity-cli')
    const logsDir = path.join(agyRoot, 'brain', SESSION_ID, '.system_generated', 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    const tf = path.join(logsDir, 'transcript_full.jsonl')
    fs.writeFileSync(tf, SAMPLE_TRANSCRIPT + '\n')
    fs.writeFileSync(
      path.join(agyRoot, 'history.jsonl'),
      JSON.stringify({
        display: 'Fix the context link bug in NodeTerm',
        timestamp: 1760444000000,
        workspace: '/srv/nodeterm',
        conversationId: SESSION_ID
      }) + '\n'
    )

    expect(await locateAntigravity(SESSION_ID)).toBe(tf)
    expect(await locateAntigravity('../escape')).toBeUndefined()

    const readRes = await readAntigravityChatTranscript({ sessionId: SESSION_ID }, null)
    expect(readRes.found).toBe(true)
    expect(readRes.messages).toHaveLength(3)

    const roots: RecentRoots = {
      claude: [],
      codex: [],
      geminiTmp: null,
      grokSessions: null,
      copilot: [],
      antigravity: agyRoot
    }
    const recent = await listRecentConversations(roots)
    expect(recent).toHaveLength(1)
    expect(recent[0]).toMatchObject({
      agentId: 'antigravity',
      sessionId: SESSION_ID,
      cwd: '/srv/nodeterm',
      title: 'Fix the context link bug in NodeTerm',
      titleSource: 'prompt'
    })
  })
})
