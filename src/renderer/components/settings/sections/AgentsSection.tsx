import { useEffect, useState } from 'react'
import { useSettings } from '../../../state/settings'
import { useProjects } from '../../../state/projects'
import { useBrowserLease, drivingNodeIds } from '../../../state/browserLease'
import {
  PROJECT_CAPABILITIES,
  PROJECT_CAPABILITY_COPY,
  projectCapabilityFlagInFile
} from '@shared/project-capabilities'
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
  hasSharedIdentity,
  PERMISSION_MODE_LABELS,
  type AgentId,
  type AgentPermissionMode,
  type BuiltinAgentId
} from '@shared/agents/config'
import {
  permissionModeAgentIds,
  permissionModeAgentsLabel,
  unsupportedModesNote
} from '@shared/agents/approval-mode'
import { AgentIcon } from '../../../lib/agentIcons'
import { chipFor } from '../../../lib/keybindingOverrides'
import { NODE_IDENTITY_STRICT_DATE } from '@shared/node-identity'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { Select } from '@renderer/ui/Select'
import { Switch } from '@renderer/ui/Switch'
import { NumberField } from '@renderer/ui/NumberField'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'

const ROWS = {
  agents: {
    title: 'Agents',
    keywords: ['agent', 'claude', 'codex', 'gemini', 'enable', 'disable', 'default']
  },
  launchCommands: {
    title: 'Launch commands',
    keywords: [
      'launch',
      'command',
      'wrapper',
      'cli',
      'binary',
      'path',
      'account',
      'switch',
      'custom command',
      'claude',
      'codex',
      'gemini',
      'grok',
      'opencode'
    ]
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
  messagingDefault: {
    title: 'Messaging in new projects',
    keywords: ['agent', 'message', 'messaging', 'default', 'project', 'communication']
  },
  nodeIdentity: {
    title: 'Verified node identity',
    keywords: [
      'identity',
      'verify',
      'verified',
      'node',
      'token',
      'canvas control',
      'context link',
      'security',
      'hook',
      'strict',
      'refused'
    ]
  },
  browserControl: {
    title: 'Browser control',
    keywords: [
      'browser',
      'control',
      'drive',
      'driving',
      'stop',
      'revoke',
      'agent',
      'web',
      'page',
      'security'
    ]
  },
  hibernation: {
    title: 'Hibernate idle agents',
    keywords: [
      'hibernate',
      'eco',
      'idle',
      'memory',
      'ram',
      'exit',
      'resume',
      'offscreen',
      'minutes',
      'sleep',
      'pause',
      'paused',
      'restart',
      'reopen'
    ]
  }
}
/**
 * The per-project capability rows are GENERATED from PROJECT_CAPABILITIES — search registry
 * included. A hand-written row list that happens to match the union is the documented
 * claims-ahead-of-mechanism failure: agent messaging's row (its PR 6) must appear by adding a copy
 * entry, and agents-capabilities.test.tsx iterates the array so a capability without a row is red.
 */
const CAPABILITY_ROWS = PROJECT_CAPABILITIES.map((cap) => ({
  cap,
  title: PROJECT_CAPABILITY_COPY[cap].label,
  keywords: [
    'project',
    'capability',
    'permission',
    ...PROJECT_CAPABILITY_COPY[cap].label.toLowerCase().split(/\s+/)
  ]
}))
const ENTRIES = [
  ...Object.values(ROWS),
  ...CAPABILITY_ROWS.map(({ title, keywords }) => ({ title, keywords }))
]

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

/**
 * `settings.hookIdentityStrict` is the only OPTIONAL key in `Settings`, because it is a TRI-state
 * and `undefined` ("follow the dated rollout") is a different answer from `false` ("never enforce").
 * A `Switch` cannot express that — it would silently collapse the default into one of the two
 * explicit choices the first time anybody touched it — so this row is a `Select` over three values
 * that map back onto `boolean | undefined`.
 *
 * The date is imported, never typed here: a Settings page promising a different cutoff from the one
 * the hook server enforces is the worst possible version of this feature.
 */
const IDENTITY_CHOICES = ['auto', 'on', 'off'] as const
type IdentityChoice = (typeof IDENTITY_CHOICES)[number]

const IDENTITY_LABELS: Record<IdentityChoice, string> = {
  auto: `Automatic (required from ${NODE_IDENTITY_STRICT_DATE})`,
  on: 'Always required',
  off: 'Not required'
}

function identityChoice(value: boolean | undefined): IdentityChoice {
  return value === undefined ? 'auto' : value ? 'on' : 'off'
}

function identityValue(choice: IdentityChoice): boolean | undefined {
  return choice === 'auto' ? undefined : choice === 'on'
}

export function AgentsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  // Per-project capability rows act on the ACTIVE project. Subscribed (not getState()) so an
  // off-toggle re-renders immediately — and consumers read the switch per call from the store,
  // never from a snapshot taken when a lease started (agents-capabilities.test.tsx "takes effect
  // LIVE"; browser PR 4 / messaging PR 6 rely on that shape).
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const activeProject = useProjects((s) => s.projects.find((p) => p.id === activeProjectId))
  const setProjectCapability = useProjects((s) => s.setProjectCapability)
  // The kill row (Task 6.4): browser nodes an agent is driving RIGHT NOW, across every open project,
  // each with a Stop and one Stop-all. The precedent is the identity escape hatch — a user who
  // notices their browser doing something needs one obvious place to end it, not a per-node hunt.
  // Stop revokes for real in main (detach + drop), and there is deliberately NO global "disable
  // browser control" toggle here: one concept, one switch (the per-project capability below).
  const browserLeaseEntries = useBrowserLease((s) => s.entries)
  const allProjects = useProjects((s) => s.projects)
  const nodeTitleById = (id: string): string => {
    for (const p of allProjects) {
      const n = p.nodes.find((node) => node.id === id)
      if (n) return n.title || id
    }
    return id
  }
  const drivenRows = [...drivingNodeIds(browserLeaseEntries, Date.now())].map((nodeId) => ({
    nodeId,
    nodeTitle: nodeTitleById(nodeId),
    ownerTitle: nodeTitleById(browserLeaseEntries[nodeId].ownerNodeId)
  }))
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

  // Whatever "new agent node" is bound to; '' when unbound, and the sentence drops the chord.
  const agentChip = chipFor('node.newAgent')

  return (
    <SettingsSection
      id="agents"
      title="Agents"
      description={agentChip
        ? `Enable or disable agents in the Add menus, and pick the default (${agentChip}).`
        : 'Enable or disable agents in the Add menus, and pick the default.'}
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
                {/* Custom agents included — a user living on their own CLI aliases must be able
                    to make one the default (⌘⇧C / Add menu) instead of a disabled claude. */}
                <Button
                  variant={isDefault ? 'primary' : 'default'}
                  aria-pressed={isDefault}
                  onClick={() => update(setDefaultAgent(settings, row.id))}
                >
                  {isDefault ? 'Default' : 'Set default'}
                </Button>
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
      <SearchableRow {...ROWS.launchCommands}>
        <FieldRow
          label="Launch commands"
          description={
            'Launch an agent with your own command — e.g. a wrapper script that switches accounts or sets env vars. ' +
            'Used everywhere the agent is launched (new sessions, resumes, restarts), with flags like --resume appended after it, ' +
            'so the command must pass its arguments through — a shell script should end with `exec claude "$@"`. ' +
            'A flag your command already spells is left alone: write the permission mode here and it wins over the start-up mode below. ' +
            'Leave empty for the default. SSH projects run the same command on the remote host.'
          }
          control={null}
        />
        <div className="space-y-2">
          {BUILTIN_AGENT_IDS.map((id: BuiltinAgentId) => (
            <div key={id} className="flex items-center gap-3 py-1">
              <AgentIcon agentId={id} size={18} />
              <span className="w-28 text-[13px] text-text">{AGENT_CONFIG[id].label}</span>
              <Input
                className="w-72"
                placeholder={AGENT_CONFIG[id].launchCmd}
                aria-label={`${AGENT_CONFIG[id].label} launch command`}
                value={settings.agentLaunchCommands[id] ?? ''}
                onChange={(e) => {
                  // A cleared field DELETES its key rather than storing '' — absent is the one
                  // spelling of "default" every consumer (and a hand-read settings.json) agrees on.
                  const next = { ...settings.agentLaunchCommands }
                  if (e.target.value) next[id] = e.target.value
                  else delete next[id]
                  update({ agentLaunchCommands: next })
                }}
              />
              {hasSharedIdentity(id) && settings.agentLaunchCommands[id]?.trim() ? (
                <span className="text-[12px] text-muted">
                  Overrides the managed per-node launcher — sessions join as plain clients.
                </span>
              ) : null}
            </div>
          ))}
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
      <SearchableRow {...ROWS.messagingDefault}>
        <FieldRow
          label="Messaging in new projects"
          description="Turn agent messaging on when this machine creates a project. Existing projects keep their current setting, and cloned project files still require confirmation."
          control={
            <Switch
              checked={settings.agentMessagingDefault}
              ariaLabel="Messaging in new projects"
              onChange={(on) => update({ agentMessagingDefault: on })}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.nodeIdentity}>
        <FieldRow
          label="Require verified node identity for canvas control"
          description={`Commands that open, write to or close nodes — and that read a linked node's context — must present the identity NodeTerm issued to the node they say they came from. Automatic starts refusing the ones that can't from ${NODE_IDENTITY_STRICT_DATE}; until then they still run and the reply tells you to restart that node. Set this to "Not required" if an upgrade left a running session unable to drive the canvas: it restores the behaviour from before this feature, past ${NODE_IDENTITY_STRICT_DATE} as well. Browser control is the one exception — it always requires verified identity and this setting never releases it. An identity that is actually forged is refused whatever you pick here.`}
          control={
            <Select
              aria-label="Require verified node identity"
              value={identityChoice(settings.hookIdentityStrict)}
              onChange={(e) =>
                update({ hookIdentityStrict: identityValue(e.target.value as IdentityChoice) })
              }
            >
              {IDENTITY_CHOICES.map((c) => (
                <option key={c} value={c}>
                  {IDENTITY_LABELS[c]}
                </option>
              ))}
            </Select>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.browserControl}>
        <FieldRow
          label="Browser control"
          description="Browser nodes an agent is driving right now, across every open project. Stop ends it immediately — the debugger is detached and the agent is told you stopped it, so it reports that instead of retrying. One place to stop it, so you never have to hunt from node to node."
          control={
            <Button
              variant="default"
              disabled={drivenRows.length === 0}
              onClick={() => window.nodeTerminal.browser.stopAll()}
            >
              Stop all
            </Button>
          }
        />
        <div className="space-y-2">
          {drivenRows.length === 0 ? (
            <span className="text-[13px] text-muted">No agent is driving a browser node right now.</span>
          ) : (
            drivenRows.map((r) => (
              <div key={r.nodeId} className="flex items-center gap-3 py-1">
                <span className="flex-1 text-[13px] text-text">
                  {r.ownerTitle} is driving {r.nodeTitle}
                </span>
                <Button variant="default" onClick={() => window.nodeTerminal.browser.stop(r.nodeId)}>
                  Stop
                </Button>
              </div>
            ))
          )}
        </div>
      </SearchableRow>
      {CAPABILITY_ROWS.map(({ cap, title, keywords }) => (
        <SearchableRow key={cap} title={title} keywords={keywords}>
          <FieldRow
            label={title}
            note={
              activeProject
                ? `Applies to the active project: ${activeProject.name}.`
                : 'Open a project to change this — the switch belongs to a project, not to the app.'
            }
            // The description carries the capability's own copy AND its cloneWarning — the same
            // "this is in the project file" sentence the clone notice shows, so the two git-shared
            // grants read alike wherever they appear (pinned by agents-capabilities.test.tsx).
            description={`${PROJECT_CAPABILITY_COPY[cap].description} ${PROJECT_CAPABILITY_COPY[cap].cloneWarning}`}
            control={
              <Switch
                // The raw FILE FLAG is the right thing for a settings switch to display — it
                // mirrors what is written in .nodeterm/project.json. It is NEVER the grant check:
                // grants require the machine-local 'kept' too (projectCapabilityGrantedFor).
                checked={projectCapabilityFlagInFile(activeProject, cap)}
                ariaLabel={title}
                disabled={!activeProject}
                onChange={(on) => {
                  // The ONE strict setter: literal `true` on, field deleted on off. Writing the
                  // value any other way (a string, a stored false) is the bug the validators
                  // exist to refuse.
                  if (activeProject) setProjectCapability(activeProject.id, cap, on)
                  // Turning browser control OFF revokes any live lease in this project immediately
                  // (Task 6.4) — detach now, don't wait for the next drive to read the switch. Read
                  // live off this toggle, never cached at lease start.
                  if (activeProject && cap === 'agentBrowserControl' && !on) {
                    window.nodeTerminal?.browser?.stopProject?.(activeProject.id)
                  }
                }}
              />
            }
          />
        </SearchableRow>
      ))}
      <SearchableRow {...ROWS.hibernation}>
        <FieldRow
          label="Hibernate idle agents"
          description="Exit an agent CLI that has been idle and offscreen this long, freeing its memory; the conversation resumes automatically when you view the node. While this is on, the terminal view of an offscreen agent is kept until the agent hibernates, so the bigger saving happens first. Scheduled, /loop and /cron agents — and sessions with subagents still running — are never touched."
          control={
            <div className="flex items-center gap-2">
              <Switch
                checked={settings.agentHibernationEnabled}
                ariaLabel="Hibernate idle agents"
                onChange={(on) => update({ agentHibernationEnabled: on })}
              />
              <NumberField
                value={settings.agentHibernationIdleMinutes}
                ariaLabel="Hibernate after minutes"
                disabled={!settings.agentHibernationEnabled}
                min={5}
                max={600}
                step={5}
                // A cleared/invalid field falls back to the default rather than 0 (zero minutes
                // would mean "the instant a turn ends"). Deliberately no floor mid-typing: a
                // per-keystroke `Math.max(5, v)` makes 45 untypable (4 snaps to 5, then 55). The
                // real guard is `planHibernation`, which refuses any non-positive window outright.
                onChange={(v) => update({ agentHibernationIdleMinutes: v || 30 })}
              />
              <span className="text-[13px] text-muted">min</span>
            </div>
          }
        />
        <FieldRow
          label="Keep paused after closing"
          description="When Eco hibernates a session, also keep it paused across a project/app reopen instead of auto-resuming — only an explicit Resume brings it back. Manual “Pause session” always persists this way, whatever this is set to."
          control={
            <Switch
              checked={settings.agentHibernationPersistAcrossRestart}
              ariaLabel="Keep paused after closing"
              disabled={!settings.agentHibernationEnabled}
              onChange={(on) => update({ agentHibernationPersistAcrossRestart: on })}
            />
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
