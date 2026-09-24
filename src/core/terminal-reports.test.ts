import { describe, expect, it } from 'vitest'
import { isTerminalReport } from './terminal-reports'

describe('isTerminalReport', () => {
  it.each([
    ['primary DA', '\x1b[?1;2c'],
    ['secondary DA', '\x1b[>0;276;0c'],
    ['cursor position', '\x1b[24;80R'],
    ['device status', '\x1b[0n'],
    ['mode report', '\x1b[?2004;1$y'],
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
    ['cell size', '\x1b[6;17;8t'],
    ['kitty flags', '\x1b[?0u'],
    ['OSC colour (BEL)', '\x1b]11;rgb:0000/0000/0000\x07'],
    ['OSC colour (ST)', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'],
    ['DCS reply', '\x1bP1$r0m\x1b\\'],
    ['several replies in one write', '\x1b[?1;2c\x1b[24;80R\x1b]11;rgb:0/0/0\x07']
  ])('%s is a report', (_label, data) => {
    expect(isTerminalReport(data)).toBe(true)
  })

  it.each([
    ['a letter', 'a'],
    ['enter', '\r'],
    ['ctrl-c', '\x03'],
    ['arrow key', '\x1b[A'],
    ['application-mode arrow', '\x1bOA'],
    ['kitty key event', '\x1b[97;5u'],
    ['SGR mouse press', '\x1b[<0;10;5M'],
    ['bracketed paste', '\x1b[200~hello\x1b[201~'],
    ['report followed by a keystroke', '\x1b[?1;2cx'],
    ['empty write', '']
  ])('%s is activity (or nothing)', (_label, data) => {
    expect(isTerminalReport(data)).toBe(false)
  })
})
