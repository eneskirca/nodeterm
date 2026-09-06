import { readLocal, writeLocal } from './localStore'

// Whether the bottom-left canvas lock was left engaged. Written and read ONLY while
// `settings.rememberCanvasLock` is on (default off): the lock is transient by design, because a
// canvas that will not pan on the next launch reads as "the app is frozen" to whoever opens it.
// The setting is the opt-in for people who lock deliberately; Canvas owns that gate, this leaf
// just stores the bit.
//
// PERSONAL: localStorage, never settings.json and never the git-shared .nodeterm/project.json
// (same rule as the view mode and the card comments panel). The SETTING says whether to remember;
// the lock itself is one person's view state, not a property of the canvas everyone clones.
// Machine-local on Desktop. In the Server Edition the renderer is shared, so the setting lives in
// that server's settings.json while this bit is per browser PROFILE: two profiles on one machine
// can have the setting on and still disagree about the lock, which is correct for view state.
//
// GLOBAL rather than per-project, because that is what the lock already did: <Canvas /> is mounted
// once and is not keyed by project, so the flag has always carried across project switches within
// a session. Remembering one global bit extends the status quo instead of introducing a second
// rule; a per-project map would also owe the dead-id pruning `sidebarCollapsedItems` does.
//
// Default OFF, and an unreadable store reads as OFF: a lock that cannot be cleared because the
// read failed is the bad direction, and a canvas that opens unlocked costs one click.

export const CANVAS_LOCK_KEY = 'nodeterm.canvasLocked'

/** `'1'` is locked; missing, `'0'`, or anything else is unlocked. */
export function parseCanvasLocked(raw: string | null): boolean {
  return raw === '1'
}

export function readCanvasLocked(): boolean {
  return parseCanvasLocked(readLocal(CANVAS_LOCK_KEY))
}

export function writeCanvasLocked(locked: boolean): void {
  writeLocal(CANVAS_LOCK_KEY, locked ? '1' : '0')
}
