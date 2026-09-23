import { useEffect, useState } from 'react'
import { useSettings } from '../../state/settings'
import { INTEGRATION_AGENTS, INTEGRATION_FILES, integrationChoice, integrationHostKey } from '@shared/agent-integrations'
import type { SshConnection } from '@shared/ssh'
import { Button } from '@renderer/ui/Button'

/** Same persisted machine-local decision on Desktop and Server; remote choices never ride project.json. */
export function IntegrationConsent({ connection }: { connection?: SshConnection }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const [retained, setRetained] = useState<string[]>([])
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      void window.nodeTerminal.settings.integrationStatus?.().then((s) => {
        if (active) setRetained(s.retained)
      }).catch(() => {})
    }, 1000)
    return () => { active = false; clearTimeout(timer) }
  }, [settings.agentIntegrations])
  const choose = (agent: typeof INTEGRATION_AGENTS[number], value: boolean): void => {
    const consent = settings.agentIntegrations ?? {}
    update({ agentIntegrations: connection
      ? { ...consent, remote: { ...consent.remote, [integrationHostKey(connection)]: {
          ...consent.remote?.[integrationHostKey(connection)], [agent]: value
        } } }
      : { ...consent, local: { ...consent.local, [agent]: value } } })
  }
  return <div className="space-y-3 rounded-lg border border-border p-3 text-sm">
    <p className="font-medium">Agent integration setup — {connection ? `${connection.user}@${connection.host}:${connection.port ?? 22}` : 'this computer (server host in Server Edition)'}</p>
    <p>Optional hooks enable agent status, completion notifications and context updates. Without them terminals still work; hook-based features may be unavailable. Existing installations need a new choice too.</p>
    <p>Enable authorizes the files below and hook scripts in ~/.nodeterm. Local Claude and Codex get on-demand skills; global instruction files are never injected. Disable removes identifiable entries; edited or unrecognized files are preserved. Remove integrations here before uninstalling: deleting the app alone cannot clean them up.</p>
    {connection && <p>These choices apply only to this SSH connection. Connected hosts are updated now; offline hosts are updated at the next connection. Edited legacy files and remote account skills may require manual cleanup.</p>}
    {INTEGRATION_AGENTS.filter((agent) => !connection || agent !== 'opencode').map((agent) => {
      const choice = integrationChoice(settings.agentIntegrations, agent, connection)
      return <div key={agent} className="space-y-1 border-t border-border pt-2">
        <p><strong>{agent}</strong> — {choice === true ? 'Enabled' : choice === false ? 'Disabled' : 'Not enabled — choose below'}</p>
        <p className="text-xs text-muted">{INTEGRATION_FILES[agent]}</p>
        <div className="flex gap-2">
          <Button onClick={() => choose(agent, true)} disabled={choice === true}>Enable integration</Button>
          <Button onClick={() => choose(agent, false)} disabled={choice === false}>{choice === undefined ? 'Decline and clean up' : 'Disable and clean up'}</Button>
        </div>
      </div>
    })}
    {retained.length > 0 && <div role="status"><p>Preserved files need manual review (edited or ownership unknown):</p>{retained.map((file) => <p key={file} className="break-all text-xs">{file}</p>)}</div>}
    <p className="text-xs text-muted">Legacy fullscreen preferences and unrecognized historical files are left in place. Restart agent sessions after changing integrations.</p>
  </div>
}
