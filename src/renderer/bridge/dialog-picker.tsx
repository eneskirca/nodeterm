// Web replacement for the Electron native folder/file dialog (Server Edition).
//
// The desktop build opens a native OS picker via the preload's `dialog` namespace; the browser
// build has no such thing. Instead we browse the *server's* filesystem in-app over `fs.list`
// (Task 4) and let the user drill into directories, then either "Use this folder" (folder mode)
// or click a file (file mode). The chosen ABSOLUTE path becomes a project cwd / opened file.
//
// `nextEntries` is the pure navigation core and `createPickerFolder` the pure create step (both
// unit-tested without the DOM). The modal, the `openDirectoryPicker` promise wrapper, and
// `mountPickerRoot` wire them into `ws-bridge` / `relay-api`.
//
// FOLDER CREATION (folder mode only): the browser has no native "New Folder" button, so
// "Open folder…" in the Server Edition could only ever adopt a directory that already existed on
// the server. The button here closes that. It writes through the SAME `fs.mkdir`/`fs.exists` the
// Explorer's "New Folder…" uses (core/fs-ops.ts, wired on all three surfaces) and validates the
// typed name with the SAME envelope, `newEntryPath` — no second copy of path validation lives
// here, so `..`, absolute and empty names are refused exactly as they are in the Explorer.

import { useCallback, useEffect, useState } from 'react'
import { IconArrowUp } from '../components/icons'
import { createRoot, type Root } from 'react-dom/client'
import type { DirEntry } from '../../shared/types'
import { newEntryPath } from '../lib/explorerCreate'

export type PickerMode = 'folder' | 'file'

/** A directory entry plus its resolved absolute path (the real `DirEntry` carries only a name). */
export type PickerRow = DirEntry & { path: string }

type ListFn = (dirPath: string) => Promise<DirEntry[]>

/**
 * The write half of the picker's filesystem access. OPTIONAL at every call site: a caller with a
 * read-only fs simply omits it and the "New folder" affordance is not rendered — a hidden button
 * rather than one that can only fail.
 */
export interface PickerMkdirDeps {
  mkdir: (dirPath: string) => Promise<boolean>
  exists: (p: string) => Promise<boolean>
}

/** Outcome of the create step: the new absolute path, or a message to show inside the picker. */
export type CreateFolderResult = { ok: true; path: string } | { ok: false; error: string }

/**
 * Pure create step: validate the typed name against `newEntryPath` (the Explorer's envelope —
 * refuses empty / absolute / trailing-slash / `..` traversal), refuse an existing path, then
 * `mkdir -p`. EVERY failure carries a message; nothing here is a silent no-op. Messages mirror the
 * Explorer's word-for-word so the two create flows read as one feature.
 */
export async function createPickerFolder(
  dir: string,
  name: string,
  deps: PickerMkdirDeps
): Promise<CreateFolderResult> {
  const dest = newEntryPath(dir, name)
  if (!dest) return { ok: false, error: `Invalid name: “${name.trim()}”` }
  if (await deps.exists(dest)) return { ok: false, error: `Already exists: ${dest}` }
  if (!(await deps.mkdir(dest))) return { ok: false, error: `Could not create ${dest}` }
  return { ok: true, path: dest }
}

/** Strip a trailing slash from a path (but keep the root `/` as-is). */
function stripTrailingSlash(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, '') : dir
}

/** Join an absolute dir and a child name into an absolute path (no double slash at the root). */
function joinPath(dir: string, name: string): string {
  const base = stripTrailingSlash(dir)
  return base === '/' ? `/${name}` : `${base}/${name}`
}

/**
 * Pure navigation step: list `dir`, keep subdirectories (both modes) and — in `file` mode —
 * files too, resolve each row's absolute path, and compute the parent dir (`null` at the
 * filesystem root `/`). The modal calls this on every navigation.
 */
export async function nextEntries(
  dir: string,
  mode: PickerMode,
  list: ListFn
): Promise<{ parent: string | null; rows: PickerRow[] }> {
  const current = stripTrailingSlash(dir)
  const entries = await list(dir)
  const visible = mode === 'folder' ? entries.filter((e) => e.dir) : entries
  const rows: PickerRow[] = visible.map((e) => ({ ...e, path: joinPath(current, e.name) }))

  let parent: string | null = null
  if (current !== '/') {
    const cut = current.lastIndexOf('/')
    parent = cut <= 0 ? '/' : current.slice(0, cut)
  }
  return { parent, rows }
}

interface PickerProps {
  mode: PickerMode
  startDir: string
  list: ListFn
  /** Absent ⇒ no "New folder" affordance (see `PickerMkdirDeps`). */
  write?: PickerMkdirDeps
  onDone: (result: string | null) => void
}

function DirectoryPicker({
  mode,
  startDir,
  list,
  write,
  onDone
}: PickerProps): React.ReactElement {
  const [dir, setDir] = useState(startDir)
  const [rows, setRows] = useState<PickerRow[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Create-folder form: `creating` opens the inline name row, `createErr` is the readable
  // refusal shown under it (permission denied, a name already taken, a rejected name).
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Only folder mode can create: the file picker exists to open an existing file, and a folder
  // button there would be an affordance for a thing nobody came to do.
  const canCreate = mode === 'folder' && !!write

  const closeCreate = useCallback(() => {
    setCreating(false)
    setNewName('')
    setCreateErr(null)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    // A navigation abandons the form: a refusal naming the OLD directory must not survive into
    // the new one.
    closeCreate()
    nextEntries(dir, mode, list)
      .then((view) => {
        if (cancelled) return
        setRows(view.rows)
        setParent(view.parent)
      })
      .catch(() => {
        if (!cancelled) setError('Could not read this folder')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [dir, mode, list, closeCreate])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      // Escape backs out of the create form first; only a picker with no form open closes.
      if (creating) closeCreate()
      else onDone(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDone, creating, closeCreate])

  /**
   * Create the typed folder under the current dir and NAVIGATE INTO IT, so the list refreshes and
   * "Use this folder" already points at what was just made (create → step in → Open). A refusal
   * stays in the form with its message; the user's typed name is kept so it can be edited.
   */
  const submitCreate = useCallback(async () => {
    if (!write || busy) return
    setBusy(true)
    setCreateErr(null)
    try {
      const res = await createPickerFolder(dir, newName, write)
      if (!res.ok) {
        setCreateErr(res.error)
        return
      }
      setCreating(false)
      setNewName('')
      setDir(res.path)
    } catch {
      setCreateErr('Could not create the folder')
    } finally {
      setBusy(false)
    }
  }, [write, busy, dir, newName])

  const openRow = useCallback(
    (row: PickerRow) => {
      if (row.dir) setDir(row.path)
      else if (mode === 'file') onDone(row.path)
    },
    [mode, onDone]
  )

  return (
    <div className="confirm-overlay" onClick={() => onDone(null)}>
      <div
        className="confirm dir-picker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={mode === 'folder' ? 'Choose a folder' : 'Choose a file'}
      >
        <div className="dir-picker__head">
          <button
            className="dir-picker__up"
            onClick={() => parent && setDir(parent)}
            disabled={parent === null}
            title="Up one level"
          >
            <IconArrowUp />
          </button>
          <span className="dir-picker__path" title={dir}>
            {dir}
          </span>
          {canCreate && !creating && (
            <button
              className="dir-picker__new"
              onClick={() => {
                setCreateErr(null)
                setNewName('')
                setCreating(true)
              }}
              title="Create a folder here"
            >
              ＋ New folder
            </button>
          )}
        </div>

        {canCreate && creating && (
          <div className="dir-picker__create">
            <input
              autoFocus
              className="dir-picker__input"
              value={newName}
              placeholder="Folder name"
              aria-label="New folder name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submitCreate()
                }
                // Escape is handled by the window listener above (it backs out of this form).
              }}
            />
            <button
              className="confirm__btn primary"
              disabled={busy || !newName.trim()}
              onClick={() => void submitCreate()}
            >
              Create
            </button>
            <button className="confirm__btn" onClick={closeCreate}>
              Cancel
            </button>
          </div>
        )}
        {createErr && <div className="dir-picker__error">{createErr}</div>}

        <div className="dir-picker__list">
          {loading && <div className="dir-picker__empty">Loading…</div>}
          {!loading && error && <div className="dir-picker__empty">{error}</div>}
          {!loading && !error && rows.length === 0 && (
            <div className="dir-picker__empty">
              {mode === 'folder' ? 'No subfolders here' : 'Empty folder'}
            </div>
          )}
          {!loading &&
            !error &&
            rows.map((row) => (
              <button
                key={row.path}
                className={`dir-picker__row${row.dir ? ' is-dir' : ''}`}
                onClick={() => openRow(row)}
              >
                <span className="dir-picker__icon">{row.dir ? '📁' : '📄'}</span>
                <span className="dir-picker__name">{row.name}</span>
              </button>
            ))}
        </div>

        <div className="confirm__actions">
          <button className="confirm__btn" onClick={() => onDone(null)}>
            Cancel
          </button>
          {mode === 'folder' && (
            <button className="confirm__btn primary" onClick={() => onDone(stripTrailingSlash(dir))}>
              Use this folder
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Mount plumbing ──────────────────────────────────────────────────────────────────────────
let pickerRoot: Root | null = null

/** Create the React root container the picker renders into. Idempotent; call once from the bridge. */
export function mountPickerRoot(): void {
  if (pickerRoot || typeof document === 'undefined') return
  const container = document.createElement('div')
  container.id = 'nt-dialog-picker-root'
  document.body.appendChild(container)
  pickerRoot = createRoot(container)
}

/**
 * Open the in-app server-directory browser and resolve with the chosen ABSOLUTE path
 * (folder mode → the current dir; file mode → the clicked file) or `null` on cancel/close.
 * Never rejects — cancel resolves `null`, mirroring the native dialog's contract.
 *
 * `write` enables the "New folder" button in folder mode; omit it for a read-only picker.
 */
export function openDirectoryPicker(opts: {
  mode: PickerMode
  startDir: string
  list: ListFn
  write?: PickerMkdirDeps
}): Promise<string | null> {
  if (!pickerRoot) mountPickerRoot()
  return new Promise<string | null>((resolve) => {
    const finish = (result: string | null): void => {
      pickerRoot?.render(null)
      resolve(result)
    }
    pickerRoot?.render(
      <DirectoryPicker
        mode={opts.mode}
        startDir={opts.startDir}
        list={opts.list}
        write={opts.write}
        onDone={finish}
      />
    )
  })
}
