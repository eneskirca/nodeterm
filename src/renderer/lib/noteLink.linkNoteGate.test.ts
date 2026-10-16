// Issue #1144: the context-link discovery note (and a sticky pushed over a note link) is typed only
// into an idle agent at an EMPTY prompt. This file pins the renderer half of the gate and the strip
// that names every skipped endpoint; core's empty-composer proof is pty-manager.empty-prompt.test.ts.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { linkNoteRefusal, linkNoteSkippedNotice } from './noteLink'

describe('linkNoteRefusal (#1144)', () => {
  it('lets an idle (done) or not-yet-reported claude through to the composer check', () => {
    expect(linkNoteRefusal('claude', { state: 'done' })).toBeNull()
    expect(linkNoteRefusal('claude', {})).toBeNull()
  })

  it('never into a busy agent', () => {
    expect(linkNoteRefusal('claude', { state: 'working' })).toBe('working')
  })

  it('never into blocked/waiting — the Enter would ANSWER the permission prompt or question', () => {
    expect(linkNoteRefusal('claude', { state: 'blocked' })).toBe('dialog')
    expect(linkNoteRefusal('claude', { state: 'waiting' })).toBe('dialog')
  })

  it('never into a pane the CLI has left — the note would run as a shell command', () => {
    expect(linkNoteRefusal('claude', { state: 'done', hibernated: true })).toBe('asleep')
    expect(linkNoteRefusal('claude', { state: 'done', paused: true })).toBe('paused')
    expect(linkNoteRefusal('claude', { state: 'done', dropped: true })).toBe('dropped')
    expect(linkNoteRefusal('claude', { sessionEnded: true })).toBe('exited')
  })

  it('an agent whose composer cannot be read is refused: emptiness cannot be proven', () => {
    for (const a of ['codex', 'gemini', 'opencode', 'grok']) expect(linkNoteRefusal(a, { state: 'done' })).toBe('unsupported')
  })
})

describe('linkNoteSkippedNotice (#1144)', () => {
  it('says nothing when every note was delivered', () => {
    expect(linkNoteSkippedNotice('context', [])).toBeNull()
  })

  it('names every skipped endpoint with its reason in one info strip', () => {
    const n = linkNoteSkippedNotice('context', [
      { title: 'Alpha', reason: 'draft' },
      { title: 'Beta', reason: 'dialog' }
    ])
    expect(n?.kind).toBe('info')
    expect(n?.text).toContain('"Alpha" (its input already has text in it)')
    expect(n?.text).toContain('"Beta" (it is waiting for your answer)')
    expect(n?.text).toContain('get-linked-context')
  })

  it('a note that may have been left unsubmitted in the input is an error', () => {
    expect(linkNoteSkippedNotice('note', [{ title: 'A', reason: 'not-submitted' }])?.kind).toBe('error')
  })

  it('a title cannot break the strip onto several lines', () => {
    expect(linkNoteSkippedNotice('note', [{ title: 'a\nb', reason: 'draft' }])?.text).not.toContain('\n')
  })
})

describe('Canvas link-note wiring (#1144)', () => {
  const src = readFileSync(join(__dirname, '../canvas/Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

  it('link notes reach a pane only through the empty-prompt write, never a raw sendText', () => {
    const start = src.indexOf('const pushLinkNote = useCallback(')
    const end = src.indexOf("  // Right-click a context link: pick its direction")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).toContain('api.pty.sendToEmptyPrompt(')
    expect(block).toContain('linkNoteRefusal(')
    expect(block).not.toMatch(/pty\.sendText\(/)
  })
})
