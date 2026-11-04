// Notes for agents (F-07): one atomic JSON file under userData, keyed `<repository>#<number>`.
// Machine-local on purpose: never git-shared, never in project.json (see shared/pull-notes.ts).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PullNote, PullNoteInput } from '../../shared/pull-notes'
import { writeFileAtomic } from '../fs-atomic'
import { parseGitHubRepository } from './config'

const FILE_NAME = 'pull-notes.json'
export const NOTE_PATH_MAX = 1_024
export const NOTE_TEXT_MAX = 4_000
export const NOTES_PER_PULL_MAX = 200

type NotesFile = { version: 1; pulls: Record<string, PullNote[]> }

const validPull = (repository: unknown, pullNumber: unknown): repository is string =>
  typeof repository === 'string' && parseGitHubRepository(repository) === repository &&
  Number.isSafeInteger(pullNumber) && (pullNumber as number) > 0

/** The store key, or null for a bad repository / number. */
export function pullNoteKey(repository: unknown, pullNumber: unknown): string | null {
  return validPull(repository, pullNumber) ? `${repository}#${pullNumber as number}` : null
}

/** The input with only its known fields, or null when any is missing, the wrong type, or too long. */
export function parsePullNoteInput(value: unknown): PullNoteInput | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!pullNoteKey(v.repository, v.pullNumber)) return null
  if (typeof v.path !== 'string' || !v.path || v.path.length > NOTE_PATH_MAX) return null
  if (v.side !== 'LEFT' && v.side !== 'RIGHT') return null
  if (!Number.isSafeInteger(v.line) || (v.line as number) < 1) return null
  if (typeof v.text !== 'string' || !v.text.trim() || v.text.length > NOTE_TEXT_MAX) return null
  return {
    repository: v.repository as string, pullNumber: v.pullNumber as number,
    path: v.path, side: v.side, line: v.line as number, text: v.text
  }
}

function validNote(value: unknown): value is PullNote {
  if (!value || typeof value !== 'object') return false
  const note = value as PullNote
  return typeof note.id === 'string' && note.id.length > 0 && note.id.length <= 64 &&
    Number.isSafeInteger(note.createdAt) &&
    !!parsePullNoteInput({ ...note, repository: 'o/r', pullNumber: 1 })
}

function validFile(value: unknown): value is NotesFile {
  if (!value || typeof value !== 'object') return false
  const file = value as NotesFile
  return file.version === 1 && !!file.pulls && typeof file.pulls === 'object' &&
    Object.values(file.pulls).every((notes) => Array.isArray(notes) && notes.every(validNote))
}

export class PullNotesStore {
  private file: Promise<NotesFile> | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly userDataDir: string) {}

  private get filePath(): string {
    return path.join(this.userDataDir, FILE_NAME)
  }

  // ponytail: an unreadable or invalid file reads as empty, and the next write replaces it.
  private load(): Promise<NotesFile> {
    this.file ??= fs.readFile(this.filePath, 'utf-8')
      .then((raw): NotesFile => { const parsed: unknown = JSON.parse(raw); return validFile(parsed) ? parsed : { version: 1, pulls: {} } })
      .catch((): NotesFile => ({ version: 1, pulls: {} }))
    return this.file
  }

  async list(repository: string, pullNumber: number): Promise<PullNote[]> {
    const key = pullNoteKey(repository, pullNumber)
    if (!key) throw new Error('invalid-note-input')
    await this.queue
    return [...((await this.load()).pulls[key] ?? [])]
  }

  add(input: PullNoteInput, now = Date.now()): Promise<PullNote[]> {
    const { repository, pullNumber, ...rest } = input
    return this.mutate(repository, pullNumber, (notes) =>
      [...notes, { id: randomUUID(), ...rest, createdAt: now }].slice(-NOTES_PER_PULL_MAX))
  }

  /** Removes the notes named, or all of the PR's notes when `ids` is absent. */
  remove(repository: string, pullNumber: number, ids?: readonly string[]): Promise<PullNote[]> {
    return this.mutate(repository, pullNumber, (notes) => ids ? notes.filter((note) => !ids.includes(note.id)) : [])
  }

  private mutate(repository: string, pullNumber: number, change: (notes: PullNote[]) => PullNote[]): Promise<PullNote[]> {
    const key = pullNoteKey(repository, pullNumber)
    if (!key) return Promise.reject(new Error('invalid-note-input'))
    const run = this.queue.then(async () => {
      const file = await this.load()
      const notes = change(file.pulls[key] ?? [])
      const pulls = { ...file.pulls, [key]: notes }
      if (!notes.length) delete pulls[key]
      const next: NotesFile = { version: 1, pulls }
      await fs.mkdir(this.userDataDir, { recursive: true })
      await writeFileAtomic(this.filePath, JSON.stringify(next))
      this.file = Promise.resolve(next)
      return [...notes]
    })
    this.queue = run.catch(() => {})
    return run
  }
}
