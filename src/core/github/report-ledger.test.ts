import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReportLedgerStore } from './report-ledger'
import { emptyLedger } from './report-issue-core'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-report-ledger-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('the ledger round-trips', () => {
  it('reads back what it wrote', async () => {
    const store = new ReportLedgerStore(dir)
    const ledger = { seen: { abc: { issueNumber: 7, lastSpokeAt: 1_700_000 } }, filedAt: [1_700_000] }
    await store.save('project-1', ledger)
    expect(await store.load('project-1')).toEqual(ledger)
  })

  it('keeps projects apart', async () => {
    const store = new ReportLedgerStore(dir)
    await store.save('a', { seen: { x: { issueNumber: 1, lastSpokeAt: 1 } }, filedAt: [] })
    expect(await store.load('b')).toEqual(emptyLedger())
  })
})

describe('a project id never becomes a path segment', () => {
  it('cannot escape the data directory', async () => {
    // Project ids arrive from .nodeterm/project.json, which is git-shared and hand-editable, so
    // `../../..` is an id a hostile file can carry. The id is hashed, never joined.
    const store = new ReportLedgerStore(dir)
    await store.save('../../../../tmp/nt-escape', { seen: {}, filedAt: [1] })
    const written = await fs.readdir(path.join(dir, 'agent-reports'))
    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(/^[0-9a-f]{32}\.json$/)
  })

  it('an id containing a path separator still round-trips as itself', async () => {
    const store = new ReportLedgerStore(dir)
    const ledger = { seen: { k: { issueNumber: 3, lastSpokeAt: 9 } }, filedAt: [] }
    await store.save('a/b/c', ledger)
    expect(await store.load('a/b/c')).toEqual(ledger)
  })
})

describe('reads fail open — never refuse to report because a cache was unreadable', () => {
  it('answers an empty ledger when the file does not exist', async () => {
    expect(await new ReportLedgerStore(dir).load('missing')).toEqual(emptyLedger())
  })

  it('answers an empty ledger for corrupt JSON rather than throwing', async () => {
    const store = new ReportLedgerStore(dir)
    await store.save('p', { seen: {}, filedAt: [] })
    const file = path.join(dir, 'agent-reports', (await fs.readdir(path.join(dir, 'agent-reports')))[0])
    await fs.writeFile(file, '{ this is not json')
    expect(await store.load('p')).toEqual(emptyLedger())
  })

  it('drops malformed entries but keeps the sound ones', async () => {
    const store = new ReportLedgerStore(dir)
    await store.save('p', { seen: {}, filedAt: [] })
    const file = path.join(dir, 'agent-reports', (await fs.readdir(path.join(dir, 'agent-reports')))[0])
    await fs.writeFile(file, JSON.stringify({
      seen: {
        good: { issueNumber: 5, lastSpokeAt: 10 },
        badNumber: { issueNumber: 'nope', lastSpokeAt: 10 },
        missingClock: { issueNumber: 6 }
      },
      filedAt: [1, 'two', 3]
    }))
    const loaded = await store.load('p')
    expect(Object.keys(loaded.seen)).toEqual(['good'])
    expect(loaded.filedAt).toEqual([1, 3])
  })
})

describe('the file is written for this user only', () => {
  it('is mode 0600 — it records what this machine has published', async () => {
    const store = new ReportLedgerStore(dir)
    await store.save('p', { seen: {}, filedAt: [] })
    const entries = await fs.readdir(path.join(dir, 'agent-reports'))
    const stat = await fs.stat(path.join(dir, 'agent-reports', entries[0]))
    expect(stat.mode & 0o777).toBe(0o600)
  })
})
