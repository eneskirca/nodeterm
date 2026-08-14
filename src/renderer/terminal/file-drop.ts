// Shared terminal file-drop/paste logic — used by both the canvas TerminalNode and the kanban card
// modal's co-attach terminal (ModalTerminal), so a file dropped onto or pasted into either becomes
// a path the same way.

/** Backslash-escape shell-special characters, like a native terminal does on file drop. */
export function escapeDroppedPath(p: string): string {
  return p.replace(/([ \t"'`\\()&;|<>$!*?[\]{}#~])/g, '\\$1')
}

/** Extension for a clipboard blob that arrives with no filename, keyed off its MIME type. A
 *  screenshot is `image/png` with an empty `name`, and an agent asked to look at `pasted-<ts>`
 *  with no suffix has to guess what it is holding. */
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'application/pdf': 'pdf',
  'text/plain': 'txt'
}

const CANVAS_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'svg',
  'avif'
])
const CANVAS_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  'image/svg+xml',
  'image/avif'
])

/** Only image files become canvas preview nodes; other dropped files keep the existing no-op. */
export function canvasImageFiles(files: File[]): File[] {
  return files.filter((file) => {
    if (CANVAS_IMAGE_MIME.has(file.type.toLowerCase())) return true
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    return CANVAS_IMAGE_EXTENSIONS.has(ext)
  })
}

/** The name to store a file under. Clipboard bytes usually have none, so one is generated from
 *  the MIME type + a timestamp — recognizable in a prompt and unique enough to read back. */
export function uploadNameFor(file: { name: string; type: string }): string {
  if (file.name) return file.name
  const ext = EXT_BY_TYPE[file.type] ?? (file.type.split('/')[1] || 'bin')
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-')
  return `pasted-${stamp}.${ext}`
}

/** Files carried by a paste. Chromium exposes an OS file-manager copy on `files`, and raw
 *  clipboard bytes (a screenshot) as an `items` entry of kind 'file' — read both, since a paste
 *  that carries neither must fall through to xterm as ordinary text. */
export function pastedFiles(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const files = Array.from(dt.files)
  if (files.length) return files
  return Array.from(dt.items)
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f)
}

/** True when the paste carried text. That text is xterm's to handle — and its ABSENCE, on a paste
 *  that carried no files either, is the signature of the filtered clipboard `clipboardImages`
 *  exists for. */
export function pasteHasText(dt: DataTransfer | null): boolean {
  return !!dt && !!dt.getData('text/plain')
}

/**
 * Images that are ON the clipboard but that the paste event refused to hand over.
 *
 * Chromium fills `clipboardData` only with formats the paste TARGET can hold, and the element
 * holding focus inside a terminal node is xterm's helper `<textarea>` — text, and nothing else. A
 * clipboard carrying just a screenshot has no text flavour to survive that filter, so the handler
 * is handed an EMPTY `clipboardData` (files 0, items []) and the paste looks like it did nothing.
 * Observed on Chrome/Windows against the Server Edition; it is why apps that accept pasted images
 * focus a `contenteditable` rather than a textarea.
 *
 * The async Clipboard API is not filtered by the focused element, so ask it directly. It needs a
 * secure context and the `clipboard-read` permission (granted once per origin, prompted on first
 * use); a browser without either, or a user who declines, resolves to [] and the paste stays the
 * no-op it already was. Never throws — same fail-open contract as the rest of this module.
 */
export async function clipboardImages(): Promise<File[]> {
  try {
    if (!navigator.clipboard?.read) return []
    const out: File[] = []
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (!type) continue
      const blob = await item.getType(type)
      // Named here rather than left to `localPathFor`: the upload overlay prints this name, and
      // the clipboard hands over a bare Blob with none.
      out.push(new File([blob], uploadNameFor({ name: '', type }), { type }))
    }
    return out
  } catch {
    return []
  }
}

const readAsBase64 = (file: File): Promise<string | null> =>
  new Promise((resolve) => {
    const reader = new FileReader()
    reader.onerror = () => resolve(null)
    reader.onload = () => {
      const res = typeof reader.result === 'string' ? reader.result : ''
      const comma = res.indexOf(',')
      resolve(comma >= 0 ? res.slice(comma + 1) : null)
    }
    reader.readAsDataURL(file)
  })

/**
 * The file's path ON THE MACHINE THE TERMINAL RUNS ON.
 *
 * A desktop drag-drop already has one (Electron can name the OS file), and using it copies
 * nothing. Everything else has bytes and no usable path — clipboard images have never been a file
 * anywhere, and a browser client's file lives on a different machine entirely — so the bytes are
 * written into the managed uploads dir over there and THAT path is what the terminal gets.
 */
/**
 * Where bytes with no usable path get written. The default is the managed uploads staging area,
 * which is right for a terminal paste — the path is consumed within seconds. A CANVAS image is
 * remembered in project.json instead, so it passes a sink that writes somewhere equally durable
 * (`canvasImageSink`); the choice belongs to the caller because only it knows how long the path
 * has to stay true.
 */
export type UploadSink = (name: string, dataBase64: string) => Promise<string | null>

const uploadsSink: UploadSink = (name, data) => window.nodeTerminal.files.saveUpload(name, data)

/** Store into the project's own `.nodeterm/images/` — see core/canvas-images.ts for the fallbacks
 *  (SSH project / relay tab / cwd-less canvas all land in a durable app-local folder instead). */
export const canvasImageSink =
  (projectId: string): UploadSink =>
  (name, data) =>
    window.nodeTerminal.files.saveCanvasImage(projectId, name, data)

async function localPathFor(file: File, sink: UploadSink): Promise<string | null> {
  const direct = window.nodeTerminal.getPathForFile(file)
  if (direct) return direct
  const data = await readAsBase64(file)
  if (!data) return null
  return sink(uploadNameFor(file), data).catch(() => null)
}

async function localFilesWithPaths(
  files: File[],
  sink: UploadSink
): Promise<Array<{ file: File; path: string }>> {
  const local = await Promise.all(files.map((f) => localPathFor(f, sink).catch(() => null)))
  return files
    .map((file, i) => ({ file, path: local[i] }))
    .filter((pair): pair is { file: File; path: string } => !!pair.path)
}

/** Resolve local/clipboard/browser files to raw local paths for non-terminal consumers. `sink` is
 *  required: only the caller knows how long the returned path has to stay true, and defaulting it
 *  to the 7-day staging area is exactly the wrong answer for the one caller there is. */
export async function localPathsForFiles(files: File[], sink: UploadSink): Promise<string[]> {
  return (await localFilesWithPaths(files, sink)).map((pair) => pair.path)
}

/**
 * Resolve dropped/pasted files to terminal-pasteable paths. For an SSH-project terminal a local
 * path is useless on the host, so each file is uploaded over the project's ControlMaster and its
 * REMOTE absolute path is returned; for a local terminal the local path is used. Fail-open: files
 * that can't be resolved/uploaded are dropped from the result (never throws).
 */
export async function droppedPaths(
  files: File[],
  opts: { sshRemoteTmux: boolean; projectId: string }
): Promise<string[]> {
  const pairs = await localFilesWithPaths(files, uploadsSink)
  if (!opts.sshRemoteTmux) return pairs.map((p) => escapeDroppedPath(p.path))
  const uploaded = await Promise.all(
    pairs.map((p) =>
      window.nodeTerminal.sshProject
        .uploadFile(opts.projectId, p.path, uploadNameFor(p.file))
        .catch(() => null)
    )
  )
  return uploaded.filter((p): p is string => !!p).map(escapeDroppedPath)
}
