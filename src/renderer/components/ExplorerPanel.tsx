import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DirEntry, FsApi } from '@shared/types'
import { gitignoreAdd, gitignoreHasExact, gitignoreRemove } from '@shared/gitignore'
import { useProjects } from '../state/projects'
import { useExplorer } from '../state/explorer'
import { sshFs } from '../terminal/ssh-fs'
import { useSession } from '../session/session'
import { promptDialog } from './promptDialog'
import { ancestorDirs, createTargetDir, newEntryPath, parentDir } from '../lib/explorerCreate'
import { canRevealLocally, downloadRoute, triggerBrowserDownload } from '../lib/download'
import { explorerOverlayClickCloses } from '../lib/explorerPin'
import { isBrowserRuntime } from '../bridge/runtime'
import { IconClose, IconPin, IconReload } from './icons'

export interface ExplorerPanelProps {
  onClose: () => void
  /** Open a file as an editor node. `sshFs` is true for SSH projects (the path is remote, read/
   *  written over the project's ControlMaster fs); false/omitted for local + relay projects. */
  onOpenFile: (path: string, sshFs?: boolean) => void
  /** File to reveal (expand ancestors + select + scroll). `path` is relative to the active project
   *  cwd; `nonce` increments per request so revealing the same file twice still re-fires. */
  reveal?: { path: string; nonce: number } | null
  /**
   * Docked: no scrim close, pointer-events pass through to the canvas. Default false so an
   * omitted prop stays the historical overlay. Toggle lives here; persistence lives in Canvas.
   */
  pinned?: boolean
  onTogglePin?: () => void
}

type ContextFn = (x: number, y: number, path: string, isDir: boolean, ignored?: boolean) => void
type OpenFn = (path: string) => void
type SelectFn = (path: string) => void
type DownloadFn = (path: string, isDir: boolean) => void

/** What a tree row's download button is showing right now. */
type RowDownloadState = 'running' | 'done' | 'error'

/** How long a finished row keeps its ✓ / ! before falling back to a plain ⤓. Long enough to be
 *  read after a click, short enough that a tree of them doesn't stay decorated. */
const ROW_FLASH_MS = 2200

/** Row-button tooltip per state. The failure text points at the strip, which carries the reason. */
const DL_TITLE: Record<RowDownloadState, string> = {
  running: 'Downloading…',
  done: 'Downloaded',
  error: 'Download failed — see the list below'
}

/** One entry in the drawer's download strip. `localPath` is set once a desktop (scp) download has
 *  landed, which is what makes it revealable. */
interface DownloadItem {
  id: number
  name: string
  dir: boolean
  status: 'running' | 'done' | 'error'
  detail?: string
  localPath?: string
}

// Surface a transient error message (matches the Canvas listener at Canvas.tsx:380).
const toast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } }))
}

function EntryIcon({ dir }: { dir: boolean }) {
  return dir ? (
    <svg className="ex-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ) : (
    <svg className="ex-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </svg>
  )
}

function TreeEntry({
  entry,
  path,
  depth,
  fs,
  projectId,
  version,
  selected,
  onContext,
  onOpenFile,
  onSelect,
  onDownload,
  rowDl
}: {
  entry: DirEntry
  path: string
  depth: number
  fs: FsApi
  projectId: string
  version: number
  selected: string | null
  onContext: ContextFn
  onOpenFile: OpenFn
  onSelect: SelectFn
  /** Omitted where this tree can't be downloaded from (see lib/download.ts) — the row then has
   *  no download button at all, rather than one that fails on click. */
  onDownload?: DownloadFn
  /** Download state per path — the whole map, so a row deep in the tree sees its own entry
   *  without every level having to thread a single value down. */
  rowDl: Record<string, RowDownloadState>
}) {
  const open = useExplorer((s) => (s.expandedByProject[projectId] ?? []).includes(path))
  const [children, setChildren] = useState<DirEntry[] | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const dl = rowDl[path]

  const toggleDir = useCallback(() => {
    useExplorer.getState().setExpanded(projectId, path, !open)
  }, [projectId, path, open])

  // A version bump (create/refresh) invalidates every cached subtree; open dirs re-list
  // through the children===null effect below. Initial mount is a no-op (ref seeded with the
  // current version), so a collapsed dir never fetches eagerly.
  const lastVersionRef = useRef(version)
  useEffect(() => {
    if (lastVersionRef.current === version) return
    lastVersionRef.current = version
    setChildren(null)
  }, [version])

  // Lazy-load children whenever this dir is (or becomes) open with nothing loaded yet —
  // covers click-to-expand, restored-from-storage, and reveal-forced expansion alike.
  useEffect(() => {
    if (!entry.dir || !open || children !== null) return
    let cancelled = false
    void fs.list(path).then((c) => {
      if (!cancelled) setChildren(c)
    })
    return () => {
      cancelled = true
    }
  }, [entry.dir, open, children, path, fs])

  // Reveal: scroll the selected (target) row into view once it has mounted.
  useEffect(() => {
    if (selected === path) rowRef.current?.scrollIntoView({ block: 'center' })
  }, [selected, path])

  // Files: first click selects, a second click opens the node. No separate dblclick
  // handler — the second click of a double-click already lands in the `selected === path`
  // branch here, so a dblclick handler would open the SAME file twice (two editor nodes).
  // Directories: a click toggles expansion (and selects for highlight).
  const onClick = useCallback(() => {
    if (entry.dir) {
      onSelect(path)
      toggleDir()
    } else if (selected === path) {
      onOpenFile(path)
    } else {
      onSelect(path)
    }
  }, [entry.dir, selected, path, onOpenFile, onSelect, toggleDir])

  return (
    <>
      <div
        ref={rowRef}
        className={`ex-row${entry.ignored ? ' ignored' : ''}${selected === path ? ' selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault()
          onSelect(path)
          onContext(e.clientX, e.clientY, path, entry.dir, entry.ignored)
        }}
        title={entry.name}
      >
        <span className={`ex-chevron${entry.dir ? '' : ' hidden'}${open ? ' open' : ''}`}>›</span>
        <EntryIcon dir={entry.dir} />
        <span className="ex-name">{entry.name}</span>
        {onDownload && (
          <button
            className={`ex-dl${dl ? ` ${dl}` : ''}`}
            title={dl ? DL_TITLE[dl] : entry.dir ? `Download ${entry.name} folder` : `Download ${entry.name}`}
            aria-label="Download"
            aria-busy={dl === 'running'}
            // A second click while the first transfer is still running would start a duplicate
            // download and land it beside the first as `name (2)`.
            disabled={dl === 'running'}
            // The row's own onClick opens/expands — a download must not also do that.
            onClick={(e) => {
              e.stopPropagation()
              onDownload(path, entry.dir)
            }}
          >
            {dl === 'running' ? <span className="ex-dl__spin" /> : dl === 'done' ? '✓' : dl === 'error' ? '!' : '⤓'}
          </button>
        )}
      </div>
      {entry.dir &&
        open &&
        children?.map((c) => (
          <TreeEntry
            key={c.name}
            entry={c}
            path={`${path}/${c.name}`}
            depth={depth + 1}
            fs={fs}
            projectId={projectId}
            version={version}
            selected={selected}
            onContext={onContext}
            onOpenFile={onOpenFile}
            onSelect={onSelect}
            onDownload={onDownload}
            rowDl={rowDl}
          />
        ))}
    </>
  )
}

/** Project file explorer — a lazy-loaded tree of the active project's folder.
 *
 * SSH projects browse the REMOTE filesystem (rooted at `project.ssh.remoteCwd`, listed via
 * `sshFs(projectId)` over the ControlMaster); local projects use the local fs rooted at `cwd`.
 *
 * NOTE (relay): a relay session's Explorer is still rooted at the local project's `cwd` — the host's
 * root cwd isn't known client-side. A relay tab reaches the host fs through its bridged session api
 * (the same seam TerminalNode/EditorNode use), not a separate per-connection fs client. */
export function ExplorerPanel({
  onClose,
  onOpenFile,
  reveal,
  pinned = false,
  onTogglePin
}: ExplorerPanelProps) {
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId))
  // SSH projects browse the REMOTE filesystem: root at the project's `remoteCwd` and list over the
  // ControlMaster via `sshFs`. Local (and relay) projects keep the local fs rooted at `cwd`.
  const ssh = project?.ssh
  const cwd = ssh ? ssh.remoteCwd : project?.cwd
  // This panel's core api (a stable context read — the local session's api IS window.nodeTerminal).
  // `api` IS a dep here: the memo is a pure pick (no resource), and the list effect below should
  // re-fetch off a new core's fs when 4c makes a session's api replaceable.
  const { api } = useSession()
  const fs = useMemo<FsApi>(
    () => (ssh && project ? sshFs(project.id) : api.fs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.id, ssh, api]
  )
  // Files opened from an SSH project's Explorer are genuinely remote — stamp `sshFs` so the editor
  // node routes its read/write over the project's ControlMaster fs (local/relay projects pass false).
  const handleOpenFile = useCallback<OpenFn>((path) => onOpenFile(path, !!ssh), [onOpenFile, ssh])
  const [roots, setRoots] = useState<DirEntry[] | null>(null)
  const [version, setVersion] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    path: string
    dir: boolean
    ignored?: boolean
  } | null>(null)
  /** Whether the ignored menu entry matches an EXACT .gitignore line (null = still resolving). */
  const [menuExactIgnore, setMenuExactIgnore] = useState<boolean | null>(null)

  // Downloading is only meaningful when the tree is NOT this machine's own filesystem, and the
  // transport differs per shell — the whole decision is the pure `downloadRoute` (lib/download.ts).
  const session = useSession()
  const dlCtx = useMemo(
    () => ({ browser: isBrowserRuntime(), ssh: !!ssh, source: session.source }),
    [ssh, session.source]
  )
  const route = downloadRoute(dlCtx)
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const dlSeq = useRef(0)
  // Per-ROW download state, keyed by path. The strip at the bottom of the drawer reports the same
  // transfers, but the user's eye is on the button they just pressed — and on the HTTP route the
  // whole thing can be over before a glance travels down there. So the row answers for itself.
  const [rowDl, setRowDl] = useState<Record<string, RowDownloadState>>({})
  const setRowState = useCallback((path: string, state: RowDownloadState): void => {
    setRowDl((m) => ({ ...m, [path]: state }))
  }, [])

  const patchDownload = useCallback((id: number, patch: Partial<DownloadItem>): void => {
    setDownloads((list) => list.map((d) => (d.id === id ? { ...d, ...patch } : d)))
  }, [])

  /**
   * Download one entry. `destDir` (desktop only) overrides the OS Downloads folder — it comes from
   * the native folder picker, and main still builds the final path itself.
   *
   * Both routes report through the same strip, but they finish differently on purpose: an scp pull
   * is ours from start to finish, so it ends as a revealable local file; an HTTP download is handed
   * to the BROWSER at the first byte, and its own download shelf owns the progress from there — so
   * the strip's job is just to cover the mint round-trip and then get out of the way.
   */
  const download = useCallback(
    async (path: string, isDir: boolean, destDir?: string): Promise<void> => {
      if (route === 'none') return
      const id = ++dlSeq.current
      const name = path.split('/').filter(Boolean).pop() || path
      setDownloads((list) => [...list, { id, name, dir: isDir, status: 'running' }])
      setRowState(path, 'running')
      const finish = (state: RowDownloadState): void => {
        setRowState(path, state)
        // Clear the row back to a plain ⤓ after the flash. Keyed by PATH, so a second download of
        // the same entry started meanwhile owns the row and its timer must not wipe that state.
        setTimeout(
          () =>
            setRowDl((m) => {
              if (m[path] !== state) return m
              const next = { ...m }
              delete next[path]
              return next
            }),
          ROW_FLASH_MS
        )
      }
      try {
        if (route === 'scp') {
          const res = await window.nodeTerminal.sshProject.downloadFile(project!.id, path, destDir)
          if (res.ok) patchDownload(id, { status: 'done', localPath: res.localPath })
          else patchDownload(id, { status: 'error', detail: res.error })
          finish(res.ok ? 'done' : 'error')
          return
        }
        const ticket = await session.api.files.downloadTicket(path)
        if (!ticket) {
          patchDownload(id, { status: 'error', detail: 'Downloading is not available here.' })
          finish('error')
          return
        }
        triggerBrowserDownload(ticket.url, ticket.name)
        patchDownload(id, { status: 'done', detail: 'Sent to your browser downloads.' })
        finish('done')
        // The browser has it now; the strip row would just be noise from here on.
        setTimeout(() => setDownloads((list) => list.filter((d) => d.id !== id)), 4000)
      } catch {
        patchDownload(id, { status: 'error', detail: 'The download could not be started.' })
        finish('error')
      }
    },
    [route, project, session.api, patchDownload, setRowState]
  )

  const onDownload = useMemo<DownloadFn | undefined>(
    () => (route === 'none' ? undefined : (p, isDir) => void download(p, isDir)),
    [route, download]
  )

  /** "Download to…" — desktop only (the browser has no native folder picker, and its own download
   *  location is a browser setting, not ours to ask about). */
  const downloadTo = useCallback(
    async (path: string, isDir: boolean): Promise<void> => {
      const dir = await window.nodeTerminal.dialog.selectFolder()
      if (dir) await download(path, isDir, dir)
    },
    [download]
  )

  useEffect(() => {
    if (cwd) fs.list(cwd).then(setRoots)
    else setRoots(null)
  }, [cwd, version, fs])

  // Reveal a file: force-open every ancestor directory under cwd, select the file, and
  // let the matching row scroll itself into view. Only paths inside cwd are revealed.
  // Keyed on the nonce so revealing the same file twice still re-triggers.
  useEffect(() => {
    const revealPath = reveal?.path
    if (!revealPath || !cwd) return
    const base = cwd.replace(/\/$/, '')
    const rel = revealPath.startsWith(base + '/') ? revealPath.slice(base.length + 1) : revealPath
    // Reject paths that escape cwd (absolute outside it, or "../" traversal).
    if (rel.startsWith('/') || rel.split('/').includes('..')) return
    const abs = `${base}/${rel}`
    const parts = rel.split('/')
    const dirs = new Set<string>()
    let acc = base
    for (let i = 0; i < parts.length - 1; i++) {
      acc = `${acc}/${parts[i]}`
      dirs.add(acc)
    }
    useExplorer.getState().expandMany(project!.id, [...dirs])
    setSelected(abs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce, cwd])

  const onContext: ContextFn = (x, y, path, isDir, ignored) => {
    setMenu({ x, y, path, dir: isDir, ignored })
    // The "Remove from .gitignore" offer needs to know whether the entry is ignored by an EXACT
    // line (removable) or by a broader pattern like `*.log` (nothing safe to remove — rewriting a
    // user's pattern is not a menu click's call, so no item is shown). Resolved async while the
    // menu opens; until then neither gitignore item renders for an ignored entry.
    setMenuExactIgnore(null)
    if (ignored && cwd && path !== cwd) {
      const rel = path.slice(cwd.length + 1)
      void fs
        .read(`${cwd}/.gitignore`)
        .then((content) => setMenuExactIgnore(gitignoreHasExact(content, rel)))
        .catch(() => setMenuExactIgnore(false))
    }
  }

  /** Add (or exact-line-remove) the entry to the project root's .gitignore, then re-list so the
   *  row's dimming reflects the new truth. Read-modify-write via the pure gitignore helpers. */
  const toggleGitignore = useCallback(
    async (path: string, remove: boolean): Promise<void> => {
      if (!cwd) return
      const rel = path.slice(cwd.length + 1)
      const gi = `${cwd}/.gitignore`
      const cur = (await fs.exists(gi)) ? await fs.read(gi) : ''
      await fs.write(gi, remove ? gitignoreRemove(cur, rel) : gitignoreAdd(cur, rel))
      setVersion((v) => v + 1)
    },
    [cwd, fs]
  )

  // Create a file or folder under the clicked entry (a dir targets itself, a file its
  // parent). Multi-segment names create intermediate dirs. Never overwrites: an existing
  // path is surfaced as a toast and the prompt is abandoned.
  const createEntry = useCallback(
    async (targetPath: string, targetIsDir: boolean, kind: 'file' | 'folder') => {
      const baseDir = createTargetDir(targetPath, targetIsDir)
      const name = await promptDialog({
        message: kind === 'file' ? 'New file name:' : 'New folder name:',
        placeholder: kind === 'file' ? 'notes.md (subdirs ok: docs/notes.md)' : 'folder name',
        confirmLabel: 'Create'
      })
      if (name === null) return
      const dest = newEntryPath(baseDir, name)
      if (!dest) {
        toast(`Invalid name: “${name.trim()}”`)
        return
      }
      if (await fs.exists(dest)) {
        toast(`Already exists: ${dest}`)
        return
      }
      const ok =
        kind === 'folder'
          ? await fs.mkdir(dest)
          : (name.includes('/') ? await fs.mkdir(parentDir(dest)) : true) && (await fs.write(dest, ''))
      if (!ok) {
        toast(`Could not create ${dest}`)
        return
      }
      // Keep the target (and any new intermediate dirs) expanded, then re-list the tree.
      if (project) {
        const dirs = [baseDir, ...ancestorDirs(baseDir, name)].filter((d) => d !== cwd)
        useExplorer.getState().expandMany(project.id, dirs)
      }
      setVersion((v) => v + 1)
      if (kind === 'file') handleOpenFile(dest)
    },
    [fs, cwd, project, handleOpenFile]
  )

  return createPortal(
    <div
      className={pinned ? 'drawer-overlay drawer-overlay--pinned' : 'drawer-overlay'}
      // Pinned: no handler, so a CSS miss still cannot dismiss the docked tree. The overlay
      // also has pointer-events:none (styles.css) — without that it would steal canvas clicks
      // even with a no-op handler. Both halves are load-bearing.
      onClick={explorerOverlayClickCloses(pinned) ? onClose : undefined}
    >
      <aside
        className={pinned ? 'drawer drawer--pinned' : 'drawer'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer__head">
          <h2>{project?.name || 'Explorer'}</h2>
          <div className="ex-head-actions">
            <button type="button" title="Refresh" aria-label="Refresh" onClick={() => setVersion((v) => v + 1)}>
              <IconReload />
            </button>
            {onTogglePin && (
              <button
                type="button"
                className={pinned ? 'is-on' : ''}
                title={pinned ? 'Unpin' : 'Pin'}
                aria-label={pinned ? 'Unpin' : 'Pin'}
                aria-pressed={pinned}
                onClick={onTogglePin}
              >
                <IconPin />
              </button>
            )}
            <button type="button" className="drawer__close" title="Close" aria-label="Close" onClick={onClose}>
              <IconClose />
            </button>
          </div>
        </div>

        {!cwd && (
          <div className="drawer__body">
            <p className="set-note">Set a folder for this project first (tab ⌄ → “Set folder…”).</p>
          </div>
        )}

        {cwd && (
          <div
            className="drawer__body ex-body"
            onContextMenu={(e) => {
              if (e.target !== e.currentTarget || !cwd) return
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, path: cwd, dir: true })
            }}
          >
            {roots?.length === 0 && <p className="set-note">Empty folder.</p>}
            {roots?.map((e) => (
              <TreeEntry
                key={e.name}
                entry={e}
                path={`${cwd}/${e.name}`}
                depth={0}
                fs={fs}
                projectId={project!.id}
                version={version}
                selected={selected}
                onContext={onContext}
                onOpenFile={handleOpenFile}
                onSelect={setSelected}
                onDownload={onDownload}
                rowDl={rowDl}
              />
            ))}
          </div>
        )}

        {downloads.length > 0 && (
          <div className="ex-dls">
            {downloads.map((d) => (
              <div key={d.id} className={`ex-dls__row ${d.status}`}>
                {d.status === 'running' && <span className="ex-dls__spin" />}
                <span className="ex-dls__name" title={d.detail || d.localPath || d.name}>
                  {d.name}
                  {d.dir && d.status === 'running' ? ' (folder)' : ''}
                </span>
                {d.status === 'done' && d.localPath && (
                  <button
                    className="ex-dls__act"
                    onClick={() => window.nodeTerminal.shell.reveal(d.localPath!)}
                  >
                    Reveal
                  </button>
                )}
                <button
                  className="ex-dls__act ex-dls__dismiss"
                  aria-label="Dismiss"
                  onClick={() => setDownloads((list) => list.filter((x) => x.id !== d.id))}
                >
                  <IconClose />
                </button>
              </div>
            ))}
          </div>
        )}
      </aside>

      {menu &&
        createPortal(
          <>
            {/* stopPropagation everywhere (same as ContextMenu): this portal's React parent is the
                drawer OVERLAY (not the aside), so a bubbled click on the unpinned modal lands on
                the overlay's onClick={onClose} and closes the whole Explorer along with the menu.
                A pinned overlay has no close handler, but the stop is still what keeps the
                click off the canvas. */}
            <div
              className="tab-backdrop"
              style={{ zIndex: 78 }}
              onClick={(e) => {
                e.stopPropagation()
                setMenu(null)
              }}
            />
            <div
              className="ctx-menu"
              style={{ top: menu.y, left: menu.x, zIndex: 80 }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="ctx-item"
                onClick={() => {
                  const m = menu
                  setMenu(null)
                  void createEntry(m.path, m.dir, 'file')
                }}
              >
                New File…
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  const m = menu
                  setMenu(null)
                  void createEntry(m.path, m.dir, 'folder')
                }}
              >
                New Folder…
              </button>
              {route !== 'none' && (
                <>
                  <div className="ctx-sep" />
                  <button
                    className="ctx-item"
                    onClick={() => {
                      const m = menu
                      setMenu(null)
                      void download(m.path, m.dir)
                    }}
                  >
                    {/* scp -r brings a folder down AS a folder; the HTTP route has to archive it
                        on the fly, and the user should know what will land in Downloads. */}
                    {menu.dir ? (route === 'http' ? 'Download Folder (.tar.gz)' : 'Download Folder') : 'Download'}
                  </button>
                  {route === 'scp' && (
                    <button
                      className="ctx-item"
                      onClick={() => {
                        const m = menu
                        setMenu(null)
                        void downloadTo(m.path, m.dir)
                      }}
                    >
                      Download to…
                    </button>
                  )}
                </>
              )}
              <div className="ctx-sep" />
              <button
                className="ctx-item"
                onClick={() => {
                  window.nodeTerminal.clipboard.writeText(menu.path)
                  setMenu(null)
                }}
              >
                Copy Path
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  window.nodeTerminal.clipboard.writeText(cwd ? menu.path.slice(cwd.length + 1) : menu.path)
                  setMenu(null)
                }}
              >
                Copy Relative Path
              </button>
              {/* Root itself (the empty-area menu) is not an ignorable entry. An entry ignored by
                  a broader PATTERN gets neither item: it cannot be "added" (already ignored) and
                  there is no exact line to remove — see onContext. */}
              {menu.path !== cwd && (!menu.ignored || menuExactIgnore) && (
                <>
                  <div className="ctx-sep" />
                  <button
                    className="ctx-item"
                    onClick={() => {
                      const m = menu
                      setMenu(null)
                      void toggleGitignore(m.path, !!m.ignored)
                    }}
                  >
                    {menu.ignored ? 'Remove from .gitignore' : 'Add to .gitignore'}
                  </button>
                </>
              )}
              {/* Only where it can work: revealing an SSH project's REMOTE path in the local file
                  manager did nothing, and in a browser tab the whole member is an inert stub. */}
              {canRevealLocally(dlCtx) && (
                <>
                  <div className="ctx-sep" />
                  <button
                    className="ctx-item"
                    onClick={() => {
                      window.nodeTerminal.shell.reveal(menu.path)
                      setMenu(null)
                    }}
                  >
                    Reveal in Finder
                  </button>
                </>
              )}
            </div>
          </>,
          document.body
        )}
    </div>,
    document.body
  )
}
