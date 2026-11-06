import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NOTE_TEXT_MAX, parsePullNoteInput, PullNotesStore } from './pull-notes-store'

let userDataDir: string
const note = { repository: 'o/r', pullNumber: 7, path: 'src/a.ts', side: 'RIGHT' as const, line: 3, text: 'rename this' }

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-pull-notes-'))
})

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('PullNotesStore', () => {
  it('adds and lists notes per PR, oldest first', async () => {
    const store = new PullNotesStore(userDataDir)
    await store.add(note, 1)
    const after = await store.add({ ...note, line: 9, text: 'second' }, 2)
    expect(after.map((n) => [n.line, n.text, n.createdAt])).toEqual([[3, 'rename this', 1], [9, 'second', 2]])
    expect(after[0]).toMatchObject({ path: 'src/a.ts', side: 'RIGHT' })
    expect(after[0].id).toEqual(expect.any(String))
    expect(await store.list('o/r', 7)).toEqual(after)
    expect(await store.list('o/r', 8)).toEqual([])
  })

  it('deletes one note, the named ones, or all of a PR', async () => {
    const store = new PullNotesStore(userDataDir)
    await store.add(note)
    await store.add({ ...note, line: 4 })
    const [a, b] = await store.add({ ...note, line: 5 })
    expect((await store.remove('o/r', 7, [a.id])).map((n) => n.line)).toEqual([4, 5])
    expect((await store.remove('o/r', 7, [b.id, 'gone'])).map((n) => n.line)).toEqual([5])
    expect(await store.remove('o/r', 7)).toEqual([])
  })

  it('survives a restart: a new store reads the same file', async () => {
    const first = new PullNotesStore(userDataDir)
    const added = await first.add(note)
    await first.add({ ...note, repository: 'o/other', pullNumber: 1 })
    const second = new PullNotesStore(userDataDir)
    expect(await second.list('o/r', 7)).toEqual(added)
    expect((await second.list('o/other', 1)).length).toBe(1)
    const raw = JSON.parse(await fs.readFile(path.join(userDataDir, 'pull-notes.json'), 'utf8'))
    expect(Object.keys(raw.pulls).sort()).toEqual(['o/other#1', 'o/r#7'])
  })

  it('serializes concurrent writes', async () => {
    const store = new PullNotesStore(userDataDir)
    await Promise.all([1, 2, 3, 4].map((line) => store.add({ ...note, line })))
    expect((await new PullNotesStore(userDataDir).list('o/r', 7)).map((n) => n.line).sort()).toEqual([1, 2, 3, 4])
  })

  it('reads a corrupt file as empty', async () => {
    await fs.writeFile(path.join(userDataDir, 'pull-notes.json'), '{not json')
    expect(await new PullNotesStore(userDataDir).list('o/r', 7)).toEqual([])
  })

  it('refuses a bad repository or number', async () => {
    const store = new PullNotesStore(userDataDir)
    await expect(store.list('not a repo', 7)).rejects.toThrow('invalid-note-input')
    await expect(store.remove('o/r', 0)).rejects.toThrow('invalid-note-input')
  })
})

describe('parsePullNoteInput', () => {
  it('keeps only the known fields of a good input', () => {
    expect(parsePullNoteInput({ ...note, extra: 1 })).toEqual(note)
  })
  it.each([
    ['a bad repository', { repository: '../x' }],
    ['a zero PR number', { pullNumber: 0 }],
    ['an empty path', { path: '' }],
    ['a too-long path', { path: 'a'.repeat(1_025) }],
    ['a bad side', { side: 'UP' }],
    ['a non-numeric line', { line: '3' }],
    ['a zero line', { line: 0 }],
    ['a blank text', { text: '  ' }],
    ['a too-long text', { text: 'a'.repeat(NOTE_TEXT_MAX + 1) }]
  ])('refuses %s', (_name, patch) => {
    expect(parsePullNoteInput({ ...note, ...patch })).toBeNull()
  })
  it('refuses a non-object', () => {
    expect(parsePullNoteInput('x')).toBeNull()
    expect(parsePullNoteInput(null)).toBeNull()
  })
})
