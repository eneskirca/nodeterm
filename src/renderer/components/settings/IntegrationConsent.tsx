// Agent-integration consent UI (issue #744): the first-run question, the one-time notice for an
// install that was grandfathered, the per-SSH-host question, and the Settings → Agents rows.
//
// The CHOICE is `settings.agentIntegrations` (`@shared/agent-integrations`); saving it is all the
// renderer does — the host's lifecycle (core/agent-integrations.ts) reacts to the settings change
// and installs or cleans up. Every reader goes through the shared sanitizer.
import { useEffect, useState } from 'react'
import { useSettings } from '../../state/settings'
import {
  FEATURES_NEEDING_INTEGRATION,
  INTEGRATION_AGENT_IDS,
  agentChoice,
  answerIntegrationPrompt,
  hostChoice,
  integrationsOf,
  needsGrandfatherNotice,
  needsIntegrationPrompt,
  withAgentChoice,
  withHostChoice,
  withNoticeDismissed,
  type AgentIntegrationsStatus,
  type IntegrationAgentId,
  type IntegrationChoice
} from '@shared/agent-integrations'
import { AGENT_CONFIG } from '@shared/agents/config'
import { Button } from '@renderer/ui/Button'
import { AgentIcon } from '../../lib/agentIcons'
import { IconClose } from '../icons'

const labelOf = (id: IntegrationAgentId): string => AGENT_CONFIG[id]?.label ?? id

/** What an integration writes, in one sentence (the same words everywhere it is offered). */
export const INTEGRATION_WRITES =
  'nodeterm adds a status hook to each agent’s own settings and installs two small skills ' +
  '(canvas control, reading linked nodes) in its skills folder. Nothing is added to your ' +
  'AGENTS.md / GEMINI.md, and turning an agent off removes exactly what nodeterm added.'

export const INTEGRATION_UNAVAILABLE =
  `Terminals always work. Without an integration, that agent has no ${FEATURES_NEEDING_INTEGRATION.join('; no ')}.`

function useSave(): (next: ReturnType<typeof useSettings.getState>['settings']) => void {
  const update = useSettings((s) => s.update)
  return (next) => update({ agentIntegrations: next.agentIntegrations })
}

/** The first-run question (a new install that has not answered). Nothing global is written until
 *  it is answered; "Not now" records a decline, so it is asked once. */
export function IntegrationPromptBanner({ onChoose }: { onChoose: () => void }): React.JSX.Element | null {
  const settings = useSettings((s) => s.settings)
  const hydrated = useSettings((s) => s.hydrated)
  const save = useSave()
  if (!hydrated || !needsIntegrationPrompt(settings)) return null
  return (
    <div className="announce-banner announce-banner--info" role="status" data-testid="integration-prompt">
      <span className="announce-banner__dot" />
      <div className="announce-banner__content">
        <span className="announce-banner__title">Integrate nodeterm with your agent CLIs?</span>
        <span className="announce-banner__body">
          {INTEGRATION_WRITES} {INTEGRATION_UNAVAILABLE}
        </span>
      </div>
      <button
        className="announce-banner__btn"
        onClick={() => save({ ...settings, agentIntegrations: answerIntegrationPrompt([...INTEGRATION_AGENT_IDS]) })}
      >
        Enable all
      </button>
      <button className="announce-banner__btn" onClick={onChoose}>
        Choose…
      </button>
      <button
        className="announce-banner__btn"
        onClick={() => save({ ...settings, agentIntegrations: answerIntegrationPrompt([]) })}
      >
        Not now
      </button>
    </div>
  )
}

/** The one-time notice for an install from before this feature: everything it had stays on. */
export function IntegrationGrandfatherNotice({ onOpenSettings }: { onOpenSettings: () => void }): React.JSX.Element | null {
  const settings = useSettings((s) => s.settings)
  const hydrated = useSettings((s) => s.hydrated)
  const save = useSave()
  if (!hydrated || !needsGrandfatherNotice(settings)) return null
  const dismiss = (): void => save(withNoticeDismissed(settings))
  return (
    <div className="announce-banner announce-banner--info" role="status" data-testid="integration-notice">
      <span className="announce-banner__dot" />
      <div className="announce-banner__content">
        <span className="announce-banner__title">Agent integrations are now a choice</span>
        <span className="announce-banner__body">
          They stay on for every agent, as before. You can turn any agent (or any SSH host) off in
          Settings → Agents — nodeterm then removes exactly what it added.
        </span>
      </div>
      <button
        className="announce-banner__btn"
        onClick={() => {
          dismiss()
          onOpenSettings()
        }}
      >
        Review
      </button>
      <button className="announce-banner__close" title="Dismiss" aria-label="Dismiss" onClick={dismiss}>
        <IconClose />
      </button>
    </div>
  )
}

/** The per-host question: the active project's SSH host has no answer yet, so nothing was
 *  installed there. Shown only once the first-run question is answered. */
export function HostIntegrationBanner({ hostKey }: { hostKey: string | null }): React.JSX.Element | null {
  const settings = useSettings((s) => s.settings)
  const hydrated = useSettings((s) => s.hydrated)
  const save = useSave()
  if (!hydrated || !hostKey || needsIntegrationPrompt(settings)) return null
  if (hostChoice(settings, hostKey) !== undefined) return null
  if (!INTEGRATION_AGENT_IDS.some((a) => agentChoice(settings, a) === 'enabled')) return null
  return (
    <div className="announce-banner announce-banner--info" role="status" data-testid="host-integration-prompt">
      <span className="announce-banner__dot" />
      <div className="announce-banner__content">
        <span className="announce-banner__title">Integrate with the agents on {hostKey}?</span>
        <span className="announce-banner__body">
          nodeterm writes the same hooks and skills into your agent config on that host. Nothing is
          installed there until you say. {INTEGRATION_UNAVAILABLE}
        </span>
      </div>
      <button className="announce-banner__btn" onClick={() => save(withHostChoice(settings, hostKey, 'enabled'))}>
        Allow on this host
      </button>
      <button className="announce-banner__btn" onClick={() => save(withHostChoice(settings, hostKey, 'declined'))}>
        Not on this host
      </button>
    </div>
  )
}

function choiceText(c: IntegrationChoice | undefined): string {
  return c === 'enabled' ? 'On' : c === 'declined' ? 'Off' : 'Not asked'
}

/** Settings → Agents: one row per agent, the per-host answers, and what the host kept. */
export function IntegrationSettings(): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const save = useSave()
  const [status, setStatus] = useState<AgentIntegrationsStatus | null>(null)
  const sig = JSON.stringify(integrationsOf(settings))
  useEffect(() => {
    let live = true
    // Give the host a moment to reconcile after a save, then ask what it did.
    const t = setTimeout(() => {
      window.nodeTerminal.integrations
        ?.status()
        .then((s) => {
          if (live) setStatus(s)
        })
        .catch(() => {})
    }, 400)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [sig])
  const hosts = Object.entries(integrationsOf(settings).hosts ?? {})
  return (
    <div className="space-y-2" data-testid="integration-settings">
      <p className="text-[12px] text-muted">
        {INTEGRATION_WRITES} {INTEGRATION_UNAVAILABLE}
      </p>
      {status?.vetoed && (
        <p className="text-[12px] text-muted">
          This server was started with agent installs disabled, so nothing is written regardless of
          these choices.
        </p>
      )}
      {INTEGRATION_AGENT_IDS.map((id) => {
        const c = agentChoice(settings, id)
        return (
          <div key={id} className="flex items-center gap-3 py-1" data-testid={`integration-row-${id}`}>
            <AgentIcon agentId={id} size={18} />
            <span className="flex-1 text-[13px] text-text">{labelOf(id)}</span>
            <span className="text-[12px] text-muted">{choiceText(c)}</span>
            <Button
              variant={c === 'enabled' ? 'primary' : 'default'}
              onClick={() => save(withAgentChoice(settings, id, 'enabled'))}
              aria-label={`Enable the ${labelOf(id)} integration`}
            >
              Enable
            </Button>
            <Button
              variant={c === 'declined' ? 'primary' : 'default'}
              onClick={() => save(withAgentChoice(settings, id, 'declined'))}
              aria-label={`Turn off the ${labelOf(id)} integration and remove what nodeterm added`}
            >
              Decline &amp; clean up
            </Button>
          </div>
        )
      })}
      {hosts.length > 0 && (
        <div className="pt-2">
          <div className="text-[12px] text-muted pb-1">SSH hosts</div>
          {hosts.map(([host, c]) => (
            <div key={host} className="flex items-center gap-3 py-1" data-testid={`integration-host-${host}`}>
              <span className="flex-1 text-[13px] text-text">{host}</span>
              <span className="text-[12px] text-muted">{choiceText(c)}</span>
              <Button
                variant={c === 'enabled' ? 'primary' : 'default'}
                onClick={() => save(withHostChoice(settings, host, 'enabled'))}
              >
                Allow
              </Button>
              <Button
                variant={c === 'declined' ? 'primary' : 'default'}
                onClick={() => save(withHostChoice(settings, host, 'declined'))}
              >
                Decline &amp; clean up
              </Button>
            </div>
          ))}
        </div>
      )}
      {!!status?.retained.length && (
        <div className="pt-2 text-[12px] text-muted" data-testid="integration-retained">
          Kept because you changed them since nodeterm wrote them (remove by hand if you no longer
          want them):
          <ul className="list-disc pl-5">
            {status.retained.map((p) => (
              <li key={p} className="font-mono">
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
