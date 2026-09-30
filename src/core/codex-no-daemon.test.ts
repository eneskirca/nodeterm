// `--no-daemon` detection, read off REAL `codex --help` pages captured for this change
// (src/core/__fixtures__/codex-daemon/, see its README for the measurement they came from).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { codexNoDaemonFrom } from './codex-cli'

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', 'codex-daemon', name), 'utf8').replace(/\r\n/g, '\n')

describe('codexNoDaemonFrom', () => {
  it('reads the flag off 0.159.2 (daemon_auto_start stable, on)', () => {
    expect(codexNoDaemonFrom(fixture('help-0.159.2.txt'))).toBe(true)
  })

  it('reads the flag off 0.156.1 too (the feature existed, off by default, and so did the flag)', () => {
    expect(codexNoDaemonFrom(fixture('help-0.156.1.txt'))).toBe(true)
  })

  it('answers false for 0.148.0, which has neither — clap would EXIT on the unknown option', () => {
    expect(codexNoDaemonFrom(fixture('help-0.148.0.txt'))).toBe(false)
  })

  it('answers null when there is no page at all (no codex, a timeout): emit nothing', () => {
    expect(codexNoDaemonFrom(null)).toBeNull()
    expect(codexNoDaemonFrom('')).toBeNull()
  })

  it('reads an option HEADER, never prose that mentions the flag', () => {
    const prose = [
      'Options:',
      '      --remote <ADDR>',
      '          Connect to a remote server; unlike --no-daemon this needs an address'
    ].join('\n')
    expect(codexNoDaemonFrom(prose)).toBe(false)
  })
})
