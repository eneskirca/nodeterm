import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createSubagentTail,
  formatSubagentChunk,
  splitCompleteLines,
  SUBAGENT_READ_CAP
} from './subagent-tail'

const assistant = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

describe('formatSubagentChunk', () => {
  it('formats assistant prose + tool_use across lines, dropping blanks/garbled', () => {
    const text = [
      assistant('hi'),
      '',
      'garbled',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } })
    ].join('\n')
    // formatLine emits assistant text verbatim ('hi') and tool_use as `$ <name> <arg>` ('$ Bash ls');
    // the chunk joins surviving lines with '\n' (mirrors the tail's read loop exactly).
    expect(formatSubagentChunk(text)).toBe('hi\n$ Bash ls')
  })
})

describe('splitCompleteLines', () => {
  it('returns everything as carry when there is no newline', () => {
    const { text, carry } = splitCompleteLines(Buffer.from('partial line'))
    expect(text).toBe('')
    expect(carry?.toString()).toBe('partial line')
  })

  it('returns everything as text when the data ends with a newline', () => {
    const { text, carry } = splitCompleteLines(Buffer.from('a\nb\n'))
    expect(text).toBe('a\nb\n')
    expect(carry).toBeNull()
  })

  it('splits at the last newline, carrying the partial tail', () => {
    const { text, carry } = splitCompleteLines(Buffer.from('a\nb\npart'))
    expect(text).toBe('a\nb\n')
    expect(carry?.toString()).toBe('part')
  })

  it('keeps a multibyte char torn across reads intact once completed', () => {
    // '✦' is 3 bytes in UTF-8; tear it in the middle as a byte-level read would.
    const whole = Buffer.from('line with ✦ mark\n')
    const first = whole.subarray(0, 12) // ends mid-✦
    const rest = whole.subarray(12)
    const r1 = splitCompleteLines(first)
    expect(r1.text).toBe('')
    const r2 = splitCompleteLines(Buffer.concat([r1.carry!, rest]))
    expect(r2.text).toBe('line with ✦ mark\n')
    expect(r2.carry).toBeNull()
  })
})

// --- createSubagentTail integration (real fs, 400ms tick) ---

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function setup(): { transcriptPath: string; subDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtail-'))
  const transcriptPath = path.join(dir, 'sess.jsonl')
  const subDir = path.join(dir, 'sess', 'subagents')
  fs.mkdirSync(subDir, { recursive: true })
  return { transcriptPath, subDir }
}

const streamed = (send: ReturnType<typeof vi.fn>): string =>
  send.mock.calls.map((c) => (c[0] as { chunk: string }).chunk).join('')

describe('createSubagentTail', () => {
  it('does not drop a line written torn across two reads', async () => {
    const { transcriptPath, subDir } = setup()
    fs.writeFileSync(path.join(subDir, 'agent-1.meta.json'), JSON.stringify({ toolUseId: 'tu1' }))
    const file = path.join(subDir, 'agent-1.jsonl')
    const line = assistant('torn line survives')
    fs.writeFileSync(file, line.slice(0, 25)) // first half of the line, no newline yet
    const send = vi.fn()
    const tail = createSubagentTail(send)
    tail.track('tu1', transcriptPath)
    await wait(900) // two ticks land while the line is still half-written
    fs.appendFileSync(file, line.slice(25) + '\n')
    await wait(600) // next tick reads the rest
    expect(streamed(send)).toContain('torn line survives')
    tail.finish('tu1')
  })

  it('re-checks a meta file whose toolUseId was missing on first read', async () => {
    const { transcriptPath, subDir } = setup()
    const metaPath = path.join(subDir, 'agent-1.meta.json')
    fs.writeFileSync(metaPath, '{}') // parseable but mid-write: toolUseId not there yet
    fs.writeFileSync(path.join(subDir, 'agent-1.jsonl'), assistant('late meta') + '\n')
    const send = vi.fn()
    const tail = createSubagentTail(send)
    tail.track('tu1', transcriptPath)
    await wait(600) // first tick parses {} — must not blacklist this meta
    fs.writeFileSync(metaPath, JSON.stringify({ toolUseId: 'tu1' }))
    await wait(600)
    expect(streamed(send)).toContain('late meta')
    tail.finish('tu1')
  })

  it('flushes a final line that lacks a trailing newline on finish', async () => {
    const { transcriptPath, subDir } = setup()
    fs.writeFileSync(path.join(subDir, 'agent-1.meta.json'), JSON.stringify({ toolUseId: 'tu1' }))
    fs.writeFileSync(path.join(subDir, 'agent-1.jsonl'), assistant('unterminated final line'))
    const send = vi.fn()
    const tail = createSubagentTail(send)
    tail.track('tu1', transcriptPath)
    await wait(600) // read, but held back as a partial line
    tail.finish('tu1')
    await wait(200) // finish's final read + carry flush
    expect(streamed(send)).toContain('unterminated final line')
  })
})

describe('subagent-tail read cap', () => {
  it('reads at most SUBAGENT_READ_CAP bytes per tick and continues next tick', async () => {
    expect(SUBAGENT_READ_CAP).toBe(1024 * 1024)
    const { transcriptPath, subDir } = setup()
    fs.writeFileSync(path.join(subDir, 'agent-1.meta.json'), JSON.stringify({ toolUseId: 'tu1' }))
    // One assistant line ~2.5x the cap: it can only arrive whole if the tail keeps reading
    // where the previous tick stopped.
    const text = 'x'.repeat(Math.floor(SUBAGENT_READ_CAP * 2.5))
    fs.writeFileSync(path.join(subDir, 'agent-1.jsonl'), assistant(text) + '\n')

    const send = vi.fn()
    const tail = createSubagentTail(send)
    tail.track('tu1', transcriptPath)

    // One tick in, the capped slice holds no newline, so there is no complete line to emit yet
    // — an uncapped read would have swallowed the whole file here and emitted already.
    await wait(700)
    expect(send).not.toHaveBeenCalled()

    // The remaining slices arrive on later ticks and the line lands intact.
    await vi.waitFor(() => expect(send).toHaveBeenCalled(), { timeout: 5000, interval: 50 })
    const out = streamed(send)
    // Match by shape, not toBe: a multi-MB diff on failure is unreadable (and slow).
    expect(out.length).toBe(text.length + 1)
    expect(/^x+\n$/.test(out)).toBe(true)

    tail.finish('tu1')
    fs.rmSync(path.dirname(transcriptPath), { recursive: true, force: true })
  })
})
