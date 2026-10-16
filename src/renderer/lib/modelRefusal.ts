// Refuse an unknown `--model` at open time — ONLY on a confident negative (issue #519).
//
// `--model` used to be a pure pass-through: an id the CLI does not know reached it verbatim and
// failed inside the session on its first turn, leaving an idle node that looks healthy (so every
// `--after` behind it armed against a station that never started). The only list this machine can
// check an id against is the model gateway's own catalogue (`agent:discover-models`, primed by
// Canvas into `useModelGateway`), and that list only describes what the agent can run when the
// agent actually TALKS to that gateway. So the rule is "refuse only when we are sure", and every
// rule below is a reason to pass through instead:
//
//  - no model, or an agent that is not one of the builtin gateway-routed harnesses (claude, codex,
//    copilot). Custom agents merge their own env last and may point anywhere; grok's models come
//    from `~/.grok/config.toml`, never the gateway.
//  - the launch mode is `subscription` (the gateway env is stripped), or no gateway is configured.
//  - the catalogue is not a finished, non-empty read of the CURRENT gateway settings (loading,
//    error, empty, or a result for settings the user has since edited).
//  - the project the node opens in is unknown here, is a relay tab, or its project settings carry
//    an agent env or launch-command override (either can send the agent somewhere else).
//  - claude's own aliases (`sonnet`, `opus`, `haiku`, `opusplan`, `sonnet[1m]`, …): the CLI
//    resolves them itself to a full id, which the gateway may list under that full name.
//
// Matching tolerates the provider prefix a gateway catalogue may carry (`anthropic/claude-x`) in
// either direction, and case. Known residuals, stated: an agent's own config can still override
// the base URL (claude's settings.json `env`, a codex `model_provider` in config.toml), and then a
// refusal is wrong; the reply names the list and how to proceed, so it costs one retry.

import type { GatewayModel, ModelGatewaySettings } from '@shared/agents/model-gateway'
import type { AgentLaunchMode } from '@shared/types'
import type { ProjectLaunchInfo } from '@shared/project-settings'

/** The harnesses whose launches route through the configured gateway (modelGatewayEnv). */
const GATEWAY_ROUTED = new Set(['claude', 'codex', 'copilot'])

/** Which saved gateway settings a catalogue answer belongs to. `null` = no gateway configured. */
export function gatewayCatalogueKey(settings: ModelGatewaySettings | undefined): string | null {
  const baseUrl = settings?.baseUrl?.trim() ?? ''
  const apiKey = settings?.apiKey?.trim() ?? ''
  if (!baseUrl || !apiKey) return null
  return JSON.stringify([baseUrl, apiKey, settings?.discoveryPath?.trim() ?? ''])
}

export interface ModelCatalogue {
  models: readonly GatewayModel[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** `gatewayCatalogueKey` of the settings this answer was read for. */
  forKey: string | null
}

export interface ModelRefusalInput {
  agentId: string
  model: string | undefined
  catalogue: ModelCatalogue
  gateway: ModelGatewaySettings | undefined
  launchMode: AgentLaunchMode | undefined
  /** The opening project's launch info; `null`/`undefined` = not known here (pass through). */
  projectInfo: ProjectLaunchInfo | null | undefined
  /** The opening project is a relay tab (its terminals run on another machine's settings). */
  relay?: boolean
}

const SAFE_ID = /^[A-Za-z0-9._:/@+\[\]-]{1,120}$/
const CLAUDE_ALIAS = /^[a-z]+(\[1m\])?$/i

/** True when every precondition for a confident answer holds — before looking at the id. */
function catalogueApplies(input: Omit<ModelRefusalInput, 'model'>): boolean {
  if (!GATEWAY_ROUTED.has(input.agentId)) return false
  if (input.launchMode === 'subscription' || input.relay) return false
  const key = gatewayCatalogueKey(input.gateway)
  const c = input.catalogue
  return !!key && c.status === 'ready' && c.forKey === key && c.models.length > 0
}

/** Whether checking `model` could refuse at all, so a caller can skip any lookup it would need. */
export function modelCheckApplies(input: Omit<ModelRefusalInput, 'projectInfo'>): boolean {
  const m = input.model?.trim()
  if (!m || !catalogueApplies({ ...input, projectInfo: undefined })) return false
  return !(input.agentId === 'claude' && CLAUDE_ALIAS.test(m))
}

function listed(models: readonly GatewayModel[], model: string): boolean {
  const m = model.toLowerCase()
  return models.some(({ id }) => {
    const l = id.toLowerCase()
    return l === m || l.endsWith(`/${m}`) || m.endsWith(`/${l}`)
  })
}

/** The refusal sentence, or null to pass `--model` through unchanged. */
export function unknownModelRefusal(input: ModelRefusalInput): string | null {
  if (!modelCheckApplies(input)) return null
  const info = input.projectInfo
  if (!info) return null
  const env = info.resolved.agents.env?.value
  if (info.resolved.agents.launchCmd || (env && Object.keys(env).length > 0)) return null
  let model = input.model!.trim()
  if (input.agentId === 'claude') model = model.replace(/\[1m\]$/i, '')
  if (listed(input.catalogue.models, model)) return null
  // Ids come from the gateway's answer and land in an agent's reply: only plain ones are quoted.
  const ids = input.catalogue.models.map((x) => x.id).filter((id) => SAFE_ID.test(id))
  const sample = ids.slice(0, 8).join(', ') + (ids.length > 8 ? `, … (${ids.length} in all)` : '')
  const shown = SAFE_ID.test(input.model!.trim()) ? input.model!.trim() : 'that id'
  return (
    `--model "${shown}" is not in the model list your model gateway reports for ` +
    `${input.agentId} (${sample}). Nothing was opened. Use an id from that list, or omit --model ` +
    'to launch on the default model.'
  )
}
