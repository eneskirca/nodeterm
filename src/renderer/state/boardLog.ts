import { create } from 'zustand'
import { BOARD_LOG_TEXT_MAX, type BoardLogEntry, type NodeTerminalApi } from '@shared/types'
import { loadIdentity } from './presence'
import { uuid } from '../lib/uuid'

/**
 * Board-log store — the renderer view of a project's append-only board history
 * (`.nodeterm/board-log.jsonl`, project-routed by the `boardLog` api). One entry list per
 * project id; the modal's "Comments & activity" panel reads it and appends to it.
 *
 * The api is passed IN (never captured off `window.nodeTerminal`): a remote project's board log
 * lives on its host and is reached through that session's api, so every call takes the api the
 * caller resolved for the project (Canvas uses its session api; the panel uses `useSession()`).
 *
 * `append` is OPTIMISTIC + fire-and-forget: it stamps the entry, prepends it locally (the log is
 * newest-first, matching `read`), and calls `api.boardLog.append` without awaiting — on a `false`
 * result or a rejection it raises a quiet per-project `error` flag (the local entry stays; the
 * next change-push reload reconciles). `read` is authoritative: it REPLACES the list, so our own
 * appended entry (same client-generated id, persisted verbatim) never duplicates on reload.
 */

/** The default author when the user has never picked a presence identity. */
const ANON_AUTHOR = { name: 'you', color: '#8e8e93' }

/** Shared stable empty list — a project with no loaded entries returns this exact array, so a
 *  reactive selector does not see a fresh `[]` (and re-render) on every unrelated store write. */
const EMPTY: BoardLogEntry[] = []

/** The caller-supplied part of an entry; the store stamps `id`/`ts`/`author`. */
export type BoardLogAppendInput = Pick<BoardLogEntry, 'kind' | 'nodeId' | 'text' | 'event'>

interface BoardLogState {
  /** Loaded entries per project id, NEWEST-FIRST. */
  entriesByProject: Record<string, BoardLogEntry[]>
  /** Projects whose log is unreachable (inline/no-cwd, disconnected SSH, server-side SSH). */
  unsupportedByProject: Record<string, boolean>
  /** Quiet flag: an append failed for this project (the local entry is still shown). */
  errorByProject: Record<string, boolean>
  /** The entries for a project (stable empty array when none are loaded). */
  entriesFor(projectId: string): BoardLogEntry[]
  /** Read the log for a project and replace its list; records the unsupported/clears error flags. */
  load(api: NodeTerminalApi, projectId: string): Promise<void>
  /** Stamp + optimistically prepend an entry, then fire-and-forget the api append. */
  append(api: NodeTerminalApi, projectId: string, input: BoardLogAppendInput): void
  /** Wire `onChanged` → reload for a project; returns the unsubscribe. */
  subscribeChanged(api: NodeTerminalApi, projectId: string): () => void
}

export const useBoardLog = create<BoardLogState>((set, get) => ({
  entriesByProject: {},
  unsupportedByProject: {},
  errorByProject: {},

  entriesFor: (projectId) => get().entriesByProject[projectId] ?? EMPTY,

  load: async (api, projectId) => {
    try {
      const res = await api.boardLog.read(projectId)
      set((s) => ({
        entriesByProject: { ...s.entriesByProject, [projectId]: res.entries },
        unsupportedByProject: { ...s.unsupportedByProject, [projectId]: !!res.unsupported },
        // A successful read supersedes any stale append error for this project.
        errorByProject: { ...s.errorByProject, [projectId]: false }
      }))
    } catch {
      // A failed read leaves the last-known list untouched — never blank the panel on a hiccup.
    }
  },

  append: (api, projectId, input) => {
    const id = loadIdentity()
    const author = id ? { name: id.name, color: id.color } : ANON_AUTHOR
    // Clamp identically to buildLine (src/core/board-log.ts) so the optimistic entry the user sees
    // matches what lands on disk — an over-long paste would otherwise silently truncate on reload
    // (and, over SSH, fail the append entirely and vanish).
    const text =
      input.text !== undefined && input.text.length > BOARD_LOG_TEXT_MAX
        ? input.text.slice(0, BOARD_LOG_TEXT_MAX) + '…'
        : input.text
    const entry: BoardLogEntry = {
      id: uuid(),
      ts: Date.now(),
      author,
      kind: input.kind,
      ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(input.event !== undefined ? { event: input.event } : {})
    }
    // Optimistic newest-first insert.
    set((s) => ({
      entriesByProject: {
        ...s.entriesByProject,
        [projectId]: [entry, ...(s.entriesByProject[projectId] ?? EMPTY)]
      }
    }))
    const flagError = () =>
      set((s) => ({ errorByProject: { ...s.errorByProject, [projectId]: true } }))
    api.boardLog
      .append(projectId, entry)
      .then((ok) => {
        if (!ok) flagError()
      })
      .catch(flagError)
  },

  subscribeChanged: (api, projectId) =>
    api.boardLog.onChanged(projectId, () => {
      void get().load(api, projectId)
    })
}))
