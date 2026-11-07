import { create } from 'zustand'
import type { SetStateAction } from 'react'
import { readLocal, writeLocal } from '../lib/localStore'

/**
 * The ⌘M composer's draft per node, kept OUTSIDE ChatPanel. The panel unmounts whenever its node
 * does — a project switch, a park expiry, a project reopened — and a draft in component state went
 * with it. Keyed by node id, so the canvas node's composer and the kanban card modal's composer for
 * the same session show one draft. An empty draft removes its entry.
 *
 * PERSISTED in localStorage (`nodeterm.chatDrafts`), so a draft also survives a reload and an app
 * restart, as the agent's own TUI input box does by living in tmux. Machine-local: never
 * settings.json, never the git-shared project file. In the Server Edition it is per browser profile.
 * - Written half a second after the last change, and flushed when the page hides or unloads.
 * - Each write re-reads the stored map and changes only the drafts THIS window changed, so two
 *   browser tabs on one Server Edition do not erase each other's drafts.
 * - Bounded: entries older than 30 days are dropped, at most 50 drafts are kept (newest first), and a
 *   draft longer than 32,000 characters stays in memory but is not stored. Pruned by age and count,
 *   not by "does the node still exist": a closed project keeps its nodes, so a node missing from the
 *   open canvases is not evidence that its draft is dead.
 * - The stored file is hand-editable input: anything that is not a well-formed entry is dropped.
 */

export const CHAT_DRAFTS_KEY = 'nodeterm.chatDrafts'
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const DRAFTS_MAX = 50
export const DRAFT_STORE_MAX_CHARS = 32_000
export const DRAFT_SAVE_DELAY_MS = 500

interface StoredDraft {
  text: string
  at: number
}
type StoredDrafts = Record<string, StoredDraft>

const NODE_ID = /^[A-Za-z0-9._:-]{1,128}$/

/** The stored map, with every malformed, empty, oversized or expired entry dropped. */
export function parseStoredDrafts(raw: string | null, now: number): StoredDrafts {
  if (raw === null || raw === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const drafts = (parsed as { v?: unknown; drafts?: unknown }).drafts
  if ((parsed as { v?: unknown }).v !== 1 || drafts === null || typeof drafts !== 'object' || Array.isArray(drafts)) {
    return {}
  }
  const out: StoredDrafts = {}
  for (const [nodeId, entry] of Object.entries(drafts as Record<string, unknown>)) {
    if (!NODE_ID.test(nodeId) || entry === null || typeof entry !== 'object') continue
    const { text, at } = entry as { text?: unknown; at?: unknown }
    if (typeof text !== 'string' || text === '' || text.length > DRAFT_STORE_MAX_CHARS) continue
    if (typeof at !== 'number' || !Number.isFinite(at) || at > now + 60_000 || now - at > DRAFT_MAX_AGE_MS) continue
    out[nodeId] = { text, at }
  }
  return keepNewest(out)
}

/** At most DRAFTS_MAX entries, the most recently changed. */
function keepNewest(drafts: StoredDrafts): StoredDrafts {
  const entries = Object.entries(drafts)
  if (entries.length <= DRAFTS_MAX) return drafts
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, DRAFTS_MAX))
}

/** Applies this window's changes (`null` = removed) to the stored map. */
export function mergeStoredDrafts(
  stored: StoredDrafts,
  changes: ReadonlyMap<string, StoredDraft | null>
): StoredDrafts {
  const next = { ...stored }
  for (const [nodeId, entry] of changes) {
    if (entry === null || entry.text.length > DRAFT_STORE_MAX_CHARS) delete next[nodeId]
    else next[nodeId] = entry
  }
  return keepNewest(next)
}

/** Drafts this window changed since its last write: node id → the new draft, or null if removed. */
const pending = new Map<string, StoredDraft | null>()
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** Writes this window's pending changes now. */
export function flushChatDrafts(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (pending.size === 0) return
  const stored = parseStoredDrafts(readLocal(CHAT_DRAFTS_KEY), Date.now())
  const drafts = mergeStoredDrafts(stored, pending)
  pending.clear()
  writeLocal(CHAT_DRAFTS_KEY, JSON.stringify({ v: 1, drafts }))
}

function scheduleSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushChatDrafts, DRAFT_SAVE_DELAY_MS)
}

function loadDrafts(): Record<string, string> {
  const stored = parseStoredDrafts(readLocal(CHAT_DRAFTS_KEY), Date.now())
  return Object.fromEntries(Object.entries(stored).map(([nodeId, d]) => [nodeId, d.text]))
}

interface ChatDraftState {
  drafts: Record<string, string>
  /** One line the composer shows about its draft (lib/chatDraftCarry.ts: why a terminal draft was
   *  not carried over). In memory only; any change to that node's draft clears it. */
  notes: Record<string, string>
  /** Sets one node's draft; a function gets the current draft, as React's state setter does. */
  setDraft(nodeId: string, next: SetStateAction<string>): void
  setNote(nodeId: string, note: string | null): void
}

export const useChatDraft = create<ChatDraftState>((set) => ({
  drafts: loadDrafts(),
  notes: {},
  setDraft: (nodeId, next) =>
    set((s) => {
      const cur = s.drafts[nodeId] ?? ''
      const value = typeof next === 'function' ? next(cur) : next
      if (value === cur) return s
      const drafts = { ...s.drafts }
      if (value === '') delete drafts[nodeId]
      else drafts[nodeId] = value
      pending.set(nodeId, value === '' ? null : { text: value, at: Date.now() })
      scheduleSave()
      if (s.notes[nodeId] === undefined) return { drafts }
      const notes = { ...s.notes }
      delete notes[nodeId]
      return { drafts, notes }
    }),
  setNote: (nodeId, note) =>
    set((s) => {
      if ((s.notes[nodeId] ?? null) === note) return s
      const notes = { ...s.notes }
      if (note === null) delete notes[nodeId]
      else notes[nodeId] = note
      return { notes }
    })
}))

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushChatDrafts)
  window.addEventListener('beforeunload', flushChatDrafts)
}
