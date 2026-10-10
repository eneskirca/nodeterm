import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeTrustKey,
  computeTrustedHash,
  readHookTrustEntries,
  removeHookTrustEntries,
  upsertHookTrustEntriesInContent,
  type CodexTrustEntry
} from './codex-trust'

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
    dir = mkdtempSync(path.join(tmpdir(), 'nt-codex-trust-'))
    const sourcePath = path.join(dir, 'hooks.json')
    writeFileSync(sourcePath, '{}')
    entry = { sourcePath, eventLabel: 'stop', groupIndex: 0, handlerIndex: 0, command: 'hook' }
    key = computeTrustKey(entry)
    hash = computeTrustedHash(entry)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const literalBlock = (enabled: boolean): string =>
    `[hooks.state.'${key}']\nenabled = ${enabled}\ntrusted_hash = "${hash}"\n`

  const headerCount = (content: string): number =>
    content.split('\n').filter((line) => line.startsWith('[hooks.state.')).length

  it('upsert replaces a literal-key block instead of appending a duplicate', () => {
    const updated = upsertHookTrustEntriesInContent(`[tui]\nx = 1\n\n${literalBlock(true)}`, [entry])
    expect(headerCount(updated)).toBe(1)
    expect(updated).toContain(`trusted_hash = "${hash}"`)
    expect(updated).toContain('[tui]\nx = 1\n')
  })

  it('upsert collapses a literal and a basic copy of the same key into one block', () => {
    const basic = upsertHookTrustEntriesInContent('', [entry])
    const updated = upsertHookTrustEntriesInContent(`${literalBlock(true)}\n${basic}`, [entry])
    expect(headerCount(updated)).toBe(1)
  })

  it('upsert keeps enabled = false from a literal-key block', () => {
    const updated = upsertHookTrustEntriesInContent(literalBlock(false), [entry])
    expect(headerCount(updated)).toBe(1)
    expect(updated).toContain('enabled = false')
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
