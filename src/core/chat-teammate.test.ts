// An agent team's teammate writing to the lead (core/chat-teammate.ts). The record shapes are the
// golden fixture's (`src/shared/chat-fixtures/inputs/teammate-messages.jsonl`, synthetic content in
// the measured shape); the wire output is pinned there. This file pins the rich read and the parser.
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { TEAMMATE_PREFIXES, readIdleNotification, teammateElements } from './chat-teammate'
import { parseChatMessages, parseTranscriptLines } from './transcript-reader'

const INPUT = path.join(__dirname, '../shared/chat-fixtures/inputs/teammate-messages.jsonl')
const lines = (): string[] => fs.readFileSync(INPUT, 'utf8').split('\n')
const element = (attrs: string, body: string): string => `<teammate-message ${attrs}>\n${body}\n</teammate-message>`
const record = (...elements: string[]): string => `${TEAMMATE_PREFIXES[0]}${elements.join('\n\n')}\n\nThis came from another Claude session.`

describe('teammate messages in the rich read', () => {
  it('draws each element as a teammate part, never a user bubble', () => {
    const ms = parseChatMessages(lines(), { rich: true })

    const team = ms.filter((m) => m.parts.every((p) => p.kind === 'teammate'))
    expect(team.map((m) => m.role)).toEqual(Array(6).fill('assistant'))
    expect(team[0].parts).toEqual([
      { kind: 'teammate', from: 'demo-review', color: 'blue', idle: { reason: 'available', result: 'No findings.\nThe diff is clean.' } }
    ])
    expect(team[2].parts).toEqual([
      { kind: 'teammate', from: 'demo-fix', color: 'red', idle: { reason: 'failed', failureReason: 'out of budget' } }
    ])
    expect(team[4].parts).toHaveLength(2)
    expect(team[4].parts[1]).toEqual({
      kind: 'teammate',
      from: 'demo-fix',
      color: 'yellow',
      summary: 'Already done',
      text: 'The commit already covers it.'
    })
  })

  it('keeps the same text typed by a human as the user’s own', () => {
    const ms = parseChatMessages(lines(), { rich: true })

    const users = ms.filter((m) => m.role === 'user').map((m) => (m.parts[0].kind === 'text' ? m.parts[0].text : ''))
    expect(users.filter((t) => t.includes('<teammate-message'))).toHaveLength(3)
  })

  it('indexes a teammate message as its Agent message chip for the find bar', () => {
    const rec = { type: 'user', message: { role: 'user', content: record(element('teammate_id="a1"', 'Done.')) } }

    const found = parseTranscriptLines(JSON.stringify(rec))

    expect(found).toEqual([
      { role: 'tool', text: '$ Agent message a1' },
      { role: 'tool', text: 'Done.' }
    ])
  })
})

describe('teammateElements', () => {
  it('accepts every frame line the CLI writes', () => {
    for (const prefix of TEAMMATE_PREFIXES) {
      const content = `${prefix}${element('teammate_id="a1"', 'hi')}`

      expect(teammateElements({}, content)).toEqual([{ from: 'a1', text: 'hi' }])
    }
  })

  it('refuses a record with any origin, or a human prompt source', () => {
    const content = record(element('teammate_id="a1"', 'hi'))

    expect(teammateElements({ origin: null }, content)).toBeNull()
    expect(teammateElements({ origin: { kind: 'peer' } }, content)).toBeNull()
    expect(teammateElements({ promptSource: 'typed' }, content)).toBeNull()
    expect(teammateElements({ promptSource: 'system' }, content)).not.toBeNull()
  })

  it('decodes attribute entities in one pass', () => {
    const content = record(element('teammate_id="a1" summary="&amp;quot; &lt;b&gt; it&apos;s"', 'x'))

    expect(teammateElements({}, content)?.[0].summary).toBe("&quot; <b> it's")
  })

  it('marks an unverified sender', () => {
    const content = record(element('teammate_id="a1" verified="false"', 'x'))

    expect(teammateElements({}, content)?.[0].unverified).toBe(true)
  })

  it('does not cut a body that quotes the close tag, and drops the trailer', () => {
    const content = record(element('teammate_id="a1"', 'see </teammate-message> here'), element('teammate_id="a2"', 'two'))

    expect(teammateElements({}, content)).toEqual([
      { from: 'a1', text: 'see </teammate-message> here' },
      { from: 'a2', text: 'two' }
    ])
  })

  it('needs at least one element with a teammate_id', () => {
    expect(teammateElements({}, `${TEAMMATE_PREFIXES[0]}nothing`)).toBeNull()
    expect(teammateElements({}, record(element('color="red"', 'x')))).toBeNull()
    expect(teammateElements({}, `${TEAMMATE_PREFIXES[0]}<teammate-message teammate_id="a1">\nno close`)).toBeNull()
  })
})

describe('readIdleNotification', () => {
  it('reads the fields it knows and drops a reason it does not', () => {
    const body = JSON.stringify({
      type: 'idle_notification',
      from: 'a1',
      timestamp: 't',
      idleReason: 'napping',
      summary: 'Last thing\nsecond line',
      completedTaskId: '7',
      result: '  report  '
    })

    expect(readIdleNotification(body)).toEqual({ summary: 'Last thing', taskId: '7', result: 'report' })
  })

  it('is not one for any other JSON or text', () => {
    expect(readIdleNotification('{"type":"task_assignment","from":"a1"}')).toBeNull()
    expect(readIdleNotification('{"type":"idle_notification"}')).toBeNull()
    expect(readIdleNotification('{not json')).toBeNull()
    expect(readIdleNotification('plain text')).toBeNull()
  })
})
