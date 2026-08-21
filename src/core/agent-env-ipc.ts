// Main/server IPC handlers for model-gateway discovery and credentials. Everything registered
// here goes through `platform().handle`, which — deliberately — answers relay peers and Server
// Edition WS clients too (see src/main/platform-electron.ts). That is why the desktop-only env
// snapshot for `${env:VAR}` preview/launch expansion is NOT here: it is a raw `ipcMain.handle`
// in src/main/index.ts, invisible to peers, exactly like the other local-window-only channels.
// Literal gateway keys cross this boundary write-only and are read back only by core.

import { IPC } from '../shared/ipc'
import { platform } from './platform'
import {
  modelGatewayRoutes,
  parseGatewayModels,
  resolveModelGatewayApiKey,
  type GatewayModel,
  type ModelDiscoveryResult,
  type ModelGatewaySettings
} from '../shared/agents/model-gateway'
import type { ModelGatewayCredentialService } from './model-gateway-credentials'

const DISCOVERY_TIMEOUT_MS = 10_000

/**
 * Query model discovery from core rather than the renderer: gateways commonly omit browser CORS,
 * and the API key should never be interpolated into a terminal command. Every failure is returned
 * as data so opening Settings or a context menu cannot create an unhandled rejection.
 */
async function discoverModels(
  settings: ModelGatewaySettings,
  saved: ModelGatewaySettings | undefined,
  storedSecret: string | null,
  onDiscovered?: (baseUrl: string, models: GatewayModel[]) => void
): Promise<ModelDiscoveryResult> {
  const routes = modelGatewayRoutes(settings?.baseUrl ?? '')
  const apiKeyField = settings?.apiKey ?? ''
  // SECURITY GATE — this handler is reachable by relay peers and Server Edition WS clients, and
  // `settings` (URL included) is caller-supplied. `${secret:…}` / `${env:…}` references resolve
  // against HOST-side state, so resolving one for a caller-chosen URL would turn discovery into a
  // credential-exfiltration oracle: ask for the stored key (or any env var) and point baseUrl at
  // your own host. References therefore resolve ONLY when the requested baseUrl is byte-identical
  // to the persisted gateway URL; a literal key pasted into the form is the caller's own and may
  // be tested against any URL (the pre-save "does this key work?" flow in Settings).
  const isReference = apiKeyField.includes('${')
  const trusted = !!settings?.baseUrl && settings.baseUrl === saved?.baseUrl
  if (isReference && !trusted) {
    return {
      models: [],
      error:
        'Stored or environment API keys are only sent to the saved gateway URL — save the gateway settings first.'
    }
  }
  const resolvedKey = resolveModelGatewayApiKey(
    apiKeyField,
    trusted ? process.env : {},
    trusted ? storedSecret : null
  )
  const apiKey = resolvedKey.value
  if (!routes) return { models: [], error: 'Enter a valid HTTP(S) gateway URL.' }
  if (resolvedKey.missing.length) {
    const refs = resolvedKey.missing.map((name) => `\${env:${name}}`).join(', ')
    return {
      models: [],
      error: `Gateway API key environment ${resolvedKey.missing.length === 1 ? 'variable is' : 'variables are'} unset: ${refs}.`
    }
  }
  if (resolvedKey.storedSecretMissing) {
    return { models: [], error: 'Save a gateway API key or select an environment variable.' }
  }
  if (!apiKey) return { models: [], error: 'Enter an API key.' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  try {
    const response = await fetch(routes.discovery, {
      headers: {
        // Authorization is the OpenAI-compatible convention used by LiteLLM and
        // modern Bifrost keys. Older Bifrost virtual keys require x-bf-vk.
        Authorization: `Bearer ${apiKey}`,
        'x-bf-vk': apiKey,
        Accept: 'application/json'
      },
      signal: controller.signal
    })
    if (!response.ok) {
      return { models: [], error: `Model discovery failed (HTTP ${response.status}).` }
    }
    const models = parseGatewayModels(await response.json())
    // Push the discovered models into the PtyManager cache (when wired) so spawn-time env
    // injection can read the reported context/output token limits for Copilot BYOK. Cleared on an
    // empty result so a gateway change does not serve stale limits.
    if (onDiscovered) onDiscovered(settings.baseUrl, models)
    return models.length
      ? { models }
      : { models: [], error: 'The gateway returned no usable models.' }
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError'
    return {
      models: [],
      error: timedOut
        ? 'Model discovery timed out.'
        : `Model discovery failed: ${err instanceof Error ? err.message : 'unknown error'}`
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Register gateway discovery and write-only gateway-credential handlers. `getSavedGateway` reads
 *  the PERSISTED gateway settings — the trust anchor that keeps discovery from resolving stored /
 *  env key references for a caller-chosen URL (see the gate in `discoverModels`). */
export function registerAgentEnvIpc(
  getSavedGateway: () => ModelGatewaySettings | undefined,
  credentials?: ModelGatewayCredentialService,
  /** Called with the discovered models for a gateway URL so the PtyManager can cache them for
   *  spawn-time Copilot BYOK max-context env injection. Optional: the Server Edition / shells that
   *  do not own a PtyManager pass none, and the limits simply are not cached there. */
  onDiscovered?: (baseUrl: string, models: GatewayModel[]) => void
): void {
  platform().handle(IPC.agentDiscoverModels, (settings: ModelGatewaySettings) =>
    discoverModels(settings, getSavedGateway(), credentials?.readForHost() ?? null, onDiscovered)
  )
  platform().handle(IPC.agentGatewayCredentialStatus, () =>
    credentials?.status() ?? { hasStoredKey: false, storage: 'unavailable' as const }
  )
  platform().handle(IPC.agentGatewayCredentialSave, (apiKey: string) => {
    if (!credentials) throw new Error('gateway-secret-storage-unavailable')
    return credentials.save(apiKey)
  })
  platform().handle(IPC.agentGatewayCredentialClear, () => {
    if (!credentials) throw new Error('gateway-secret-storage-unavailable')
    return credentials.clear()
  })
}
