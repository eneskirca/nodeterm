import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createGrokSubagentFormatter } from './grok-subagent-format'

// A real child session's lines. The card is a live view of the SAME file context links and the ⌘M
// panel read, so this delegates to `linesFromGrok` rather than parsing again — a card that disagreed
// with the transcript the user can open beside it would be worse than no card.
const RAW = fs.readFileSync(path.join(__dirname, '__fixtures__/grok/chat_history.jsonl'), 'utf8')

describe('createGrokSubagentFormatter', () => {
  it('renders a chunk of the child conversation', () => {
    const out = createGrokSubagentFormatter()(RAW)
    expect(out.length).toBeGreaterThan(0)
    expect(out).toMatch(/^(user|assistant|system|system_reminder|compaction_meta):/m)
  })

  it('emits nothing for a chunk with no renderable line', () => {
    // The tail feeds partial reads. A chunk that lands mid-line, or between messages, must produce
    // an empty string rather than a stray fragment on the card.
    const fmt = createGrokSubagentFormatter()
    expect(fmt('')).toBe('')
    expect(fmt('{"type":"reasoning"')).toBe('')
    expect(fmt('\n\n')).toBe('')
  })

  it('never shows model reasoning on the card', () => {
    // `reasoning` lines carry `encrypted_content`; the fixture has three. None of that ciphertext
    // may reach a card the user reads.
    expect(createGrokSubagentFormatter()(RAW)).not.toContain('encrypted_content')
  })

  it('does not attribute harness-injected text to the child', () => {
    // Same rule the transcript reader follows: a `user` line carrying `synthetic_reason` was
    // injected by tooling, and on a card labelled with a subagent's name it would read as something
    // that subagent said.
    const out = createGrokSubagentFormatter()(RAW)
    expect(out).toMatch(/^system_reminder:/m)
  })

  it('gives each card its own formatter instance', () => {
    // Two children run in parallel and each gets its own. They must not share state — today there
    // is none, and this pins that a future state stays per-card.
    expect(createGrokSubagentFormatter()).not.toBe(createGrokSubagentFormatter())
  })
})
