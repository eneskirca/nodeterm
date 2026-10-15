import { describe, expect, it } from 'vitest'
import { CWD_REPORT_MAX_CARRY, CwdReportScanner, parseCwdOsc } from './cwd-report'

describe('parseCwdOsc', () => {
  it('reads OSC 7 file URLs, percent-decoded, with a Windows drive path turned native', () => {
    expect(parseCwdOsc('7;file://host/home/me/my%20dir')).toBe('/home/me/my dir')
    expect(parseCwdOsc('7;file:///tmp')).toBe('/tmp')
    expect(parseCwdOsc('7;file://PC/C:/Users/me/src')).toBe('C:\\Users\\me\\src')
    expect(parseCwdOsc('7;file://PC/C:')).toBe('C:\\')
    expect(parseCwdOsc('7;file://h/%E2%9C%93')).toBe('/✓')
  })

  it('reads OSC 9;9 with or without quotes', () => {
    expect(parseCwdOsc('9;9;"C:\\Users\\me"')).toBe('C:\\Users\\me')
    expect(parseCwdOsc('9;9;C:\\work')).toBe('C:\\work')
  })

  it("reads VS Code's 633;P;Cwd= with its own escaping", () => {
    expect(parseCwdOsc('633;P;Cwd=C:\\\\a\\x3bb')).toBe('C:\\a;b')
    expect(parseCwdOsc('633;P;Cwd=/srv/app')).toBe('/srv/app')
  })

  it('ignores everything that is not a cwd report, and garbage inside one', () => {
    expect(parseCwdOsc('0;window title')).toBeNull()
    expect(parseCwdOsc('52;c;aGVsbG8=')).toBeNull()
    expect(parseCwdOsc('9;4;1;50')).toBeNull() // progress, not 9;9
    expect(parseCwdOsc('7;http://host/x')).toBeNull()
    expect(parseCwdOsc('7;file://host')).toBeNull()
    expect(parseCwdOsc('9;9;')).toBeNull()
    expect(parseCwdOsc('633;P;Cwd=a\x01b')).toBeNull()
    expect(parseCwdOsc('7;file://h/%E2%9')).toBe('/%E2%9') // malformed escape: kept, never thrown
  })
})

describe('CwdReportScanner', () => {
  it('finds a report terminated by BEL or by ST, and returns the last one in a chunk', () => {
    const s = new CwdReportScanner()
    expect(s.push('plain output, nothing here')).toBeUndefined()
    expect(s.push('a\x1b]7;file://h/one\x07b')).toBe('/one')
    expect(s.push('\x1b]9;9;"C:\\x"\x1b\\ then \x1b]7;file://h/two\x1b\\')).toBe('/two')
  })

  it('carries a report split across chunks, including a split ESC and a split ST', () => {
    const s = new CwdReportScanner()
    expect(s.push('prompt\x1b')).toBeUndefined()
    expect(s.push(']7;file://h/ho')).toBeUndefined()
    expect(s.push('me/me\x1b')).toBeUndefined()
    expect(s.push('\\$ ')).toBe('/home/me')
  })

  it('skips other OSCs (titles, clipboard) around a report', () => {
    const s = new CwdReportScanner()
    expect(s.push('\x1b]0;title\x07\x1b]7;file://h/w\x07\x1b]52;c;Zm9v\x07')).toBe('/w')
  })

  it('treats a new OSC before a terminator as abandoning the first', () => {
    const s = new CwdReportScanner()
    expect(s.push('\x1b]7;file://h/lost\x1b]7;file://h/kept\x07')).toBe('/kept')
  })

  it('drops an unterminated OSC that outgrows the carry cap instead of hoarding it', () => {
    const s = new CwdReportScanner()
    expect(s.push('\x1b]52;c;' + 'A'.repeat(CWD_REPORT_MAX_CARRY + 10))).toBeUndefined()
    // The oversized partial was dropped: its eventual terminator cannot resurrect it, and a later
    // report still parses.
    expect(s.push('AAAA\x07\x1b]7;file://h/after\x07')).toBe('/after')
  })
})
