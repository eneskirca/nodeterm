/**
 * The prompts typed into each agent node, shown as the bar under a node's header so a canvas of many
 * sessions still says what each one is for (`nodes/NodePromptBar.tsx`).
 *
 * MACHINE-LOCAL ON PURPOSE: this lives in localStorage, never in `node.data`. `.nodeterm/project.json`
 * is git-shared, and a prompt is free text that can hold a pasted token or a customer's name; a note
 * to self must not ride a commit. The same reason `agentStatus` keeps session ids here.
 *
 * It is the LOCAL core's store, fed by the same `agent:status` listener as `useAgentStatus`. Entries
 * start when the feature starts: a session that was already running has no earlier prompts here.
 *
 * STORAGE IS THE SOURCE OF TRUTH, the in-memory map is a cache of it. Two windows on one origin (a
 * second desktop window, two Server Edition tabs) each hold a copy, and a store that mutated its own
 * copy and wrote the whole map back would erase whatever the other window saved since boot. So every
 * mutation re-reads the saved map first and applies itself to THAT, and the `storage` event (which
 * the browser fires in every OTHER window on a write) refreshes this window's copy. A blocked or
 * unreadable localStorage falls back to the in-memory copy, so the bar still works for this run.
 *
 * BOUNDED: `fitStoreBudget` keeps the whole key under `NODE_PROMPT_STORE_MAX_BYTES` by dropping the
 * oldest prompts across nodes, and the boot sweep (`prune`, fed by `liveNodeIds`) drops nodes that
 * are in no project — a node deleted on another machine, or by a path that never reached `drop`,
 * would otherwise stay here forever.
 */
import { create } from 'zustand'
import {
  appendPrompt,
  fitStoreBudget,
  isNodePrompt,
  NODE_PROMPT_STORE_MAX_BYTES,
  prunePromptNodes,
  rememberPrompt,
  removePrompt,
  type NodePrompt,
  type PromptsById
} from '@shared/node-prompts'

const KEY = 'nodeterm.nodePrompts'

interface NodePromptsStore {
  byId: PromptsById
  /** TRANSIENT: nodes whose bar shows every prompt instead of only the latest. Never persisted —
   *  the compact bar is the default on every boot, since it is what keeps a busy canvas readable. */
  expanded: Readonly<Record<string, true>>
  /** Remember a submitted prompt for `nodeId`. Anything the person did not write is ignored. */
  record(nodeId: string, submitted: unknown, now?: number): void
  remove(nodeId: string, promptId: string): void
  /** The node is gone for good. */
  drop(nodeId: string): void
  /** Drop every node not in `live`. `null` = the caller cannot say which nodes are live (an
   *  incomplete project load) — then nothing is dropped. */
  prune(live: ReadonlySet<string> | null): void
  setExpanded(nodeId: string, expanded: boolean): void
}

function parse(raw: string | null): PromptsById {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, readonly NodePrompt[]> = {}
    for (const [nodeId, list] of Object.entries(parsed)) {
      if (!Array.isArray(list)) continue
      const kept = list.filter(isNodePrompt)
      if (kept.length > 0) out[nodeId] = kept
    }
    return out
  } catch (err) {
    console.warn('[prompts] the saved prompts are unreadable, starting empty:', err)
    return {}
  }
}

/** The saved map, or null when storage cannot be read at all (blocked, private mode, no window). */
function readSaved(): PromptsById | null {
  try {
    return parse(localStorage.getItem(KEY))
  } catch (err) {
    console.warn('[prompts] could not read the saved prompts:', err)
    return null
  }
}

/**
 * Write the map, trimmed to the byte budget. A quota error is retried ONCE at half the budget —
 * the origin's quota is shared with every other key, so "fits our budget" is not "fits" — and a
 * second failure is reported, never swallowed. Returns what was actually written (or, on failure,
 * what should have been), so the in-memory copy matches the disk copy.
 */
function save(byId: PromptsById): PromptsById {
  const fitted = fitStoreBudget(byId, NODE_PROMPT_STORE_MAX_BYTES)
  try {
    localStorage.setItem(KEY, JSON.stringify(fitted))
    return fitted
  } catch (first) {
    const halved = fitStoreBudget(fitted, NODE_PROMPT_STORE_MAX_BYTES / 2)
    try {
      localStorage.setItem(KEY, JSON.stringify(halved))
      console.warn('[prompts] storage was full; kept the newest prompts only:', first)
      return halved
    } catch (err) {
      console.warn('[prompts] could not save the prompts (storage full or blocked):', err)
      return fitted
    }
  }
}

/**
 * Unique within one node's list, which is all the × needs. Not `crypto.randomUUID()`: the Server
 * Edition can be served over plain HTTP on a LAN, where that API does not exist, and a throw here
 * would escape into the agent-status listener that calls `record`.
 */
function newPromptId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Replace one node's list, deleting the key when it empties so the file never grows empty rows. */
function withList(byId: PromptsById, nodeId: string, list: readonly NodePrompt[]): PromptsById {
  if (list.length > 0) return { ...byId, [nodeId]: list }
  const { [nodeId]: _gone, ...rest } = byId
  return rest
}

export const useNodePrompts = create<NodePromptsStore>((set, get) => {
  /** The map a mutation starts from: the saved one (another window may have written since), else ours. */
  const current = (): PromptsById => readSaved() ?? get().byId
  const commit = (next: PromptsById): void => {
    set({ byId: save(next) })
  }
  return {
    byId: readSaved() ?? {},
    expanded: {},

    record: (nodeId, submitted, now = Date.now()) => {
      const remembered = rememberPrompt(submitted)
      if (!remembered) return
      const byId = current()
      const list = byId[nodeId] ?? []
      const next = appendPrompt(list, { id: newPromptId(now), at: now, ...remembered })
      if (next !== list) commit(withList(byId, nodeId, next))
      else if (byId !== get().byId) set({ byId })
    },

    remove: (nodeId, promptId) => {
      const byId = current()
      const list = byId[nodeId]
      if (!list) return
      const next = removePrompt(list, promptId)
      if (next !== list) commit(withList(byId, nodeId, next))
    },

    drop: (nodeId) => {
      const byId = current()
      if (!byId[nodeId]) return
      commit(withList(byId, nodeId, []))
    },

    prune: (live) => {
      if (!live) return
      const byId = current()
      const next = prunePromptNodes(byId, live)
      if (next !== byId) commit(next)
      else if (byId !== get().byId) set({ byId })
    },

    setExpanded: (nodeId, expanded) => {
      const { expanded: cur } = get()
      if (!!cur[nodeId] === expanded) return
      if (expanded) return set({ expanded: { ...cur, [nodeId]: true } })
      const { [nodeId]: _gone, ...rest } = cur
      set({ expanded: rest })
    }
  }
})

// Another window on this origin wrote the key: adopt its map. The event never fires in the window
// that wrote, so this cannot loop, and `parse` shape-checks the value like any load.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return
    useNodePrompts.setState({ byId: parse(e.newValue) })
  })
}

/**
 * The agent-status listener's one call: a `newTurn` event that carries the submitted text is a
 * prompt the person typed. Every other event — a tool call, a subagent's queued
 * `<task-notification>` (which the normalizer sends without `newTurn`), an agent whose hook does not
 * carry the text — records nothing.
 */
export function recordSubmittedPrompt(event: { nodeId: string; newTurn?: boolean; task?: string }): void {
  if (event.newTurn && event.task) useNodePrompts.getState().record(event.nodeId, event.task)
}
