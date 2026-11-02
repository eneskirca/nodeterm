import { create } from 'zustand'

/**
 * Pending cross-project secret questions, per node (docs/project-secrets.md, policy 'ask'). A node
 * opened in its project by an agent of ANOTHER project waits here, before its terminal starts,
 * until the person answers in that node. Transient: an app restart forgets every question, and the
 * node asks again on its next start (main forgets the answers too).
 */
interface Pending {
  projectName: string
  names: string[]
  resolve: (grant: boolean) => void
}

interface SecretsGateState {
  pending: Record<string, Omit<Pending, 'resolve'>>
}

const resolvers = new Map<string, (grant: boolean) => void>()

export const useSecretsGate = create<SecretsGateState>(() => ({ pending: {} }))

/** Ask the person in node `nodeId`. Resolves with their answer; `false` if the node goes away. */
export function askCrossProjectSecrets(nodeId: string, projectName: string, names: string[]): Promise<boolean> {
  // A second question for the same node replaces the first (its answer is "no").
  resolvers.get(nodeId)?.(false)
  return new Promise<boolean>((resolve) => {
    resolvers.set(nodeId, resolve)
    useSecretsGate.setState((s) => ({ pending: { ...s.pending, [nodeId]: { projectName, names } } }))
  })
}

/** The person's answer (or the node's teardown: `false`). */
export function answerCrossProjectSecrets(nodeId: string, grant: boolean): void {
  const resolve = resolvers.get(nodeId)
  resolvers.delete(nodeId)
  useSecretsGate.setState((s) => {
    if (!(nodeId in s.pending)) return s
    const next = { ...s.pending }
    delete next[nodeId]
    return { pending: next }
  })
  resolve?.(grant === true)
}
