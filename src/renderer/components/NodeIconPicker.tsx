/**
 * Choosing a node's icon: a curated glyph (shell, git, database, … — issue #291), an emoji from a
 * small palette, any character typed by hand, or an image file from disk.
 *
 * Driven by the promise-based singleton `nodeIconDialog()` — the same shape as `promptDialog()` —
 * so every surface that can set an icon (the node context menu, the node header, the kanban card
 * modal) opens the SAME dialog and none of them has to own its state.
 *
 * The three outcomes are distinct on purpose, and the caller must keep them distinct:
 *   `NodeIcon` → set this icon.  `null` → remove the icon.  `undefined` → cancelled, change nothing.
 * Collapsing "remove" into "cancel" is how a Remove button silently does nothing.
 *
 * **Where an image goes.** Not where the user picked it from: a path outside the project would
 * break for everyone who clones the repo, and would break here the moment the file moves. The
 * bytes are copied through `files.saveCanvasImage`, the same seam canvas image nodes use, which
 * puts them in the project's git-shared `.nodeterm/images/` (or a durable app-local folder when
 * the project has no local cwd). The stored path is then made `./`-relative by `portableIconPath`
 * so the icon travels with the canvas that names it.
 *
 * **Relay tabs are refused**, with the same message and for the same reason canvas image import
 * is: the write is this machine's preload while the read is the peer's core, so the node would end
 * up naming a file only this machine has. A clear refusal beats an icon that can never draw.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import {
  iconFileName,
  localIconCwd,
  NODE_GLYPHS,
  type NodeIcon,
  nodeIconMime,
  normalizeNodeIcon,
  portableIconPath
} from '@shared/node-icon'
import { canvasImportRefusal } from '../canvas/canvas-image-import'
import { browserThumbnailDeps, downscaleIconImage } from '../lib/nodeIconThumbnail'
import { useProjects } from '../state/projects'
import { sessionForProject } from '../session/session'
import { useDialogStack } from './dialog-stack'
import { NodeIconView } from './NodeIcon'

/**
 * A small, deliberately opinionated palette rather than a full emoji keyboard. Grouped by what
 * people actually label a terminal with — state, kind of work, subject matter — because the point
 * is to tell twelve sessions apart at a glance, not to browse Unicode. Anything not here is one
 * keystroke away in the input beside it, which is also where every platform's own emoji picker
 * lands its result.
 */
const PALETTE: readonly string[] = [
  '\u{1F680}', '\u{1F525}', '\u{2B50}', '\u{26A1}', '\u{1F41B}', '\u{1F527}',
  '\u{1F9EA}', '\u{1F4E6}', '\u{1F310}', '\u{1F512}', '\u{1F5C4}', '\u{1F4CA}',
  '\u{1F3AF}', '\u{1F4DD}', '\u{1F4DA}', '\u{1F9E0}', '\u{1F916}', '\u{1F441}',
  '\u{1F3D7}', '\u{1F9F9}', '\u{1F6A8}', '\u{1F6A7}', '\u{2705}', '\u{1F534}',
  '\u{1F7E2}', '\u{1F535}', '\u{1F7E1}', '\u{1F7E3}', '\u{1F3A8}', '\u{1F3B5}',
  '\u{2615}', '\u{1F31E}', '\u{1F319}', '\u{1F332}', '\u{1F433}', '\u{1F431}'
]

/** `undefined` = cancelled (change nothing); `null` = remove the icon; a value = set it. */
export type NodeIconChoice = NodeIcon | null | undefined

interface DialogState {
  current: {
    nodeId: string
    title: string
    icon?: NodeIcon
    resolve: (choice: NodeIconChoice) => void
  } | null
}

const useStore = create<DialogState>(() => ({ current: null }))

/**
 * Open the icon dialog for one node and resolve with the user's choice. Opening a second one
 * cancels the first (resolving `undefined`), matching `promptDialog`.
 */
export function nodeIconDialog(opts: {
  nodeId: string
  title: string
  icon?: NodeIcon
}): Promise<NodeIconChoice> {
  return new Promise((resolve) => {
    const prev = useStore.getState().current
    if (prev) {
      useStore.setState({ current: null })
      prev.resolve(undefined)
    }
    useStore.setState({ current: { ...opts, resolve } })
  })
}

/** Mount once, at the app root. Renders the active icon dialog, if any. */
export function NodeIconDialogHost(): React.JSX.Element | null {
  const current = useStore((s) => s.current)
  if (!current) return null
  const finish = (choice: NodeIconChoice): void => {
    useStore.setState({ current: null })
    current.resolve(choice)
  }
  return <NodeIconPicker title={current.title} icon={current.icon} onDone={finish} />
}

function NodeIconPicker({
  title,
  icon,
  onDone
}: {
  title: string
  icon?: NodeIcon
  onDone: (choice: NodeIconChoice) => void
}): React.JSX.Element {
  const [typed, setTyped] = useState(icon?.type === 'emoji' ? icon.value : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const isTop = useDialogStack()

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /**
   * Escape belongs to the dialog, not to its text input.
   *
   * It was handled only in the input's `onKeyDown`, so the moment focus moved anywhere else — the
   * emoji grid, "Choose image…", a swatch the user had just clicked — Escape did nothing and the
   * dialog could only be dismissed with the mouse. `useDialogStack()` was already called; its
   * answer was simply discarded.
   *
   * `isTop()` is the ONLY gate, deliberately matching `confirmKeyAction`: there, `inDialog` guards
   * Enter and never Escape. The asymmetry is the point — Enter is the affirmative key and must be
   * aimed at the dialog, while Escape is the safe direction, and requiring focus to be inside the
   * box would reproduce exactly the bug this fixes for a user whose focus sits on the body. Being
   * top is what keeps it honest: with a dialog stacked above, the key is not ours, and we must not
   * `preventDefault` it either or we would swallow it from the dialog the user can see.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isTop()) return
      e.preventDefault()
      onDone(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, onDone])

  const commitTyped = (raw: string): void => {
    // The same validator the persisted file goes through, so what the picker accepts and what a
    // reload accepts cannot drift: type three characters, keep the first grapheme.
    const next = normalizeNodeIcon({ type: 'emoji', value: raw })
    onDone(next ?? null)
  }

  /**
   * Copy the chosen file into the project and hand back a portable path. Every failure resolves to
   * a message rather than a thrown error or a silently-missing icon: the user picked a file and is
   * owed an answer about it.
   */
  const chooseImage = async (): Promise<void> => {
    setError('')
    const { activeProjectId, getProject } = useProjects.getState()
    const project = activeProjectId ? getProject(activeProjectId) : undefined
    if (!project) return
    const refusal = canvasImportRefusal(!!project.remote)
    if (refusal) {
      setError(refusal)
      return
    }
    const api = sessionForProject(project.id).api
    const picked = await api.dialog.selectFile()
    if (!picked) return
    // Checked BEFORE the copy, not after it. `selectFile` applies no filter, so a .heic is one
    // click away — and validating afterwards meant the bytes had already been written into the
    // project's git-shared `.nodeterm/images/`, leaving an orphan file behind every refusal.
    // Nothing later removes it: `saveCanvasImage` creates exclusively, so the next pick would sit
    // beside it as `photo (2).heic`.
    if (!nodeIconMime(picked)) {
      setError('That file type cannot be used as an icon. Try PNG, JPEG, GIF, WEBP or SVG.')
      return
    }
    setBusy(true)
    try {
      const b64 = await api.fs.readBinary(picked)
      if (!b64) {
        setError('Could not read that file.')
        return
      }
      // Both separators, because `selectFile` answers in the HOST's dialect: on Windows it is
      // `C:\\Users\\me\\logo.png`, which `split('/')` returned whole — so the copy was named after
      // the entire path and `safeUploadName` then had to salvage it.
      const name = iconFileName(picked) || 'icon.png'
      // Shrunk BEFORE the write, not after: what goes into `.nodeterm/images/` is committed and
      // cloned by everyone on the repo, and it draws at 13-16px. Fails open — a decode or encode
      // that does not work hands back the original bytes, because losing the user's pick to save
      // some disk is the wrong trade.
      const small = await downscaleIconImage({ base64: b64, name }, browserThumbnailDeps)
      const saved = await api.files.saveCanvasImage(project.id, small.name, small.base64)
      if (!saved) {
        setError('Could not save the image — check that this project’s folder is writable.')
        return
      }
      // An SSH project writes app-locally (its cwd is on another machine), so `portableIconPath`
      // is handed the LOCAL cwd only — for an SSH project that is undefined and the path stays
      // absolute, which is exactly the non-travelling icon that case can honestly offer.
      // `localIconCwd` is that rule, and the READ side asks the same function: written twice, the
      // two copies drifted and the read side resolved a remote-rooted path against the local fs.
      const stored = portableIconPath(saved, localIconCwd(project))
      const next = normalizeNodeIcon({ type: 'image', path: stored })
      if (!next) {
        // The extension was already accepted above, so this is no longer "wrong file type" — it
        // means the SAVED path is one the validator will not vouch for (a UNC share, a path with
        // no root). Blaming the file type here is what sent Windows users hunting for a format
        // problem that did not exist: `saveCanvasImage` returns `C:\\...`, which the old
        // POSIX-only check refused.
        setError('Could not use that file’s location as an icon path.')
        return
      }
      onDone(next)
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="confirm-overlay" onClick={() => onDone(undefined)}>
      <div className="confirm node-icon-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg">Icon for {title || 'this node'}</p>
        {/* What the node IS, first: a glyph names the kind of session (issue #291), where the
            emoji below names a mood. Drawn by the same NodeIconView the header and sidebar use,
            so the button shows exactly what the node will wear. */}
        <div className="node-icon-dialog__grid">
          {NODE_GLYPHS.map((glyph) => {
            const current = icon?.type === 'lucide' && icon.name === glyph.id
            return (
              <button
                key={glyph.id}
                type="button"
                className={`node-icon-dialog__swatch node-icon-dialog__swatch--glyph${
                  current ? ' is-current' : ''
                }`}
                title={glyph.label}
                aria-label={glyph.label}
                aria-pressed={current}
                onClick={() => onDone({ type: 'lucide', name: glyph.id })}
              >
                <NodeIconView icon={{ type: 'lucide', name: glyph.id }} size={18} />
              </button>
            )
          })}
        </div>
        <div className="node-icon-dialog__grid">
          {PALETTE.map((e) => (
            <button
              key={e}
              type="button"
              className={`node-icon-dialog__swatch${
                icon?.type === 'emoji' && icon.value === e ? ' is-current' : ''
              }`}
              onClick={() => onDone({ type: 'emoji', value: e })}
            >
              {e}
            </button>
          ))}
        </div>
        <div className="node-icon-dialog__row">
          <input
            ref={inputRef}
            className="confirm__input node-icon-dialog__input"
            value={typed}
            placeholder="Or type any emoji or character"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              // Escape is deliberately NOT handled here: the window listener above owns it for
              // the whole dialog, and a second handler on one press is the double-answer the
              // dialog stack exists to prevent.
              if (e.key === 'Enter') {
                e.preventDefault()
                commitTyped(typed)
              }
            }}
          />
          <button
            type="button"
            className="confirm__btn"
            disabled={busy}
            onClick={() => void chooseImage()}
          >
            {busy ? 'Copying…' : 'Choose image…'}
          </button>
        </div>
        {error && <p className="node-icon-dialog__error">{error}</p>}
        <div className="confirm__actions">
          {/* Distinct from Cancel: one clears the icon, the other leaves it alone. */}
          <button type="button" className="confirm__btn" disabled={!icon} onClick={() => onDone(null)}>
            Remove icon
          </button>
          <button type="button" className="confirm__btn" onClick={() => onDone(undefined)}>
            Cancel
          </button>
          <button type="button" className="confirm__btn primary" onClick={() => commitTyped(typed)}>
            Use
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
