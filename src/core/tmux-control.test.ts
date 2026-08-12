import { describe, it, expect } from 'vitest'
import { createControlDecoder, decodeOctal, encodeSendKeysHex } from './tmux-control'

describe('decodeOctal', () => {
  it('decodes tmux %output octal escapes back to bytes', () => {
    expect(decodeOctal('hello\\012world\\033[31m')).toBe('hello\nworld\x1b[31m')
  })
  it('passes plain text through untouched', () => {
    expect(decodeOctal('just text')).toBe('just text')
  })
  it('keeps a literal backslash that is not an octal escape', () => {
    expect(decodeOctal('a\\\\b')).toBe('a\\b')
  })
})

describe('createControlDecoder', () => {
  it('emits an output event per %output line, pane id preserved', () => {
    const d = createControlDecoder()
    const ev = d.push('%output %3 abc\\012\n')
    expect(ev).toEqual([{ kind: 'output', paneId: '%3', data: 'abc\n' }])
  })
  it('buffers partial lines across pushes', () => {
    const d = createControlDecoder()
    expect(d.push('%output %3 ab')).toEqual([])
    expect(d.push('c\n')).toEqual([{ kind: 'output', paneId: '%3', data: 'abc' }])
  })
  it('collects a %begin/%end block into one ok reply with its body', () => {
    const d = createControlDecoder()
    const ev = d.push('%begin 100 7 0\nline1\nline2\n%end 100 7 0\n')
    expect(ev).toEqual([{ kind: 'reply', num: 7, ok: true, body: ['line1', 'line2'] }])
  })
  it('collects a %begin/%error block into one failed reply', () => {
    const d = createControlDecoder()
    const ev = d.push('%begin 100 8 0\nno such session\n%error 100 8 0\n')
    expect(ev).toEqual([{ kind: 'reply', num: 8, ok: false, body: ['no such session'] }])
  })
  it('keeps a body line that only looks like a terminator inside the reply body', () => {
    // tmux does NOT escape command output inside a block, so a reply carrying pane text (e.g.
    // capture-pane) can contain a line spelled exactly like `%end`. Only the OPEN block's ts+num
    // may close it — otherwise the reply truncates and every later line is parsed one block off.
    const d = createControlDecoder()
    const ev = d.push('%begin 100 7 0\n%end 99 6 0\ntail\n%end 100 7 0\n')
    expect(ev).toEqual([{ kind: 'reply', num: 7, ok: true, body: ['%end 99 6 0', 'tail'] }])
  })
  it('does not let a foreign %error close the open block', () => {
    const d = createControlDecoder()
    const ev = d.push('%begin 100 7 0\n%error 100 6 0\n%end 100 7 0\n')
    expect(ev).toEqual([{ kind: 'reply', num: 7, ok: true, body: ['%error 100 6 0'] }])
  })
  it('parses CRLF-terminated lines like LF ones, keeping an escaped CR in the payload', () => {
    const d = createControlDecoder()
    expect(d.push('%output %3 ab\\015\r\n')).toEqual([{ kind: 'output', paneId: '%3', data: 'ab\r' }])
  })
  it('reports %exit as exited', () => {
    expect(createControlDecoder().push('%exit\n')).toEqual([{ kind: 'exited' }])
  })
  it('passes unknown notifications through as other', () => {
    expect(createControlDecoder().push('%session-changed $1 nt-x\n'))
      .toEqual([{ kind: 'other', line: '%session-changed $1 nt-x' }])
  })
})

describe('encodeSendKeysHex', () => {
  it('encodes bytes as hex send-keys arguments', () => {
    expect(encodeSendKeysHex('nt-term-1', 'ls\n')).toBe('send-keys -t nt-term-1 -H 6c 73 0a')
  })
  it('encodes multi-byte UTF-8 per byte', () => {
    expect(encodeSendKeysHex('s', 'ç')).toBe('send-keys -t s -H c3 a7')
  })
})
