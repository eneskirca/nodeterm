import { useMemo, useState } from 'react'
import { useSettings } from '../../../state/settings'
import { removeCustomAgent } from '../../../state/agentAvailability'
import type { CustomAgent } from '@shared/types'
import {
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  type AgentId,
  type PromptInjectionMode
} from '@shared/agents/config'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { Select } from '@renderer/ui/Select'
import { uuid } from '@renderer/lib/uuid'
import { assembleLaunchCommand } from '@shared/agents/launch'
import { agentEnvSnapshot } from '@renderer/lib/agentEnv'

const ROWS = {
  custom: {
    title: 'Custom agents',
    keywords: ['custom', 'agent', 'cli', 'byo', 'aider', 'proxy', 'env', 'base url', 'api key']
  }
}
const ENTRIES = Object.values(ROWS)

const INJECTION_MODES: PromptInjectionMode[] = [
  'argv',
  'flag-prompt',
  'flag-interactive',
  'stdin-after-start'
]

export function CustomAgentsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const customAgents = useSettings((s) => s.settings.customAgents)
  const update = useSettings((s) => s.update)
  const patchAgent = (id: string, patch: Partial<CustomAgent>) =>
    update({ customAgents: customAgents.map((a) => (a.id === id ? { ...a, ...patch } : a)) })
  // Through removeCustomAgent, never a bare filter: a removed agent that was the default (or
  // disabled) would otherwise leave its dead id in `defaultAgent` / `disabledAgents`, and ⌘⇧C
  // would type the raw `custom:<uuid>` into a shell.
  const removeAgent = (id: string) => update(removeCustomAgent(useSettings.getState().settings, id))
  const addAgent = () =>
    update({
      customAgents: [
        ...customAgents,
        {
          id: 'custom:' + uuid(),
          label: 'Custom agent',
          launchCmd: '',
          promptInjectionMode: 'argv'
        }
      ]
    })

  return (
    <SettingsSection
      id="custom-agents"
      title="Custom agents"
      description="Bring your own agent CLI, or wrap a built-in harness (e.g. Claude) to redirect inference to your own proxy. Env values support ${env:VAR} and ${env:VAR:fallback} expansion against your shell environment."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.custom}>
        <div className="space-y-4">
          {customAgents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} onPatch={patchAgent} onRemove={removeAgent} />
          ))}
          <Button onClick={addAgent}>Add agent</Button>
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}

function AgentCard({
  agent,
  onPatch,
  onRemove
}: {
  agent: CustomAgent
  onPatch: (id: string, patch: Partial<CustomAgent>) => void
  onRemove: (id: string) => void
}): React.JSX.Element {
  const base = agent.baseAgent ? AGENT_CONFIG[agent.baseAgent] : undefined
  const setEnvEntry = (key: string, value: string) => {
    const env = { ...(agent.env ?? {}) }
    if (value === '' && key !== '') delete env[key]
    else env[key] = value
    onPatch(agent.id, { env })
  }
  const addEnvEntry = () => {
    const env = { ...(agent.env ?? {}) }
    let k = 'NEW_VAR'
    let i = 1
    while (env[k] !== undefined) k = `NEW_VAR_${++i}`
    env[k] = ''
    onPatch(agent.id, { env })
  }
  const removeEnvEntry = (key: string) => {
    const env = { ...(agent.env ?? {}) }
    delete env[key]
    onPatch(agent.id, { env })
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <FieldRow
        label="Label"
        control={
          <Input
            className="w-56"
            placeholder="e.g. Claude (proxy)"
            value={agent.label}
            onChange={(e) => onPatch(agent.id, { label: e.target.value })}
          />
        }
      />
      <FieldRow
        label="Base harness"
        description={
          base
            ? `Inherits ${base.label}'s launch conventions and supported integrations.`
            : 'Optional: inherit a built-in harness’s integrations. Blank = a standalone CLI.'
        }
        control={
          <Select
            value={agent.baseAgent ?? ''}
            onChange={(e) =>
              onPatch(agent.id, {
                baseAgent: (e.target.value || undefined) as CustomAgent['baseAgent']
              })
            }
          >
            <option value="">None (standalone CLI)</option>
            {BUILTIN_AGENT_IDS.map((id) => (
              <option key={id} value={id}>
                {AGENT_CONFIG[id].label}
              </option>
            ))}
          </Select>
        }
      />
      <FieldRow
        label="Launch command"
        description={
          base && !agent.launchCmd?.trim() ? `Blank uses the base command ("${base.launchCmd}").` : undefined
        }
        control={
          <Input
            className="w-56"
            placeholder={base ? base.launchCmd : 'e.g. aider'}
            value={agent.launchCmd}
            onChange={(e) => onPatch(agent.id, { launchCmd: e.target.value })}
          />
        }
      />
      <FieldRow
        label="Extra args"
        description="Inserted after the command, before the prompt. Supports ${env:VAR}."
        control={
          <Input
            className="w-56"
            placeholder="e.g. --model ${env:MY_MODEL}"
            value={agent.args ?? ''}
            onChange={(e) => onPatch(agent.id, { args: e.target.value })}
          />
        }
      />
      <FieldRow
        label="Prompt injection"
        description={
          base
            ? `Inherited from ${base.label} — the prompt grammar is a property of the harness, not a preference (claude takes a positional, never --prompt).`
            : 'How an initial prompt is passed to the CLI.'
        }
        control={
          <Select
            // Show the RESOLVED mode: when a base harness is set, its grammar wins over any stale
            // value on the record (claude rejects --prompt), so the dropdown reflects what actually
            // runs rather than a greyed-out wrong value.
            value={base ? base.promptInjectionMode : agent.promptInjectionMode ?? 'argv'}
            disabled={!!base}
            onChange={(e) =>
              onPatch(agent.id, { promptInjectionMode: e.target.value as PromptInjectionMode })
            }
          >
            {INJECTION_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        }
      />

      {/* Env vars editor */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-text">Environment variables</span>
          <Button onClick={addEnvEntry}>Add var</Button>
        </div>
        <p className="text-[13px] leading-relaxed text-muted">
          Values expand <code className="text-text">${'{env:VAR}'}</code> and
          <code className="text-text"> ${'{env:VAR:fallback}'}</code> against your shell environment.
          <br />
          These win over values nodeterm sets, so they can override an account login — e.g. set
          <code className="text-text"> ANTHROPIC_AUTH_TOKEN</code> /<code className="text-text"> ANTHROPIC_BASE_URL</code>
          to point a Claude-wrapping agent at your own proxy.
          <br />
          A custom <code className="text-text">PATH</code> should reference
          <code className="text-text"> {'${env:PATH}'}</code>, or CLI resolution may break.
          <br />
          Custom <code className="text-text">PATH</code> is not applied to remote sessions.
        </p>
        {Object.entries(agent.env ?? {}).map(([key, value]) => (
          <EnvRow
            key={key}
            entryKey={key}
            value={value}
            onKeyChange={(newKey) => {
              if (newKey === key) return
              const env = { ...(agent.env ?? {}) }
              delete env[key]
              env[newKey] = value
              onPatch(agent.id, { env })
            }}
            onValueChange={(v) => setEnvEntry(key, v)}
            onRemove={() => removeEnvEntry(key)}
          />
        ))}
      </div>

      <CommandPreview agent={agent} />

      <Button onClick={() => onRemove(agent.id)}>Remove</Button>
    </div>
  )
}

function EnvRow({
  entryKey,
  value,
  onKeyChange,
  onValueChange,
  onRemove
}: {
  entryKey: string
  value: string
  onKeyChange: (key: string) => void
  onValueChange: (value: string) => void
  onRemove: () => void
}): React.JSX.Element {
  const [revealed, setRevealed] = useState(false)
  const isPathLike = entryKey.toUpperCase() === 'PATH'
  const pathWarn =
    isPathLike && !value.includes('${env:PATH}')
      ? 'Does not reference ${env:PATH} — may break CLI resolution.'
      : undefined
  return (
    <div className="flex items-center gap-2">
      <Input className="w-40 font-mono" value={entryKey} onChange={(e) => onKeyChange(e.target.value)} />
      <Input
        className="w-44 font-mono"
        type={revealed ? 'text' : 'password'}
        placeholder="${env:MY_API_KEY}"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      />
      <Button variant="default" onClick={() => setRevealed((v) => !v)}>
        {revealed ? 'Hide' : 'Show'}
      </Button>
      <Button onClick={onRemove}>✕</Button>
      {pathWarn ? <span className="text-[12px] text-[color:var(--warn)]">{pathWarn}</span> : null}
    </div>
  )
}

/**
 * Live, fully-expanded preview of the command nodeterm will run for this agent. Assembled with the
 * SAME builder and the SAME cached env snapshot every launch path uses (shared/agents/launch.ts +
 * lib/agentEnv.ts) — no IPC, so the preview IS the typed line by construction and cannot drift.
 * In the browser / over relay the snapshot is empty by design, and the missing-env markers shown
 * here are exactly what makes the launch path refuse.
 */
function CommandPreview({ agent }: { agent: CustomAgent }): React.JSX.Element | null {
  // Re-computed when any field that affects the command changes.
  const sig = `${agent.id}|${agent.launchCmd}|${agent.args ?? ''}|${agent.baseAgent ?? ''}|${agent.promptInjectionMode ?? ''}`
  const preview = useMemo(
    () =>
      assembleLaunchCommand(
        {
          agentId: agent.id as AgentId,
          customAgent: agent,
          // No prompt: nodeterm launches the agent BARE and you type the prompt into it after it
          // starts. The preview shows exactly the launch line that gets typed into the shell.
          sessionIdFlagSupported: true
        },
        agentEnvSnapshot()
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig]
  )
  if (!preview) return null
  return (
    <div className="rounded-md bg-bg-2 p-2">
      <div className="mb-1 text-[12px] font-medium text-muted">
        Launch command <span className="text-muted-2">(the agent starts here; you type the prompt after)</span>
      </div>
      <code className="block break-all text-[12px] text-text">
        {preview.command || <span className="text-muted">(empty)</span>}
      </code>
      {preview.missingEnv.length > 0 ? (
        <div className="mt-1 text-[12px] text-[color:var(--warn)]">
          Unset: {preview.missingEnv.map((m) => `${'{env:' + m + '}'}`).join(', ')}
        </div>
      ) : null}
    </div>
  )
}
