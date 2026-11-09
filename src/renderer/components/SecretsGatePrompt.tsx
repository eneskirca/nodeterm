import { answerCrossProjectSecrets, useSecretsGate } from '../state/secretsGate'
import { crossProjectPromptText } from '../lib/projectSecrets'

/**
 * The question a terminal node shows while it waits to start (policy 'ask',
 * docs/project-secrets.md): an agent of another project opened it, and only the person decides
 * whether it receives this project's secrets. Names only, never a value. Neither button is focused
 * by default, so a keystroke aimed elsewhere cannot answer it.
 */
export function SecretsGatePrompt({ nodeId }: { nodeId: string }) {
  const pending = useSecretsGate((s) => s.pending[nodeId])
  if (!pending) return null
  return (
    <div className="term-node__secrets-gate nodrag nowheel" role="dialog" aria-label="Give this node the project's secrets?">
      <div className="term-node__secrets-gate-box">
        <p>{crossProjectPromptText(pending.projectName, pending.names)}</p>
        <p className="secrets-dialog__hint">
          The terminal starts after you answer. Without them it starts as usual, with no access to these values.
        </p>
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={() => answerCrossProjectSecrets(nodeId, false)}>
            Start without
          </button>
          <button className="confirm__btn primary" onClick={() => answerCrossProjectSecrets(nodeId, true)}>
            Give secrets
          </button>
        </div>
      </div>
    </div>
  )
}
