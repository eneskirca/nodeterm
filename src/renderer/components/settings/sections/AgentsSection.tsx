import { useEffect, useState } from 'react'
import { useSettings } from '../../../state/settings'
import {
  isAgentEnabled,
  setAgentEnabled,
  setDefaultAgent
} from '../../../state/agentAvailability'
import { ensureClaudeCliCaps } from '../../../state/permissionMode'
import type { ClaudeCliCaps } from '@shared/types'
import {
  AGENT_CONFIG,
  ALL_PERMISSION_MODES,
  AUTO_PERMISSION_MODE_MIN_VERSION,
  BUILTIN_AGENT_IDS,
  PERMISSION_MODE_LABELS,
  type AgentId,
  type AgentPermissionMode
} from '@shared/agents/config'
import {
  permissionModeAgentIds,
  permissionModeAgentsLabel,
  unsupportedModesNote
} from '@shared/agents/approval-mode'
import { AgentIcon } from '../../../lib/agentIcons'
import { hintLabel } from '@shared/platform-utils'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import { Button } from '@renderer/ui/Button'
import { Select } from '@renderer/ui/Select'
import { Switch } from '@renderer/ui/Switch'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'

const ROWS = {
  agents: {
    title: 'Agents',
    keywords: ['agent', 'claude', 'codex', 'gemini', 'enable', 'disable', 'default']
  },
  permissionMode: {
    title: 'Permission mode',
    keywords: [
      'permission',
      'mode',
      'auto',
      'auto mode',
      'accept edits',
      'plan',
      'bypass',
      'approve',
      'ask',
      'claude',
      'grok',
      'gemini',
      'codex',
      'approval',
      'shift tab'
    ]
  },
  hookReplyApprovals: {
    title: 'One-click approvals',
    keywords: ['approve', 'deny', 'approval', 'permission', 'hook', 'phone', 'canvas', 'one click', 'claude']
  },
  agentSeamlessWrites: {
    title: 'Seamless agent messaging',
    keywords: ['seamless', 'write', 'send', 'message', 'confirm', 'dialog', 'agent', 'pair', 'control']
  },
}
const ENTRIES = Object.values(ROWS)

/**
 * Every fact in this sentence is DERIVED from the per-agent mapping (`@shared/agents/approval-mode`):
 * the agent list from `PERMISSION_MODE_CAPABLE`, and the admission of where a mode does NOT apply
 * from `modeSupported`. Hardcoding either would leave a second list to keep in sync, and its failure
 * mode is a settings page promising Plan on an agent that is quietly running in its own default.
 *
 * Assembled by joining the non-empty parts, so the middle sentence disappears cleanly (no double
 * space) the day every capable agent expresses every mode.
 */
function permissionModeDescription(): string {
  return [
    `The mode ${permissionModeAgentsLabel()} terminal sessions start in; other agents ignore it.`,
    unsupportedModesNote(),
    'Shift+Tab still switches modes at any time. Projects can override this from the tab ⌄ menu.'
  ]
    .filter(Boolean)
    .join(' ')
}

// The agents claude's version gate does NOT apply to — every other capable agent. Module level: the
// capable list cannot change while the app runs.
const otherModeAgents = permissionModeAgentIds({ exclude: ['claude'] })

export function AgentsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const rows: { id: AgentId; label: string; isBuiltin: boolean }[] = [
    ...BUILTIN_AGENT_IDS.map((id) => ({ id, label: AGENT_CONFIG[id].label, isBuiltin: true })),
    ...settings.customAgents.map((c) => ({ id: c.id, label: c.label || c.id, isBuiltin: false }))
  ]

  // The LOCAL Claude CLI's capabilities (the same memoized probe the launch path uses — no extra
  // IPC). `Auto` is silently dropped on a CLI older than the floor (it exits 1 on the flag), and a
  // setting that quietly does nothing reads as a broken setting — so say it where it's picked.
  // Remote (SSH) projects run their own CLI; this note is about the machine running the app.
  const [cliCaps, setCliCaps] = useState<ClaudeCliCaps | null>(null)
  useEffect(() => {
    let alive = true
    void ensureClaudeCliCaps().then((c) => {
      if (alive) setCliCaps(c)
    })
    return () => {
      alive = false
    }
  }, [])
  // Only when the probe actually READ a version: an unknown version (probe failed / no CLI) is not
  // evidence of an old CLI, and guessing would be its own kind of wrong.
  const autoNote =
    settings.claudePermissionMode === 'auto' && cliCaps?.version && !cliCaps.autoPermissionMode
      ? [
          `Your Claude CLI (${cliCaps.version.split(/\s+/)[0]}) doesn't support Auto — Claude sessions start in "${PERMISSION_MODE_LABELS.manual}". Requires Claude Code ${AUTO_PERMISSION_MODE_MIN_VERSION} or newer.`,
          // The bystanders are derived, AND so is the verb agreeing with them: a hardcoded "are"
          // degrades to "Grok are unaffected." if the capable list ever narrows to two, and the
          // sentence has to disappear entirely if claude is ever the only capable agent.
          otherModeAgents.length
            ? `${permissionModeAgentsLabel({ exclude: ['claude'] })} ${otherModeAgents.length === 1 ? 'is' : 'are'} unaffected.`
            : ''
        ]
          .filter(Boolean)
          .join(' ')
      : undefined

  return (
    <SettingsSection
      id="agents"
      title="Agents"
      description={hintLabel('Enable or disable agents in the Add menus, and pick the default (⌘⇧C).')}
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.agents}>
        <div className="space-y-2">
          {rows.map((row) => {
            const enabled = isAgentEnabled(settings, row.id)
            const isDefault = settings.defaultAgent === row.id
            return (
              <div key={row.id} className="flex items-center gap-3 py-1.5">
                <AgentIcon agentId={row.id} size={18} />
                <span className="flex-1 text-[13px] text-text">{row.label}</span>
                {row.isBuiltin && (
                  <Button
                    variant={isDefault ? 'primary' : 'default'}
                    aria-pressed={isDefault}
                    onClick={() => update(setDefaultAgent(settings, row.id))}
                  >
                    {isDefault ? 'Default' : 'Set default'}
                  </Button>
                )}
                <SegmentedPill<'enabled' | 'disabled'>
                  value={enabled ? 'enabled' : 'disabled'}
                  ariaLabel={`${row.label} availability`}
                  options={[
                    { value: 'enabled', label: 'Enabled' },
                    { value: 'disabled', label: 'Disabled' }
                  ]}
                  onChange={(v) => update(setAgentEnabled(settings, row.id, v === 'enabled'))}
                />
              </div>
            )
          })}
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.permissionMode}>
        <FieldRow
          label="Permission mode"
          note={autoNote}
          description={permissionModeDescription()}
          control={
            <Select
              aria-label="Agent permission mode"
              value={settings.claudePermissionMode}
              onChange={(e) =>
                update({ claudePermissionMode: e.target.value as AgentPermissionMode })
              }
            >
              {ALL_PERMISSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {m === 'bypassPermissions'
                    ? `${PERMISSION_MODE_LABELS[m]} ⚠︎`
                    : PERMISSION_MODE_LABELS[m]}
                </option>
              ))}
            </Select>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.hookReplyApprovals}>
        <FieldRow
          label="One-click approvals"
          description="Phone/canvas Approve & Deny answer Claude's permission hook directly; the interactive prompt appears after 45s if unanswered. Claude terminal sessions only."
          control={
            <Switch
              checked={settings.hookReplyApprovals}
              ariaLabel="One-click hook-reply approvals"
              onChange={(on) => update({ hookReplyApprovals: on })}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.agentSeamlessWrites}>
        <FieldRow
          label="Seamless agent messaging"
          description="Deliver agent-to-node write requests without the per-message confirmation dialog. Any control-capable agent can then type into any node's terminal unseen — enable only for trusted pair-programming flows. Closing nodes always confirms."
          control={
            <Switch
              checked={settings.agentSeamlessWrites}
              ariaLabel="Seamless agent messaging"
              onChange={(on) => update({ agentSeamlessWrites: on })}
            />
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
