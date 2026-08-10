import { describe, expect, it, vi } from 'vitest'
import { tailFromOffsetArgs, tailFromOffsetCappedArgs, tailLastBytesArgs, RemoteFile } from './remote-file'

const conn = { host: 'h', user: 'u' }
const ref = { conn, controlPath: '/s.sock', path: '/home/u/.claude/projects/p/x.jsonl' }

describe('remote-file builders', () => {
  it('tailFromOffsetArgs reads bytes after the offset (1-indexed +N)', () => {
    expect(tailFromOffsetArgs(conn, '/s.sock', '/a b.jsonl', 10).join(' '))
      .toContain(`tail -c +11 '/a b.jsonl'`)
  })
  it('tailLastBytesArgs reads the last N bytes', () => {
    expect(tailLastBytesArgs(conn, '/s.sock', '/a.jsonl', 4096).join(' ')).toContain(`tail -c 4096 '/a.jsonl'`)
  })
  it('tailFromOffsetCappedArgs caps the read and base64s it (byte-exact over a string stdout)', () => {
    expect(tailFromOffsetCappedArgs(conn, '/s.sock', '/a b.jsonl', 10, 4096).join(' '))
      .toContain(`tail -c +11 '/a b.jsonl' | head -c 4096 | base64`)
  })
})

describe('RemoteFile', () => {
  it('readFrom advances offset by the byte length of the returned text', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: 'hello\n' }))
    const rf = new RemoteFile(run)
    expect(await rf.readFrom(ref, 100)).toEqual({ text: 'hello\n', newOffset: 100 + Buffer.byteLength('hello\n') })
  })
  it('readFrom fails open: non-zero code → empty, offset unchanged', async () => {
    const rf = new RemoteFile(async () => ({ code: 1, stdout: '' }))
    expect(await rf.readFrom(ref, 100)).toEqual({ text: '', newOffset: 100 })
  })
  it('readTail returns stdout (empty on failure)', async () => {
    expect(await new RemoteFile(async () => ({ code: 0, stdout: 'X' })).readTail(ref, 10)).toBe('X')
    expect(await new RemoteFile(async () => ({ code: 1, stdout: '' })).readTail(ref, 10)).toBe('')
  })
})

// The fake host: slices the fixture BYTES exactly as `tail -c +N | head -c M` would, then
// base64-encodes — GNU's base64 wraps at 76 cols, so the wrap is reproduced here too.
function fakeHost(file: Buffer): (args: string[]) => Promise<{ code: number; stdout: string }> {
  return async (args: string[]) => {
    const m = /tail -c \+(\d+) .* \| head -c (\d+) \| base64/.exec(args.join(' '))
    if (!m) throw new Error(`unexpected command: ${args.join(' ')}`)
    const slice = file.subarray(Number(m[1]) - 1, Number(m[1]) - 1 + Number(m[2]))
    return { code: 0, stdout: (slice.toString('base64').match(/.{1,76}/g) ?? []).join('\n') + '\n' }
  }
}

describe('RemoteFile.readFromCapped', () => {
  it('decodes wrapped base64 and advances the offset by the exact decoded byte count', async () => {
    const payload = Buffer.from('x'.repeat(200) + '\n')
    const rf = new RemoteFile(fakeHost(payload))
    const { data, newOffset } = await rf.readFromCapped(ref, 0, 4096)
    expect(data.equals(payload)).toBe(true)
    expect(newOffset).toBe(payload.length)
  })

  it('fails open: non-zero code → empty buffer, offset unchanged', async () => {
    const rf = new RemoteFile(async () => ({ code: 1, stdout: 'garbage' }))
    const { data, newOffset } = await rf.readFromCapped(ref, 100, 4096)
    expect(data.length).toBe(0)
    expect(newOffset).toBe(100)
  })

  it('fails open: a thrown run → empty buffer, offset unchanged', async () => {
    const rf = new RemoteFile(async () => {
      throw new Error('ssh died')
    })
    const { data, newOffset } = await rf.readFromCapped(ref, 100, 4096)
    expect(data.length).toBe(0)
    expect(newOffset).toBe(100)
  })

  it('byte-exact: a multibyte char split by the cap reassembles across two reads', async () => {
    // 'é' is 2 bytes; the cap lands between them. A decoded-string read would turn the torn
    // halves into U+FFFD (3 bytes each) and drift the offset — base64 round-trips the bytes.
    const file = Buffer.from('aé-tail\n', 'utf-8')
    const cap = 2 // cuts mid-'é'
    const rf = new RemoteFile(fakeHost(file))
    const chunks: Buffer[] = []
    let offset = 0
    for (let i = 0; i < 10 && offset < file.length; i++) {
      const r = await rf.readFromCapped(ref, offset, cap)
      expect(r.newOffset).toBe(offset + r.data.length)
      offset = r.newOffset
      chunks.push(r.data)
    }
    expect(offset).toBe(file.length)
    expect(Buffer.concat(chunks).equals(file)).toBe(true)
    expect(Buffer.concat(chunks).toString('utf-8')).toBe('aé-tail\n')
  })
})
