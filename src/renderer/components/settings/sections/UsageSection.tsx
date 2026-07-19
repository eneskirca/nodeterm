import { useEffect, useState } from 'react'
import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { Button } from '@renderer/ui/Button'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import { USAGE_PROVIDER_IDS, providerLabel } from '@shared/usage-limits'
import { AGENT_CONFIG } from '@shared/agents/config'

const ROWS = {
  percentMode: {
    title: 'Usage percentages',
    keywords: ['usage', 'percent', 'used', 'remaining', 'left', 'display']
  },
  visibility: {
    title: 'Providers',
    keywords: [
      'usage',
      'provider',
      'show',
      'hide',
      'toggle',
      'claude',
      'codex',
      'gemini',
      'grok',
      'kimi',
      'minimax',
      'opencode',
      'pill',
      'indicator'
    ]
  },
  cookies: {
    title: 'Web-console sign-in',
    keywords: ['minimax', 'opencode', 'cookie', 'session', 'sign in', 'credential', 'paste']
  }
}
const ENTRIES = Object.values(ROWS)

/** AGENT_CONFIG is keyed by builtin ids; billing-only providers fall through to the label table. */
function labelFor(provider: string): string {
  const agentLabel = (AGENT_CONFIG as Record<string, { label?: string } | undefined>)[provider]?.label
  return providerLabel(provider, agentLabel)
}

const PROVIDER_BLURBS: Record<string, string> = {
  claude: 'Session, weekly and per-model limits from your Claude subscription.',
  codex: 'Session and weekly limits from your ChatGPT (Codex) subscription.',
  gemini: 'Per-model hourly quota from the Gemini CLI sign-in.',
  grok: 'Weekly credits and monthly budget from the Grok CLI sign-in.',
  kimi: 'Session and weekly quota from the Kimi Code sign-in.',
  minimax: 'Per-model session quota — needs the cookie below.',
  opencode: 'Session, weekly and monthly usage — needs the cookie below.'
}

/**
 * Providers that publish no CLI credential — their quota lives behind a web console session, so
 * the user pastes a cookie. Each row is write-only: it can store or clear a value and can see
 * WHETHER one is stored, but the secret is never read back into the UI.
 */
const COOKIE_PROVIDER_ROWS = [
  {
    id: 'minimax',
    label: 'MiniMax',
    description:
      "MiniMax exposes no CLI credential, so its quota is read with your console session. Open platform.minimax.io/console/usage, copy the request's Cookie header from DevTools, and paste it here.",
    placeholder: 'Cookie: _token=…'
  },
  {
    id: 'opencode',
    label: 'opencode',
    description:
      'opencode publishes no usage API, so the numbers are read from your dashboard page. Open opencode.ai, copy the Cookie header from DevTools, and paste it here. Because this reads a page rather than an API, it can stop working when opencode changes their site — it will report an error rather than silently showing nothing.',
    placeholder: 'auth=…'
  }
] as const

function CookieProviderRow({
  id,
  label,
  description,
  placeholder,
  stored,
  onChange
}: {
  id: string
  label: string
  description: string
  placeholder: string
  stored: boolean
  onChange: (stored: boolean) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const save = async (next: string): Promise<void> => {
    onChange(await window.nodeTerminal.usage.setProviderCookie(id, next))
    // Never keep the secret in component state once it has been handed over.
    setValue('')
  }
  return (
    <FieldRow
      label={label}
      description={description}
      note={
        stored
          ? 'Stored in a file only your user can read, never in settings.json. It is not shown again — paste a fresh one when your session expires.'
          : 'This is a live session credential. It is stored in a 0600 file, not in settings.json, and is never read back into the UI.'
      }
      control={
        <div className="flex items-center gap-2">
          <input
            type="password"
            className="input w-64"
            placeholder={stored ? '•••••••• stored' : placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button onClick={() => void save(value)} disabled={!value.trim()}>
            Save
          </Button>
          {stored && <Button onClick={() => void save('')}>Clear</Button>}
        </div>
      }
    />
  )
}

export function UsageSection({ isActive }: { isActive: boolean }): React.JSX.Element | null {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)

  const hidden = new Set(settings.hiddenUsageProviders)
  const setShown = (provider: string, shown: boolean): void => {
    const next = settings.hiddenUsageProviders.filter((p) => p !== provider)
    if (!shown) next.push(provider)
    update({ hiddenUsageProviders: next })
  }

  // Which cookie providers have one stored — state only; the values never reach the renderer.
  const [cookieStored, setCookieStored] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!isActive) return
    let cancelled = false
    void window.nodeTerminal.usage.cookieProviders().then((v) => {
      if (!cancelled) setCookieStored(v)
    })
    return () => {
      cancelled = true
    }
  }, [isActive])

  return (
    <SettingsSection
      id="usage"
      title="Usage"
      description="Subscription limits shown in the pill at the bottom-left of the canvas. Hiding a provider is a display choice — credentials are untouched, so re-enabling is instant."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.percentMode}>
        <FieldRow
          label="Usage percentages"
          description="Whether provider limits show the percentage used or remaining."
          control={
            <SegmentedPill
              value={settings.usagePercentMode}
              options={[
                { value: 'used', label: 'Used' },
                { value: 'remaining', label: 'Remaining' }
              ]}
              onChange={(v) => update({ usagePercentMode: v })}
              ariaLabel="Usage percentage display"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.visibility}>
        <div className="space-y-5">
          {USAGE_PROVIDER_IDS.map((id) => (
            <FieldRow
              key={id}
              label={`${labelFor(id)} usage`}
              description={PROVIDER_BLURBS[id] ?? ''}
              control={
                <Switch
                  checked={!hidden.has(id)}
                  onChange={(v) => setShown(id, v)}
                  ariaLabel={`Show ${labelFor(id)} usage`}
                />
              }
            />
          ))}
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.cookies}>
        <div className="space-y-5">
          {COOKIE_PROVIDER_ROWS.map((p) => (
            <CookieProviderRow
              key={p.id}
              {...p}
              stored={!!cookieStored[p.id]}
              onChange={(stored) => setCookieStored((m) => ({ ...m, [p.id]: stored }))}
            />
          ))}
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
