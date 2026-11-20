import { create } from 'zustand'

/**
 * The "Uploading foo.zip…" overlay a terminal shows while dropped/pasted files are on their way
 * to it (an scp to an SSH host, or clipboard bytes being written to disk).
 *
 * It lives HERE, keyed by the session-scoped terminal key, and not in the component that started
 * the upload, because the upload outlives that component: a project switch unmounts the node, the
 * scp keeps running in main, and component state would come back empty on the way back — the
 * overlay was gone while the transfer was still going, which read as "the upload was cancelled".
 * The same key is read by the canvas node AND the kanban card modal, so one session seen twice
 * shows one upload.
 */
export interface UploadNote {
  text: string
  /** A brief failure flash rather than progress — no spinner, cleared by a timer. */
  failed?: boolean
}

/** How long a failure stays on screen before it clears itself. */
export const UPLOAD_FAIL_FLASH_MS = 2500

interface UploadNotesState {
  byKey: Record<string, UploadNote>
}

export const useUploadNotes = create<UploadNotesState>(() => ({ byKey: {} }))

// Which upload owns a key's note right now. A second drop on the same terminal takes the note
// over, and the first one finishing must not then clear (or fail-flash over) the second's.
const owners = new Map<string, number>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let nextToken = 1

function put(key: string, note: UploadNote | null): void {
  useUploadNotes.setState((s) => {
    if (!note) {
      if (!(key in s.byKey)) return s
      const { [key]: _gone, ...rest } = s.byKey
      return { byKey: rest }
    }
    return { byKey: { ...s.byKey, [key]: note } }
  })
}

function cancelTimer(key: string): void {
  const t = timers.get(key)
  if (t) clearTimeout(t)
  timers.delete(key)
}

export interface UploadNoteHandle {
  /** The transfer finished and produced something: clear the note. */
  done(): void
  /** Nothing made it: flash `text` for `UPLOAD_FAIL_FLASH_MS`, then clear. */
  fail(text: string): void
}

/** Show `text` on the terminal `key` until the returned handle settles it. */
export function startUploadNote(key: string, text: string): UploadNoteHandle {
  const token = nextToken++
  owners.set(key, token)
  cancelTimer(key)
  put(key, { text })
  const mine = (): boolean => owners.get(key) === token
  return {
    done() {
      if (!mine()) return
      owners.delete(key)
      put(key, null)
    },
    fail(failText) {
      if (!mine()) return
      put(key, { text: failText, failed: true })
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key)
          if (!mine()) return
          owners.delete(key)
          put(key, null)
        }, UPLOAD_FAIL_FLASH_MS)
      )
    }
  }
}

/** The progress line for a set of files on their way to a remote host. */
export function uploadingLabel(files: readonly { name: string }[]): string {
  return `Uploading ${files.length === 1 ? files[0].name : `${files.length} files`}…`
}
