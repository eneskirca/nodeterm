import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { testTmpDir } from './test-tmp'
import {
  DURABLE_STATE_DIR,
  DURABLE_STATE_MAX_BYTES,
  DurableFactFile,
  flushAllDurableFactsSync,
  type DurableFactSpec
} from './durable-state'

/**
 * The storage every durable orchestration fact shares. The properties a boot depends on: a file
 * written by one instance is read by the next; a hostile or corrupt file starts the fact EMPTY with
 * a warning and never throws; a record the sanitizer refuses is dropped, never repaired.
 */

interface Rec {
  id: string
  n: number
}

const SPEC: DurableFactSpec<Rec> = {
  kind: 'test-fact',
  version: 1,
  maxRecords: 3,
  sanitize: (raw) => {
    const r = raw as Partial<Rec> | null
    return r && typeof r.id === 'string' && typeof r.n === 'number' ? { id: r.id, n: r.n } : null
  }
}

function harness() {
  const dir = testTmpDir('nt-durable-')
  const warnings: string[] = []
  const make = (): DurableFactFile<Rec> =>
    new DurableFactFile(SPEC, { userDataDir: dir, warn: (m) => warnings.push(m), debounceMs: 1 })
  const file = path.join(dir, DURABLE_STATE_DIR, 'test-fact.json')
  return { dir, warnings, make, file }
}

describe('DurableFactFile', () => {
  it('round-trips across instances (write → new instance → read)', async () => {
    const h = harness()
    const a = h.make()
    a.save([{ id: 'a', n: 1 }, { id: 'b', n: 2 }])
    await a.flush()
    expect(h.make().load()).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 2 }])
    expect(h.warnings).toEqual([])
  })

  it('an absent file is an empty fact, silently', () => {
    const h = harness()
    expect(h.make().load()).toEqual([])
    expect(h.warnings).toEqual([])
  })

  it('flushSync writes what the debounce still holds (the quit path)', () => {
    const h = harness()
    const a = new DurableFactFile(SPEC, { userDataDir: h.dir, debounceMs: 60_000 })
    a.save([{ id: 'late', n: 9 }])
    expect(fs.existsSync(h.file)).toBe(false)
    flushAllDurableFactsSync()
    expect(h.make().load()).toEqual([{ id: 'late', n: 9 }])
    a.dispose()
  })

  it('the latest snapshot wins when saves are coalesced', async () => {
    const h = harness()
    const a = h.make()
    a.save([{ id: 'x', n: 1 }])
    a.save([{ id: 'y', n: 2 }])
    await a.flush()
    expect(h.make().load()).toEqual([{ id: 'y', n: 2 }])
  })

  it.skipIf(process.platform === 'win32')('is written 0600 (it can hold message bodies)', async () => {
    const h = harness()
    const a = h.make()
    a.save([{ id: 'a', n: 1 }])
    await a.flush()
    expect(fs.statSync(h.file).mode & 0o777).toBe(0o600)
  })

  it('a corrupt file starts empty with a warning, is set aside, and never throws', () => {
    const h = harness()
    fs.mkdirSync(path.dirname(h.file), { recursive: true })
    fs.writeFileSync(h.file, '{"kind":"test-fact", not json')
    expect(h.make().load()).toEqual([])
    expect(h.warnings.join('\n')).toMatch(/not JSON.*set aside/)
    expect(fs.existsSync(`${h.file}.corrupt`)).toBe(true)
    expect(fs.existsSync(h.file)).toBe(false)
  })

  it('a non-envelope, a foreign kind and a newer version all start empty', () => {
    const h = harness()
    fs.mkdirSync(path.dirname(h.file), { recursive: true })
    for (const body of [
      '[1,2,3]',
      'null',
      JSON.stringify({ kind: 'other', version: 1, savedAt: 0, records: [{ id: 'a', n: 1 }] }),
      JSON.stringify({ kind: 'test-fact', version: 2, savedAt: 0, records: [{ id: 'a', n: 1 }] })
    ]) {
      fs.writeFileSync(h.file, body)
      expect(h.make().load()).toEqual([])
    }
    expect(h.warnings.length).toBe(4)
  })

  it('an oversized file is refused without being parsed', () => {
    const h = harness()
    fs.mkdirSync(path.dirname(h.file), { recursive: true })
    fs.writeFileSync(h.file, 'x'.repeat(DURABLE_STATE_MAX_BYTES + 1))
    expect(h.make().load()).toEqual([])
    expect(h.warnings.join('\n')).toMatch(/set aside/)
  })

  it('drops (never repairs) malformed records, and a sanitizer that throws drops too', () => {
    const h = harness()
    fs.mkdirSync(path.dirname(h.file), { recursive: true })
    fs.writeFileSync(
      h.file,
      JSON.stringify({
        kind: 'test-fact',
        version: 1,
        savedAt: 0,
        records: [{ id: 'ok', n: 1 }, { id: 5, n: 1 }, null, 'x', { id: 'ok2', n: 2 }]
      })
    )
    const throwing = new DurableFactFile(
      { ...SPEC, sanitize: (r) => ((r as Rec)?.id === 'ok2' ? (() => { throw new Error('boom') })() : SPEC.sanitize(r)) },
      { userDataDir: h.dir, warn: (m) => h.warnings.push(m) }
    )
    expect(h.make().load()).toEqual([{ id: 'ok', n: 1 }, { id: 'ok2', n: 2 }])
    expect(throwing.load()).toEqual([{ id: 'ok', n: 1 }])
    expect(h.warnings.join('\n')).toMatch(/dropped 3 malformed/)
  })

  it('caps the list at maxRecords, keeping the newest', async () => {
    const h = harness()
    const a = h.make()
    a.save([1, 2, 3, 4, 5].map((n) => ({ id: `r${n}`, n })))
    await a.flush()
    expect(h.make().load().map((r) => r.n)).toEqual([3, 4, 5])
  })

  it('a synchronous flush is never overwritten by an OLDER async write still in flight (review repro)', async () => {
    const h = harness()
    const a = h.make()
    a.save([{ id: 'old', n: 1 }])
    const inFlight = a.flush() // async write of [old] started, not yet renamed
    a.save([{ id: 'new', n: 2 }])
    a.flushSync() // quit: [new] lands synchronously
    await inFlight
    expect(h.make().load()).toEqual([{ id: 'new', n: 2 }])
    // No temp litter left by the dropped rename.
    expect(fs.readdirSync(path.dirname(h.file)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a stood-down file neither reads nor writes (a second instance that does not own the fact)', async () => {
    const h = harness()
    const owner = h.make()
    owner.save([{ id: 'owner', n: 1 }])
    await owner.flush()
    const second = h.make()
    second.standDown()
    expect(second.load()).toEqual([])
    second.save([{ id: 'intruder', n: 2 }])
    second.flushSync()
    await second.flush()
    expect(h.make().load()).toEqual([{ id: 'owner', n: 1 }])
  })
})
