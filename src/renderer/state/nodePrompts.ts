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
 */
import { create } from 'zustand'
import {
  appendPrompt,
  isNodePrompt,
  rememberPrompt,
  removePrompt,
  type NodePrompt
} from '@shared/node-prompts'

const KEY = 'nodeterm.nodePrompts'

type PromptsById = Record<string, readonly NodePrompt[]>

interface NodePromptsStore {
  byId: PromptsById
  /** Remember a submitted prompt for `nodeId`. Anything the person did not write is ignored. */
  record(nodeId: string, submitted: unknown, now?: number): void
  remove(nodeId: string, promptId: string): void
  /** The node is gone for good. */
  drop(nodeId: string): void
}

function load(): PromptsById {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch (err) {
    console.warn('[prompts] could not read the saved prompts:', err)
    return {}
  }
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: PromptsById = {}
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

function save(byId: PromptsById): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(byId))
  } catch (err) {
    console.warn('[prompts] could not save the prompts (storage full or blocked):', err)
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
  const commit = (next: PromptsById): void => {
    set({ byId: next })
    save(next)
  }
  return {
    byId: load(),

    record: (nodeId, submitted, now = Date.now()) => {
      const remembered = rememberPrompt(submitted)
      if (!remembered) return
      const { byId } = get()
      const current = byId[nodeId] ?? []
      const next = appendPrompt(current, { id: newPromptId(now), at: now, ...remembered })
      if (next !== current) commit(withList(byId, nodeId, next))
    },

    remove: (nodeId, promptId) => {
      const { byId } = get()
      const current = byId[nodeId]
      if (!current) return
      const next = removePrompt(current, promptId)
      if (next !== current) commit(withList(byId, nodeId, next))
    },

    drop: (nodeId) => {
      const { byId } = get()
      if (!byId[nodeId]) return
      commit(withList(byId, nodeId, []))
    }
  }
})

/**
 * The agent-status listener's one call: a `newTurn` event that carries the submitted text is a
 * prompt the person typed. Every other event — a tool call, a subagent's queued
 * `<task-notification>` (which the normalizer sends without `newTurn`), an agent whose hook does not
 * carry the text — records nothing.
 */
export function recordSubmittedPrompt(event: { nodeId: string; newTurn?: boolean; task?: string }): void {
  if (event.newTurn && event.task) useNodePrompts.getState().record(event.nodeId, event.task)
}
