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
  discoveryPath: {
    title: 'Discovery path',
    description: 'Path the model catalogue is read from, appended to the gateway root.',
    keywords: ['discover', 'models route', 'v1/models', 'openai/v1/models', 'catalogue path']
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

  // The "Model discovery endpoint" picker's transient editing state. The CURRENT selection is
  // derived from `gateway.discoveryPath` every render (the source of truth); these locals only
  // hold whether the custom text input is open and what the user is mid-typing into it.
  const [customMode, setCustomMode] = useState(false)
  const [customPath, setCustomPath] = useState('')
  const routes = modelGatewayRoutes(gateway.baseUrl, gateway.discoveryPath)

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
      if (
        replacingStoredKey &&
        modelGatewayRoutes(current.baseUrl, current.discoveryPath)
      ) {
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

      <SearchableRow {...ROWS.discoveryPath}>
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-6">
            <div>
              <div className="text-sm font-medium text-text">Model discovery endpoint</div>
              <p className="mt-1 max-w-xl text-[13px] text-muted">
                Which gateway endpoint the model catalogue is read from. Only the discovery request
                changes — agent launches keep using the OpenAI and Anthropic routes shown under the
                Gateway URL.
              </p>
            </div>
            {routes ? (
              <div className="shrink-0 font-mono text-[11px] text-muted">
                Discovery: {routes.discovery}
              </div>
            ) : null}
          </div>
          {/* Vertical radio group (the Speech-section pattern): one bordered row per endpoint.
              `discoveryPath` absent = the conventional /v1/models row. Custom reveals a free-text
              path so a layout this picker doesn't know is still expressible; the undefined spelling
              means "use the conventional suffix" on ModelGatewaySettings. */}
          {(() => {
            const isCustomValue =
              !!gateway.discoveryPath &&
              gateway.discoveryPath !== '/v1/models' &&
              gateway.discoveryPath !== '/openai/v1/models' &&
              gateway.discoveryPath !== '/anthropic/v1/models'
            return (
              <div role="radiogroup" aria-label="Model discovery endpoint" className="space-y-2">
                {(
                  [
                    {
                      option: '/v1/models',
                      label: '/v1/models',
                      hint: 'OpenAI convention — the default.'
                    },
                    {
                      option: '/openai/v1/models',
                      label: '/openai/v1/models',
                      hint: 'Same catalogue under the OpenAI launch-route prefix.'
                    },
                    {
                      option: '/anthropic/v1/models',
                      label: '/anthropic/v1/models',
                      hint: 'Same catalogue under the Anthropic launch-route prefix.'
                    },
                    { option: 'custom', label: 'Custom path…', hint: 'Enter an exact path below.' }
                  ] as const
                ).map((opt) => {
                  // Custom is a MODE, not a stored alias value: `customMode` (this render
                  // session's Custom selection) OR a persisted non-canonical path claims the
                  // custom row. A custom seed of '/v1/models' before typing must NOT light the
                  // first row — checked is single-owner: while customMode, the canonical rows
                  // never light, whatever the field currently contains.
                  const checked =
                    opt.option === 'custom'
                      ? customMode || isCustomValue
                      : !customMode && !isCustomValue && (gateway.discoveryPath ?? '/v1/models') === opt.option
                  return (
                    <div
                      key={opt.option}
                      className={
                        'flex items-center justify-between gap-3 rounded-md border p-3 transition-colors' +
                        // The selected row is the one thing a scan must land on: accent border +
                        // tinted fill, not just the (small, unstyled) native radio dot.
                        (checked
                          ? ' border-[color:var(--accent)] bg-[color:var(--accent)]/10'
                          : ' border-border')
                      }
                    >
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                        <input
                          type="radio"
                          name="gateway-discovery-path"
                          className="shrink-0"
                          style={{ accentColor: 'var(--accent)' }}
                          checked={checked}
                          onChange={() => {
                            if (opt.option === 'custom') {
                              // Seed the input with the CURRENT stored path (or the conventional
                              // default) so the box never shows empty over a live value. The
                              // stored path is NOT rewritten here — Custom is only a mode until
                              // the input itself is edited.
                              setCustomMode(true)
                              setCustomPath(gateway.discoveryPath ?? '/v1/models')
                            } else {
                              setCustomMode(false)
                              setCustomPath('')
                              patchGateway({
                                discoveryPath: opt.option === '/v1/models' ? undefined : opt.option
                              })
                            }
                          }}
                        />
                        <div className="min-w-0">
                          <span
                            className={
                              checked
                                ? 'font-mono text-[13px] font-medium text-text'
                                : 'font-mono text-[13px] text-text'
                            }
                          >
                            {opt.label}
                          </span>
                          <p className="text-[12px] text-muted">{opt.hint}</p>
                        </div>
                      </label>
                    </div>
                  )
                })}
              </div>
            )
          })()}
          {customMode && (
            <Input
              id="model-gateway-discovery-path"
              className="w-64 font-mono"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="/v1/models"
              value={customPath}
              onChange={(e) => {
                setCustomPath(e.target.value)
                patchGateway({ discoveryPath: e.target.value || undefined })
              }}
            />
          )}
        </div>
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
    </SettingsSection>
  )
}
