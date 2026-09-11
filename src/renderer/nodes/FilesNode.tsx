/**
 * A file-manager node: one directory listing, on the canvas, beside the terminals that work in it.
 *
 * This is NOT a second Explorer. The Explorer drawer is a single tree rooted at the active
 * project's cwd, and it is modal in practice — it covers the canvas and you close it to get back
 * to work. A file manager node is a persisted canvas object pinned to ONE directory, so you can
 * keep `src/renderer/nodes` open next to the agent working in it and a second one on `docs/`,
 * where a tree gives you one cursor and a lot of scrolling.
 *
 * **Which filesystem** is the same decision `EditorNode` makes, read the same way: an SSH project's
 * node (`data.sshFs`) lists the project's HOST over the ControlMaster; everything else lists
 * through the node's own session api — which is the local core for a local project and the PEER's
 * core for a relay tab, so a relay tab browses the machine its terminals are actually on. Getting
 * this from `useSession()` rather than `window.nodeTerminal` is the whole reason a relay tab works
 * here for free — **while `data.sshFs` is false.** When it is set, `sshFs(projectId)` reaches
 * `window.nodeTerminal.sshFs`, i.e. THIS machine's preload, not the session's. That is inherited
 * (`createEditorNode`/`createVideoNode` stamp and share the flag the same way) and it matters more
 * here than for them: `sshFs` is written into the git-shared `project.json`, so a teammate who
 * clones the repo locally gets a node flagged remote with a perfectly valid local cwd, and the
 * unresolvable ref fails open to `[]` — a directory full of files reported as empty. Fixing it
 * means routing `sshFs` through the session api for every consumer, which is its own change.
 *
 * **Opening is delegated, not reimplemented.** A file dispatches `nodeterm:open-file` — the event
 * `TerminalNode`'s Cmd+click links already use — so editor / image / video routing stays in
 * Canvas's one `openFile`, and this node never grows a second opinion about what a `.png` is.
 * Directories navigate in place (persisted, so a reload comes back where you were).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import type { DirEntry } from '@shared/types'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import { COLLAPSED_HEIGHT, type CanvasNode } from '../state/workspace'
import { NodeColorSwatches } from '../components/NodeColorSwatches'
import {
  breadcrumbs,
  childPath,
  classifyEmptyListing,
  fileOpenTarget,
  filterEntries,
  folderTitle,
  parentDir
} from '../lib/filesNode'
import { ancestorDirs, createTargetDir, newEntryPath } from '../lib/explorerCreate'
import { sshFs } from '../terminal/ssh-fs'
import { useSession } from '../session/session'
import { useProjects } from '../state/projects'
import { promptDialog } from '../components/promptDialog'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { isBrowserRuntime } from '../bridge/runtime'
import { canUseLocalShell } from '../lib/download'

/**
 * Shown when the parent listing could not be read either. It deliberately names BOTH possible
 * causes rather than picking one: the fail-open `FsApi` contract gives an empty array for a
 * deleted directory and for a dead ControlMaster alike, so the honest thing is to say we could
 * not see it and let the user tell the two apart.
 */
const UNREACHABLE_MESSAGE = 'Could not reach this folder. It may be gone, or its filesystem may be unavailable.'

/** Surface a transient error the way every other node does (Canvas listens for this). */
const toast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } }))
}

function EntryGlyph({ dir }: { dir: boolean }) {
  return dir ? (
    <svg className="files-node__glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ) : (
    <svg className="files-node__glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </svg>
  )
}

export function FilesNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements, setNodes } = useReactFlow()
  const [showColors, setShowColors] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleBefore, setTitleBefore] = useState('')
  /** `titleAuto` as it stood before the rename began — Escape has to put BOTH halves back. */
  const [autoBefore, setAutoBefore] = useState(true)
  /** Kept WITH the directory it belongs to. Deriving `entries` from a cwd match is what makes
   *  "Loading…" reachable: before this, nothing ever reset the list, so navigating showed the
   *  PREVIOUS folder's rows until the new promise resolved and the loading state existed only on
   *  the very first mount. A `version` bump (re-list after a create) deliberately keeps the rows,
   *  since that is the same directory being re-read. */
  const [listing, setListing] = useState<{ cwd: string; entries: DirEntry[] } | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  /** Bumped to force a re-list after a create; `cwd` alone cannot express "same dir, new content". */
  const [version, setVersion] = useState(0)

  const collapsed = !!data.collapsed
  /**
   * The directory this node shows. It used to fall back to `'/'`, which meant a node with no `cwd`
   * silently listed the FILESYSTEM ROOT — reachable with no bug on our side, because
   * `.nodeterm/project.json` is git-shared, hand-editable input and nothing validates a files
   * node's `cwd` on load. It is also the same failure `displacedFilesPatch` refuses on the WRITE
   * side; guarding one end and not the other left the hole open under the commit named after it.
   *
   * No silent fallback now: with no cwd there is nothing to list and the node says so. `''` is
   * inert for the rest of the component because the effect below never lists it, and reaching the
   * root then takes a deliberate click on a crumb rather than happening by itself.
   */
  const cwd = typeof data.cwd === 'string' ? data.cwd.trim() : ''
  /** Null whenever the rows on screen do not belong to the directory being shown — i.e. the
   *  "Loading…" state, which is now reachable on every navigation and not just the first mount. */
  const entries = listing && listing.cwd === cwd ? listing.entries : null
  const isSshFs = !!data.sshFs
  const { api, source } = useSession()
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const fs = isSshFs && activeProjectId ? sshFs(activeProjectId) : api.fs
  /** A listing this machine's OS cannot act on: an SSH host's files, or a relay peer's. */
  const remote = isSshFs || source === 'relay'
  /** The ONE precondition every `shell.*` path action shares: an Electron shell, and a path on
   *  THIS machine. Both members are `noop` stubs in a browser tab, so an ungated call is a dead
   *  click — which is what "Reveal" was written to avoid and what `openPath` still did. */
  const localShell = canUseLocalShell({ browser: isBrowserRuntime(), ssh: isSshFs, source })

  useEffect(() => {
    let live = true
    setError('')
    if (!cwd) {
      // Nothing to list, and listing `'/'` instead would be the silent root-browse this guard
      // exists to stop. Name the state rather than showing an empty directory.
      setListing({ cwd, entries: [] })
      setError('This file manager has no folder.')
      return
    }
    void (async () => {
      let list: DirEntry[]
      try {
        list = await fs.list(cwd)
      } catch {
        // Only a transport-level rejection lands here (a dropped ws/relay socket, an
        // unsupported namespace). Every filesystem failure resolves `[]` instead — which is
        // exactly what the empty branch below has to disambiguate.
        if (!live) return
        setListing({ cwd, entries: [] })
        setError('Could not read this folder.')
        return
      }
      if (!live) return
      if (list.length > 0) {
        setListing({ cwd, entries: list })
        return
      }
      // Empty is ambiguous under the fail-open `FsApi` contract, so ask the parent who is right.
      // Only a definite absence is allowed to raise the error.
      //
      // This is a SECOND `fs.list` — no new IPC *channel*, but a real extra round trip, and on an
      // SSH project a real extra remote command. It is bounded (exactly one, never recursive),
      // fails open, and is skipped entirely whenever the directory has any content, so it costs
      // nothing on the common path.
      //
      // Nothing is published until the verdict is in: setting the empty listing first made a
      // deleted folder render "This folder is empty." for one paint and then correct itself. While
      // we are still deciding, "Loading…" is the true answer.
      const parent = parentDir(cwd)
      let parentEntries: DirEntry[] | null = null
      try {
        if (parent !== cwd) parentEntries = await fs.list(parent)
      } catch {
        parentEntries = null // could not ask, so claim nothing
      }
      if (!live) return
      setListing({ cwd, entries: list })
      // Only `empty` and `unknown` fall through to "This folder is empty.", and they are the two
      // cases where that sentence is true or at least not a claim. The other two each get their
      // own, because saying "empty" over a folder that is gone, or over a filesystem we simply
      // could not see, is the reassuring kind of wrong.
      const verdict = classifyEmptyListing(cwd, parentEntries)
      if (verdict === 'missing') setError('Could not read this folder.')
      else if (verdict === 'unreachable') setError(UNREACHABLE_MESSAGE)
    })()
    return () => {
      live = false
    }
    // `fs` is rebuilt each render (sshFs returns a fresh object), so it is deliberately not a
    // dependency — the identity that matters is the project + the sshFs flag, both of which
    // change `cwd`'s meaning and are covered by the deps that are here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, isSshFs, activeProjectId, version])

  // The filter belongs to the directory it was typed in, so ONE owner clears it — keyed on `cwd`
  // rather than done inside `navigate`, because navigation is not the only way the cwd changes:
  // a removed worktree re-points it through `resetDisplacedCwd`, which never calls `navigate`.
  // A filter surviving that lands the user in a new folder showing "Nothing matches …".
  useEffect(() => {
    setQuery('')
  }, [cwd])

  const navigate = useCallback(
    (to: string) => {
      // The title tracks the folder ONLY while the user has not renamed the node by hand — the
      // same `titleAuto` contract agent nodes use for their session name. Renaming a file manager
      // "assets" and then having it silently become "images" on the next click would be the node
      // overwriting the user.
      const patch: Record<string, unknown> = { cwd: to }
      if (data.titleAuto !== false) patch.title = folderTitle(to)
      updateNodeData(id, patch)
    },
    [id, updateNodeData, data.titleAuto]
  )

  const open = useCallback(
    (entry: DirEntry) => {
      const path = childPath(cwd, entry.name)
      if (entry.dir) {
        navigate(path)
        return
      }
      if (fileOpenTarget(path, { remote }) === 'os') {
        // `fileOpenTarget` has already refused a remote path, so the only way to be here without
        // a usable shell is a browser tab — where `openPath` is an inert stub and the click would
        // simply do nothing. Say so instead: an unavailable feature that explains itself reads
        // better than an app that looks broken.
        if (!localShell) {
          toast(`“${entry.name}” can only be opened by the desktop app — a browser tab cannot hand a file to your operating system.`)
          return
        }
        api.shell.openPath(path)
        return
      }
      // Canvas owns editor-vs-video routing; `ssh` tells its `openFile` to read over the
      // project's remote fs rather than this machine's.
      window.dispatchEvent(
        new CustomEvent('nodeterm:open-file', { detail: { path, ssh: isSshFs } })
      )
    },
    [cwd, navigate, remote, api, isSshFs, localShell]
  )

  /** Create a file or a folder under `dir`, then re-list. Shared by both menu rows because the
   *  only difference is the last call — and the validation, the intermediate dirs and the
   *  already-exists check are exactly the things that must not be written twice. */
  const create = useCallback(
    async (dir: string, kind: 'file' | 'folder') => {
      const name = await promptDialog({
        message: kind === 'file' ? 'New file name:' : 'New folder name:',
        confirmLabel: 'Create'
      })
      if (name === null) return
      const target = newEntryPath(dir, name)
      if (!target) {
        toast('That name cannot be used.')
        return
      }
      if (await fs.exists(target)) {
        toast(`${name.trim()} already exists.`)
        return
      }
      // A nested name ("a/b/c.ts") needs its intermediate directories first — mkdir is recursive,
      // so one call on the deepest one is enough.
      const parents = ancestorDirs(dir, name)
      if (parents.length && !(await fs.mkdir(parents[parents.length - 1]))) {
        toast('Could not create that folder.')
        return
      }
      const ok = kind === 'folder' ? await fs.mkdir(target) : await fs.write(target, '')
      if (!ok) {
        toast(kind === 'folder' ? 'Could not create that folder.' : 'Could not create that file.')
        return
      }
      setVersion((v) => v + 1)
      if (kind === 'file') {
        window.dispatchEvent(
          new CustomEvent('nodeterm:open-file', { detail: { path: target, ssh: isSshFs } })
        )
      }
    },
    [fs, isSshFs]
  )

  const openMenu = useCallback(
    (e: React.MouseEvent, entry: DirEntry | null) => {
      e.preventDefault()
      e.stopPropagation()
      const path = entry ? childPath(cwd, entry.name) : cwd
      const dir = entry ? createTargetDir(path, entry.dir) : cwd
      const items: MenuItem[] = []
      if (entry) {
        items.push({ label: entry.dir ? 'Open folder' : 'Open', onClick: () => open(entry) })
      }
      // "here" has to be somewhere a terminal can actually be opened. `addTerminal` spawns
      // against the ACTIVE project, and a relay project carries no `ssh` binding — so on a relay
      // tab this would hand the PEER's path to a plain local terminal, the same wrong-machine
      // mistake `fileOpenTarget` refuses for `shell.openPath`. Spawning onto a peer's core is a
      // real feature, not a one-liner, so the row is withheld rather than faked. (An SSH project
      // is fine: `addTerminal` now rebinds `remoteCwd` to the requested directory.)
      if ((!entry || entry.dir) && source !== 'relay') {
        items.push({
          label: 'New terminal here',
          onClick: () =>
            window.dispatchEvent(
              new CustomEvent('nodeterm:open-terminal', { detail: { cwd: entry ? path : cwd } })
            )
        })
      }
      items.push({ type: 'separator' })
      items.push({ label: 'New file…', onClick: () => void create(dir, 'file') })
      items.push({ label: 'New folder…', onClick: () => void create(dir, 'folder') })
      items.push({ type: 'separator' })
      items.push({
        label: 'Copy path',
        onClick: () => api.clipboard.writeText(path)
      })
      if (localShell) {
        items.push({ label: 'Reveal in file manager', onClick: () => api.shell.reveal(path) })
      }
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [cwd, open, create, api, localShell, source]
  )

  const toggleCollapse = () =>
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== id) return n
        const next = !n.data.collapsed
        const expandedHeight =
          (n.data.expandedHeight as number) ?? n.measured?.height ?? (n.height as number) ?? 460
        const height = next ? COLLAPSED_HEIGHT : expandedHeight
        return {
          ...n,
          height,
          style: { ...n.style, height },
          data: { ...n.data, collapsed: next, expandedHeight }
        }
      })
    )

  const shown = useMemo(() => filterEntries(entries ?? [], query), [entries, query])
  const crumbs = useMemo(() => breadcrumbs(cwd), [cwd])

  return (
    <div className={`files-node${selected ? ' selected' : ''}${collapsed ? ' collapsed' : ''}`}>
      <NodeResizer
        minWidth={NODE_MIN_SIZES.files.width}
        minHeight={NODE_MIN_SIZES.files.height}
        isVisible={selected && !collapsed}
        color={data.color as string}
      />

      <div className="files-node__header" style={{ background: `${data.color}22` }}>
        <button className="term-node__collapse" title={collapsed ? 'Expand' : 'Collapse'} onClick={toggleCollapse}>
          {collapsed ? '▸' : '▾'}
        </button>
        <button
          className="term-node__color"
          style={{ background: data.color as string }}
          title="Color"
          onClick={() => setShowColors((v) => !v)}
        />
        {showColors && (
          <NodeColorSwatches
            className="color-popover"
            selected={data.color as string | undefined}
            onPick={(c) => {
              updateNodeData(id, { color: c })
              setShowColors(false)
            }}
          />
        )}
        {editingTitle ? (
          <input
            className="term-node__title nodrag"
            value={(data.title as string) ?? ''}
            spellCheck={false}
            autoFocus
            // A hand rename stops the title tracking the folder — same contract as an agent
            // node's session name (`titleAuto`), so navigating never overwrites a chosen name.
            onChange={(e) => updateNodeData(id, { title: e.target.value, titleAuto: false })}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                setEditingTitle(false)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                // Restore `titleAuto` as well as the text. `onChange` sets it false on the first
                // keystroke, so cancelling a rename you never committed used to leave the title
                // permanently detached from the folder — the node stopped following navigation
                // and nothing said why.
                updateNodeData(id, { title: titleBefore, titleAuto: autoBefore })
                setEditingTitle(false)
              }
            }}
          />
        ) : (
          <span
            className="term-node__title-text nodrag"
            title="Click to rename"
            onClick={() => {
              setTitleBefore((data.title as string) ?? '')
              setAutoBefore(data.titleAuto !== false)
              setEditingTitle(true)
            }}
          >
            {(data.title as string) || folderTitle(cwd)}
          </span>
        )}
        {isSshFs && <span className="files-node__chip">SSH</span>}
        {!editingTitle && <span className="term-node__spacer" />}
        <button
          className="files-node__btn nodrag"
          title="Up one folder"
          disabled={cwd === '/'}
          onClick={() => navigate(parentDir(cwd))}
        >
          ↑
        </button>
        <button
          className="files-node__btn nodrag"
          title="Refresh"
          onClick={() => setVersion((v) => v + 1)}
        >
          ⟳
        </button>
        <button className="term-node__close" title="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
          ×
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="files-node__crumbs nodrag">
            {crumbs.map((c, i) => (
              <span key={`${c.path}-${i}`} className="files-node__crumb-wrap">
                {/* No separator after the ROOT crumb — its own label is already "/", and a
                    separator there renders the doubled "/ / …" this replaced. */}
                {i > 0 && crumbs[i - 1].name !== '/' && <span className="files-node__sep">/</span>}
                <button className="files-node__crumb" title={c.path} onClick={() => navigate(c.path)}>
                  {c.name}
                </button>
              </span>
            ))}
          </div>

          <input
            className="files-node__filter nodrag"
            value={query}
            placeholder="Filter…"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setQuery('')
              }
            }}
          />

          <div
            className="files-node__list nodrag nowheel"
            onContextMenu={(e) => openMenu(e, null)}
          >
            {/* Four distinct states, kept distinct. "Still loading", "could not read", "the
                folder is empty" and "your filter matches nothing" are different facts, and
                collapsing any of them into a blank pane is exactly the failure this repo's
                house rules call out. */}
            {entries === null ? (
              <div className="files-node__empty">Loading…</div>
            ) : error ? (
              <div className="files-node__empty files-node__empty--error">{error}</div>
            ) : entries.length === 0 ? (
              <div className="files-node__empty">This folder is empty.</div>
            ) : shown.length === 0 ? (
              <div className="files-node__empty">Nothing matches “{query.trim()}”.</div>
            ) : (
              shown.map((entry) => (
                <div
                  key={entry.name}
                  className={`files-node__row${entry.ignored ? ' is-ignored' : ''}`}
                  title={childPath(cwd, entry.name)}
                  onClick={() => open(entry)}
                  onContextMenu={(e) => openMenu(e, entry)}
                >
                  <EntryGlyph dir={entry.dir} />
                  <span className="files-node__name">{entry.name}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
