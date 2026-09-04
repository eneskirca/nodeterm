/** True only for the actual React Flow pane, never flow-wrap overlays such as Welcome/Usage. */
export function isCanvasImageDropTarget(target: EventTarget | null, wrap: Element): boolean {
  const element = target instanceof Element ? target : null
  return !!(
    element &&
    wrap.contains(element) &&
    element.closest('.react-flow__pane') &&
    !element.closest('.react-flow__node, .react-flow__minimap')
  )
}

/** True for anywhere a folder-drop should be handled: canvas background, the Welcome screen,
 *  general app chrome (sidebar/dock backgrounds, tab strip empty area) — anywhere that isn't a
 *  more specific drop target (a terminal, an editor, a dialog, a form control, or a node body).
 *  Unlike isCanvasImageDropTarget this is NOT restricted to `.react-flow__pane`, because a
 *  folder drop must also work with no project open yet (the Welcome screen is an overlay, not
 *  necessarily inside the pane). */
export function isFolderDropTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  if (!element) return false
  // The Welcome screen's four nav cards (`.welcome__card`) are themselves <button> elements, so
  // without this carve-out the general `button` exclusion below would silently swallow a folder
  // dropped straight onto "Open folder…" — defeating the feature's own stated goal of working from
  // the Welcome screen. Every OTHER button (dialogs, terminal headers, form controls, …) still
  // falls through to the exclusion unchanged.
  if (element.closest('.welcome__card')) return true
  return !element.closest(
    'input, textarea, select, button, [contenteditable], [role="dialog"], ' +
      '.monaco-editor, .xterm, .react-flow__node'
  )
}

/** Directories among a drop's items, via the synchronous webkitGetAsEntry() check — this MUST
 *  run inside the drop handler itself, before any `await`: DataTransferItem entries are only
 *  valid for the duration of the originating event. */
export function droppedDirectories(dt: DataTransfer | null): File[] {
  if (!dt) return []
  return Array.from(dt.items)
    .filter((it) => it.kind === 'file' && it.webkitGetAsEntry()?.isDirectory)
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f)
}

/**
 * Why a canvas image import cannot proceed, or null when it may. One rule, one message, so the
 * drop path and the paste path cannot disagree about either.
 *
 * A RELAY TAB is refused because the two halves of the feature would land on different machines:
 * the write is `window.nodeTerminal.files.saveCanvasImage` — the LOCAL preload, even in a relay
 * tab — while `EditorNode` reads through the session api, i.e. the PEER's core. The bytes would sit
 * on this disk and the node would ask the peer for that path, producing a node that can never
 * render. Refusing is not a limitation dressed up as a feature: a clear message is strictly better
 * than a broken node, and it is the same fact (`Project.remote`), read the same way, that already
 * gates Cmd+C's file copy. Routing the write to the peer instead is a real feature — it also needs
 * the Finder-drop shortcut bypassed, since a local OS path is just as unreadable over there — and
 * no file write in this app crosses that boundary today.
 */
export function canvasImportRefusal(projectIsRelay: boolean): string | null {
  return projectIsRelay
    ? 'Images can’t be added to a remote tab’s canvas — the file would stay on this machine, where that canvas can’t read it.'
    : null
}

export interface CanvasImagePlacement {
  filePath: string
  center: { x: number; y: number }
}

/**
 * Keyboard-opened UI must revoke a prior canvas click. Modifier keydown events are part of the
 * normal Cmd+V sequence, so only they and the actual paste chord preserve the armed state.
 */
export function canvasImagePasteArmedAfterKey(
  armed: boolean,
  event: { key: string; metaKey: boolean; ctrlKey: boolean }
): boolean {
  if (!armed) return false
  if (event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift') {
    return true
  }
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v'
}

/** Resolve image files asynchronously, but abandon them if their originating project changed. */
export async function guardedCanvasImagePlacements(
  resolvePaths: () => Promise<string[]>,
  originatingProjectId: string,
  activeProjectId: () => string,
  center: { x: number; y: number }
): Promise<CanvasImagePlacement[]> {
  const paths = await resolvePaths()
  if (activeProjectId() !== originatingProjectId) return []
  return paths.map((filePath, index) => ({
    filePath,
    center: { x: center.x + index * 36, y: center.y + index * 36 }
  }))
}
