import { useSettings } from '../../state/settings'
import { INTEGRATION_AGENTS } from '@shared/agent-integrations'
import { Button } from '@renderer/ui/Button'

export function IntegrationSetupNotice({ onConfigure }: { onConfigure: () => void }): React.JSX.Element | null {
  const hydrated = useSettings((s) => s.hydrated)
  const choices = useSettings((s) => s.settings.agentIntegrations?.local)
  if (!hydrated || INTEGRATION_AGENTS.some((a) => typeof choices?.[a] === 'boolean')) return null
  return <div role="status" className="fixed bottom-16 right-4 z-40 max-w-sm rounded-xl border border-border bg-panel p-4 text-sm shadow-lg">
    <p>Agent integrations are off until you choose. Terminals work, but status, context updates and completion notifications may be unavailable.</p>
    <p className="mt-2">Settings → Agents explains the files each optional integration changes. Existing installations also need permission.</p>
    <Button onClick={onConfigure}>Review integration setup</Button>
  </div>
}
