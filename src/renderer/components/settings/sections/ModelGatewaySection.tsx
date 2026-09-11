import { useEffect, useState } from 'react'
import {
  MODEL_GATEWAY_SECRET_REF,
  modelGatewayCredentialKind,
  modelGatewayRoutes,
  parseModelGatewayEnvReference,
  type ModelGatewayCredentialStatus
} from '@shared/agents/model-gateway'
import { useModelGateway } from '../../../state/modelGateway'
import { useSettings } from '../../../state/settings'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { Select } from '@renderer/ui/Select'
import { FieldRow } from '../FieldRow'
import { SearchableRow } from '../SearchableRow'
import { SettingsSection } from '../SettingsSection'

const ROWS = {
  endpoint: {
    title: 'Gateway URL',
    description: 'One gateway root URL for OpenAI-compatible discovery and agent routes.',
    keywords: ['openai compatible', 'bifrost', 'litellm', 'model', 'provider', 'base url', 'endpoint']
  },
  key: {
    title: 'API key',
    description: 'A gateway bearer key from protected storage or an environment variable.',
    keywords: ['token', 'secret', 'virtual key', 'authentication', 'environment variable', 'env']
  },
  discovery: {
    title: 'Available models',
    description: 'Refresh the model catalogue used by agent-node context menus.',
    keywords: ['discover', 'refresh', 'switch model', 'catalogue']
  },
  defaultModel: {
    title: 'Default model',
    description:
      'A model new canvas agent sessions launch on when the Agents “Launch mode” is set to “Gateway (default model)”.',
    keywords: [
      'default',
      'model',
      'launch',
      'gateway model',
      'new session',
      'claude',
      'codex',
      'copilot'
    ]
  }
}
const ENTRIES = Object.values(ROWS)
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
type CredentialMode = 'environment' | 'stored'

function credentialMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('invalid-api-key') || message.includes('invalid-token')) {
    return 'Enter a non-empty API key without line breaks.'
  }
  if (message.includes('keyring-locked')) return 'Unlock the OS keyring and try again.'
  if (message.includes('unavailable')) return 'Secret storage is unavailable in this session.'
  return 'The API key could not be saved. Please try again.'
}

export function ModelGatewaySection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const gateway = useSettings((s) => s.settings.modelGateway)
  const defaultModel = useSettings((s) => s.settings.modelGatewayDefaultModel)
  const update = useSettings((s) => s.update)
  const models = useModelGateway((s) => s.models)
  const status = useModelGateway((s) => s.status)
  const error = useModelGateway((s) => s.error)
  const discover = useModelGateway((s) => s.discover)
  const clearModels = useModelGateway((s) => s.clear)
  const initialReference = parseModelGatewayEnvReference(gateway.apiKey)
  const [credentialMode, setCredentialMode] = useState<CredentialMode>(() =>
    modelGatewayCredentialKind(gateway.apiKey) === 'stored' ||
    modelGatewayCredentialKind(gateway.apiKey) === 'legacy-literal'
      ? 'stored'
      : 'environment'
  )
  const [envName, setEnvName] = useState(initialReference?.name ?? '')
  const [literalKey, setLiteralKey] = useState('')
  const [credentialStatus, setCredentialStatus] =
    useState<ModelGatewayCredentialStatus | null>(null)
  const [credentialBusy, setCredentialBusy] = useState(false)
  const [credentialNotice, setCredentialNotice] = useState('')
  const routes = modelGatewayRoutes(gateway.baseUrl)

  const patchGateway = (patch: Partial<typeof gateway>): void => {
    const current = useSettings.getState().settings.modelGateway
    update({ modelGateway: { ...current, ...patch } })
  }

  useEffect(() => {
    const reference = parseModelGatewayEnvReference(gateway.apiKey)
    if (reference) {
      setCredentialMode('environment')
      setEnvName(reference.name)
    } else {
      const kind = modelGatewayCredentialKind(gateway.apiKey)
      if (kind === 'stored' || kind === 'legacy-literal') setCredentialMode('stored')
    }
  }, [gateway.apiKey])

  useEffect(() => {
    if (!isActive) return
    let cancelled = false
    void window.nodeTerminal.agent
      .gatewayCredentialStatus()
      .then((status) => {
        if (!cancelled) setCredentialStatus(status)
      })
      .catch(() => {
        if (!cancelled) setCredentialStatus({ hasStoredKey: false, storage: 'unavailable' })
      })
    return () => {
      cancelled = true
    }
  }, [isActive])

  const changeCredentialMode = (mode: CredentialMode): void => {
    setCredentialMode(mode)
    setCredentialNotice('')
    if (mode === 'environment') {
      patchGateway({ apiKey: ENV_NAME.test(envName) ? `\${env:${envName}}` : '' })
    } else {
      patchGateway({
        apiKey: credentialStatus?.hasStoredKey ? MODEL_GATEWAY_SECRET_REF : ''
      })
    }
  }

  const updateEnvName = (value: string): void => {
    setEnvName(value)
    setCredentialNotice('')
    patchGateway({ apiKey: ENV_NAME.test(value) ? `\${env:${value}}` : '' })
  }

  const saveLiteralKey = async (): Promise<void> => {
    setCredentialBusy(true)
    setCredentialNotice('')
    try {
      const status = await window.nodeTerminal.agent.saveGatewayCredential(literalKey)
      setCredentialStatus(status)
      setLiteralKey('')
      const replacingStoredKey =
        useSettings.getState().settings.modelGateway.apiKey === MODEL_GATEWAY_SECRET_REF
      patchGateway({ apiKey: MODEL_GATEWAY_SECRET_REF })
      const current = useSettings.getState().settings.modelGateway
      // Replacing a key leaves the settings sentinel unchanged, so Canvas's value-based effect has
      // no dependency change to observe. A first save does change it and gets the normal debounce.
      if (replacingStoredKey && modelGatewayRoutes(current.baseUrl)) {
        void discover({ ...current, apiKey: MODEL_GATEWAY_SECRET_REF })
      }
      setCredentialNotice('API key saved securely.')
    } catch (saveError) {
      setCredentialNotice(credentialMessage(saveError))
    } finally {
      setCredentialBusy(false)
    }
  }

  const clearLiteralKey = async (): Promise<void> => {
    setCredentialBusy(true)
    setCredentialNotice('')
    try {
      const status = await window.nodeTerminal.agent.clearGatewayCredential()
      setCredentialStatus(status)
      setLiteralKey('')
      patchGateway({ apiKey: '' })
      clearModels()
      setCredentialNotice('Saved API key cleared.')
    } catch (clearError) {
      setCredentialNotice(credentialMessage(clearError))
    } finally {
      setCredentialBusy(false)
    }
  }

  const envNameValid = ENV_NAME.test(envName)
  const credentialReady =
    credentialMode === 'environment'
      ? envNameValid && gateway.apiKey.trim() !== ''
      : credentialStatus?.hasStoredKey === true && gateway.apiKey === MODEL_GATEWAY_SECRET_REF

  return (
    <SettingsSection
      id="model-gateway"
      title="Model gateway"
      description="Configure one gateway, discover models through the OpenAI-compatible Models API, and switch a supported agent node without creating a custom agent for every model."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.endpoint}>
        <FieldRow
          label="Gateway URL"
          description="Enter the server root. Discovery uses the OpenAI-compatible /v1/models endpoint; agent launches use the configured provider routes."
          htmlFor="model-gateway-url"
          control={
            <Input
              id="model-gateway-url"
              className="w-80"
              type="url"
              placeholder="https://gateway.example.com"
              value={gateway.baseUrl}
              onChange={(e) => patchGateway({ baseUrl: e.target.value })}
            />
          }
        />
        {gateway.baseUrl && !routes ? (
          <p className="mt-2 text-right text-xs text-[color:var(--warn)]">
            Enter a valid HTTP(S) URL without embedded credentials.
          </p>
        ) : routes ? (
          <div className="mt-3 space-y-1 text-right font-mono text-[11px] text-muted">
            <div>Discovery: {routes.discovery}</div>
            <div>OpenAI: {routes.openai}</div>
            <div>Anthropic: {routes.anthropic}</div>
          </div>
        ) : null}
      </SearchableRow>

      <SearchableRow {...ROWS.key}>
        <div className="space-y-3">
          <FieldRow
            label="Credential source"
            description="Reference an environment variable or save a literal key in protected local storage."
            htmlFor="model-gateway-credential-source"
            control={
              <Select
                id="model-gateway-credential-source"
                value={credentialMode}
                onChange={(event) =>
                  changeCredentialMode(event.target.value as CredentialMode)
                }
              >
                <option value="environment">Environment variable</option>
                <option value="stored">Stored API key</option>
              </Select>
            }
          />

          {credentialMode === 'environment' ? (
            <FieldRow
              label="Environment variable"
              description="Enter the variable name only. settings.json stores it as ${env:VAR}; the secret itself is never saved."
              note={
                envName && !envNameValid
                  ? 'Use letters, numbers, and underscores; the first character cannot be a number.'
                  : undefined
              }
              htmlFor="model-gateway-env-name"
              control={
                <Input
                  id="model-gateway-env-name"
                  className="w-64 font-mono"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="GATEWAY_API_KEY"
                  value={envName}
                  onChange={(event) => updateEnvName(event.target.value)}
                />
              }
            />
          ) : (
            <FieldRow
              label="API key"
              description="The key is write-only here and never appears in settings.json or restart commands."
              note={
                credentialStatus?.storage === 'restricted-file'
                  ? 'Encrypted key storage is unavailable. The key is protected in a mode 0600 local file.'
                  : credentialStatus?.storage === 'unavailable'
                    ? 'Secret storage is unavailable in this session.'
                    : undefined
              }
              htmlFor="model-gateway-key"
              control={
                <div className="flex items-center gap-2">
                  <Input
                    id="model-gateway-key"
                    className="w-56"
                    type="password"
                    autoComplete="off"
                    placeholder={credentialStatus?.hasStoredKey ? 'API key saved' : 'API key'}
                    value={literalKey}
                    onChange={(event) => {
                      setLiteralKey(event.target.value)
                      setCredentialNotice('')
                    }}
                  />
                  <Button
                    disabled={
                      !literalKey ||
                      credentialBusy ||
                      credentialStatus?.storage === 'unavailable'
                    }
                    onClick={() => void saveLiteralKey()}
                  >
                    Save key
                  </Button>
                  {credentialStatus?.hasStoredKey ? (
                    <Button
                      disabled={credentialBusy}
                      onClick={() => void clearLiteralKey()}
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
              }
            />
          )}
          {credentialNotice ? (
            <p className="text-right text-xs text-muted">{credentialNotice}</p>
          ) : null}
        </div>
      </SearchableRow>

      <SearchableRow {...ROWS.discovery}>
        <div className="flex items-center justify-between gap-6">
          <div>
            <div className="text-sm font-medium text-text">Available models</div>
            <p className="mt-1 text-[13px] text-muted">
              {status === 'loading'
                ? 'Discovering models…'
                : status === 'ready'
                  ? `${models.length} model${models.length === 1 ? '' : 's'} available.`
                  : 'Models are also refreshed automatically when these settings change.'}
            </p>
            {error ? <p className="mt-1 text-xs text-[color:var(--warn)]">{error}</p> : null}
          </div>
          <Button
            disabled={!routes || !credentialReady || status === 'loading'}
            onClick={() => void discover(gateway)}
          >
            {status === 'loading' ? 'Discovering…' : models.length ? 'Refresh' : 'Discover models'}
          </Button>
        </div>
        {models.length ? (
          <div className="mt-3 max-h-40 overflow-y-auto rounded-lg bg-black/15 px-3 py-2 font-mono text-[11px] text-muted">
            {models.map((model) => (
              <div key={model.id}>{model.id}</div>
            ))}
          </div>
        ) : null}
      </SearchableRow>

      <SearchableRow {...ROWS.defaultModel}>
        <FieldRow
          label="Default model"
          description="New canvas agent sessions launch on this model when Settings → Agents → Launch mode is “Gateway (default model)”. Picked from the discovered catalogue — discover models first."
          control={
            <Select
              aria-label="Default gateway model"
              value={defaultModel ?? ''}
              disabled={!models.length}
              onChange={(e) => {
                const id = e.target.value
                // An empty value is the one spelling of "no default" (absent), matching how the
                // launch-commands fields above treat a cleared input. A non-empty id is stored
                // verbatim — it is the discovered catalogue id, not a credential.
                update({ modelGatewayDefaultModel: id || undefined })
              }}
            >
              <option value="">(none — CLI default model)</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </Select>
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
