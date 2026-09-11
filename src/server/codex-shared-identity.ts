/**
 * Server Edition wiring for the same shared Codex identity spine the Electron shell uses.
 *
 * Core owns the launcher, thread RPC, signed ownership records, and capability probe. The server
 * shell contributes only its live-node lookup and broadcast channel. Keeping this composition in
 * one function makes the headless production path behavior-testable without booting an HTTP server.
 */
import { IPC } from '../shared/ipc'
import type { CodexIdentityEvent } from '../shared/types'
import { hookServer } from '../core/agents/hook-server'
import {
  bindCodexThreadIdentity,
  writeCodexThreadIdentity
} from '../core/codex-identity-proxy'
import { refreshCodexIdentityCaps } from '../core/codex-identity-caps'
import { codexThreadExists, startCodexThread } from '../core/codex-session-name'

type SharedIdentityHook = Pick<
  typeof hookServer,
  'setCodexIdentityListener' | 'setCodexThreadStartHandler' | 'setCodexThreadBindHandler'
>

type NodeLookup = { getNode(nodeId: string): unknown }

export interface ServerCodexIdentityDeps {
  refresh(): Promise<unknown>
  start(cwd: string): Promise<string>
  exists(threadId: string): Promise<boolean>
  write(
    threadId: string,
    nodeId: string,
    hookEndpoint: string,
    root?: string,
    accountId?: string
  ): void
  bind(
    threadId: string,
    nodeId: string,
    hookEndpoint: string,
    nodeIsLive: (nodeId: string) => boolean,
    root?: string,
    accountId?: string
  ): void
}

const defaultDeps: ServerCodexIdentityDeps = {
  refresh: refreshCodexIdentityCaps,
  start: startCodexThread,
  exists: codexThreadExists,
  write: writeCodexThreadIdentity,
  bind: bindCodexThreadIdentity
}

/** Arm shared-thread launch/bind behavior and publish identity-mode changes to browser clients. */
export async function wireServerCodexSharedIdentity(
  hooks: SharedIdentityHook,
  nodes: NodeLookup,
  broadcast: (channel: string, event: CodexIdentityEvent) => void,
  deps: ServerCodexIdentityDeps = defaultDeps
): Promise<void> {
  hooks.setCodexIdentityListener((event) => broadcast(IPC.codexIdentity, event))
  hooks.setCodexThreadStartHandler(async ({ nodeId, cwd, hookEndpoint, accountId }) => {
    const threadId = await deps.start(cwd)
    deps.write(threadId, nodeId, hookEndpoint, undefined, accountId)
    return threadId
  })
  hooks.setCodexThreadBindHandler(
    async ({ nodeId, threadId, hookEndpoint, accountId }) => {
      // Never write an ownership record for a rollout the shared app-server cannot resume. The
      // launcher interprets this refusal as its safe plain-Codex fallback.
      if (!(await deps.exists(threadId))) {
        throw new Error('Codex thread is unknown to the shared app-server')
      }
      deps.bind(
        threadId,
        nodeId,
        hookEndpoint,
        (ownerId) => !!nodes.getNode(ownerId),
        undefined,
        accountId
      )
    }
  )
  await deps.refresh()
}
