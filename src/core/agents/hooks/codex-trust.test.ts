import { readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { testTmpDir } from '../../test-tmp'
import {
  assertTomlTablesUnique,
  computeTrustKey,
  computeTrustedHash,
  readHookTrustEntries,
  removeHookTrustEntries,
  tableHeaderPath,
  upsertHookTrustEntriesInContent,
  type CodexTrustEntry
} from './codex-trust'

describe('tableHeaderPath', () => {
  it('decodes basic, literal and bare segments to the same key', () => {
    const key = 'C:\\Users\\u\\.codex\\hooks.json:stop:0:0'
    expect(tableHeaderPath(`[hooks.state."C:\\\\Users\\\\u\\\\.codex\\\\hooks.json:stop:0:0"]`)).toEqual([
      'hooks',
      'state',
      key
    ])
    expect(tableHeaderPath(`[hooks.state.'${key}']`)).toEqual(['hooks', 'state', key])
    expect(tableHeaderPath(`  [ hooks . "state" . '${key}' ]  # note`)).toEqual(['hooks', 'state', key])
    expect(tableHeaderPath('[hooks.state."caf\\u00e9"]')).toEqual(['hooks', 'state', 'café'])
  })

  it('is null for arrays of tables, keys and malformed headers', () => {
    expect(tableHeaderPath('[[profiles]]')).toBeNull()
    expect(tableHeaderPath('model = "x"')).toBeNull()
    expect(tableHeaderPath('[hooks.state."open]')).toBeNull()
    expect(tableHeaderPath('[a] trailing')).toBeNull()
  })
})

describe('assertTomlTablesUnique', () => {
  it('throws on one table spelled two ways', () => {
    const toml = `[hooks.state.'/h/hooks.json:stop:0:0']\nenabled = true\n\n[hooks.state."/h/hooks.json:stop:0:0"]\nenabled = true\n`
    expect(() => assertTomlTablesUnique(toml)).toThrow(/defined twice/)
  })

  it('accepts repeated arrays of tables and headers inside multi-line strings', () => {
    const toml = `[[p]]\na = 1\n[[p]]\na = 2\n[x]\ns = """\n[x]\n"""\n`
    expect(() => assertTomlTablesUnique(toml)).not.toThrow()
  })
})

describe('upsertHookTrustEntriesInContent', () => {
  const entry: CodexTrustEntry = {
    sourcePath: '/nonexistent/h/hooks.json',
    eventLabel: 'stop',
    groupIndex: 0,
    handlerIndex: 0,
    command: 'sh /x'
  }

  it('rewrites a literal-quoted table in place instead of appending a second one', () => {
    const before = `model = "o4"\n\n[hooks.state.'/nonexistent/h/hooks.json:stop:0:0']\nenabled = false\ntrusted_hash = "sha256:00"\n`
    const after = upsertHookTrustEntriesInContent(before, [entry])
    expect(after.match(/\[hooks\.state\./g)).toHaveLength(1)
    expect(after).toContain('enabled = false') // a user's disable survives
    expect(after).not.toContain('sha256:00')
    expect(() => assertTomlTablesUnique(after)).not.toThrow()
  })

  it('refuses to hand back a config it changed that defines a table twice', () => {
    const before = `[other]\na = 1\n[other]\nb = 2\n`
    expect(() => upsertHookTrustEntriesInContent(before, [entry])).toThrow(/defined twice/)
  })
})

// Why: Codex's own /hooks flow writes the table key as a TOML literal string
// ([hooks.state.'C:\x\hooks.json:stop:0:0']) while we write a basic string
// ([hooks.state."C:\\x\\hooks.json:stop:0:0"]). Both spell the same key, so
// missing one form made install() append a second table and Codex refused the
// whole config.toml with a duplicate-key error on the next launch.
describe('codex trust blocks written as TOML literal-string keys', () => {
  let dir: string
  let entry: CodexTrustEntry
  let key: string
  let hash: string

  beforeEach(() => {
    dir = testTmpDir('nt-codex-trust-')
    const sourcePath = path.join(dir, 'hooks.json')
    writeFileSync(sourcePath, '{}')
    entry = { sourcePath, eventLabel: 'stop', groupIndex: 0, handlerIndex: 0, command: 'hook' }
    key = computeTrustKey(entry)
    hash = computeTrustedHash(entry)
  })

  const literalBlock = (enabled: boolean): string =>
    `[hooks.state.'${key}']\nenabled = ${enabled}\ntrusted_hash = "${hash}"\n`

  const headerCount = (content: string): number =>
    content.split('\n').filter((line) => line.startsWith('[hooks.state.')).length

  it('upsert collapses a literal and a basic copy of the same key into one block', () => {
    const basic = upsertHookTrustEntriesInContent('', [entry])
    const updated = upsertHookTrustEntriesInContent(`${literalBlock(true)}\n${basic}`, [entry])
    expect(headerCount(updated)).toBe(1)
  })

  it('readHookTrustEntries reports a literal-key block', () => {
    const configPath = path.join(dir, 'config.toml')
    writeFileSync(configPath, literalBlock(true))
    expect(readHookTrustEntries(configPath).get(key)).toEqual({ trustedHash: hash, enabled: true })
  })

  it('removeHookTrustEntries removes a literal-key block', () => {
    const configPath = path.join(dir, 'config.toml')
    writeFileSync(configPath, `[tui]\nx = 1\n\n${literalBlock(true)}`)
    removeHookTrustEntries(configPath, [key])
    expect(headerCount(readFileSync(configPath, 'utf8').replace(/\r\n/g, '\n'))).toBe(0)
  })
})
