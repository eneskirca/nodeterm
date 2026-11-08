// Notes store edges: the per-PR cap, clearing the last note, unknown ids, a failed disk write, and
// the handlers' refusal of a bad note id. Same temp-dir style as pull-notes-store.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '../../shared/ipc'
import type { CorePlatform } from '../platform'
import { NOTES_PER_PULL_MAX, PullNotesStore } from './pull-notes-store'
import { registerPullNoteHandlers } from './handlers'

let userDataDir: string
const note = { repository: 'o/r', pullNumber: 7, path: 'src/a.ts', side: 'RIGHT' as const, line: 3, text: 'rename this' }

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-pull-notes-edge-'))
})
afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('PullNotesStore edges', () => {
  it(`keeps the newest ${NOTES_PER_PULL_MAX} notes of a PR, dropping the oldest`, async () => {
    const store = new PullNotesStore(userDataDir)
    for (let line = 1; line <= NOTES_PER_PULL_MAX + 2; line += 1) await store.add({ ...note, line })
    const notes = await store.list('o/r', 7)
    expect(notes).toHaveLength(NOTES_PER_PULL_MAX)
    expect(notes[0].line).toBe(3)
  })

  it('clearing the last note of a PR removes its key and leaves other PRs alone', async () => {
    const store = new PullNotesStore(userDataDir)
    const [kept] = await store.add({ ...note, pullNumber: 8 })
    const [only] = await store.add(note)
    expect(await store.remove('o/r', 7, [only.id])).toEqual([])
    const raw = JSON.parse(await fs.readFile(path.join(userDataDir, 'pull-notes.json'), 'utf8'))
    expect(Object.keys(raw.pulls)).toEqual(['o/r#8'])
    expect(await store.list('o/r', 8)).toEqual([kept])
  })

  it('deleting an id the PR does not have, or one of another PR, changes nothing', async () => {
    const store = new PullNotesStore(userDataDir)
    const [other] = await store.add({ ...note, pullNumber: 8 })
    const before = await store.add(note)
    expect(await store.remove('o/r', 7, ['no-such-id', other.id])).toEqual(before)
    expect(await store.list('o/r', 8)).toEqual([other])
  })

  it('clearing a PR with no notes answers empty', async () => {
    expect(await new PullNotesStore(userDataDir).remove('o/r', 7)).toEqual([])
  })

  it('a list is a copy: changing it does not change the store', async () => {
    const store = new PullNotesStore(userDataDir)
    await store.add(note)
    const listed = await store.list('o/r', 7)
    listed.pop()
    expect(await store.list('o/r', 7)).toHaveLength(1)
  })

  it('a write that fails rejects, keeps the last good notes, and the next write still works', async () => {
    const store = new PullNotesStore(userDataDir)
    await store.add(note)
    // A directory where the file goes makes the atomic rename fail.
    await fs.rm(path.join(userDataDir, 'pull-notes.json'))
    await fs.mkdir(path.join(userDataDir, 'pull-notes.json'))
    await expect(store.add({ ...note, line: 4 })).rejects.toThrow()
    expect((await store.list('o/r', 7)).map((n) => n.line)).toEqual([3])
    await fs.rm(path.join(userDataDir, 'pull-notes.json'), { recursive: true })
    expect((await store.add({ ...note, line: 5 })).map((n) => n.line)).toEqual([3, 5])
  })
})

describe('note handlers refuse a bad note id', () => {
  const setup = () => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    const platform = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers[channel] = fn } } as unknown as CorePlatform
    const store = { list: vi.fn(async () => []), add: vi.fn(async () => []), remove: vi.fn(async () => []) }
    registerPullNoteHandlers(platform, store)
    return { handlers, store }
  }

  it.each([
    ['an empty id', ''],
    ['a number', 5],
    ['an id over 64 characters', 'x'.repeat(65)],
    ['no id', undefined]
  ])('delete with %s writes nothing', async (_name, id) => {
    const { handlers, store } = setup()
    expect(() => handlers[IPC.pullNotesDelete]({ repository: 'o/r', pullNumber: 7, id })).toThrow('invalid-note-input')
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('clear with a bad id in the list, or more than 500 ids, writes nothing', async () => {
    const { handlers, store } = setup()
    expect(() => handlers[IPC.pullNotesClear]({ repository: 'o/r', pullNumber: 7, ids: ['ok', ''] })).toThrow('invalid-note-input')
    expect(() => handlers[IPC.pullNotesClear]({ repository: 'o/r', pullNumber: 7, ids: Array(501).fill('a') })).toThrow('invalid-note-input')
    expect(() => handlers[IPC.pullNotesClear]({ repository: 'o/r', pullNumber: 7, ids: 'a' })).toThrow('invalid-note-input')
    expect(() => handlers[IPC.pullNotesClear](null)).toThrow('invalid-note-input')
    expect(store.remove).not.toHaveBeenCalled()
  })
})
