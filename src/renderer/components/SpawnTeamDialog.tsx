import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import { useSettings } from '../state/settings'
import { AgentIcon } from '../lib/agentIcons'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS, canControlCanvas } from '@shared/agents/config'
import type { AgentId } from '@shared/agents/config'
import type { CustomAgent } from '@shared/types'
import { MAX_TEAM_ROLES, type SpawnTeamInput, type TeamRole } from '../lib/spawnTeamPrompt'

interface SpawnTeamDialogProps {
  /** False on SSH projects / non-repos — the toggle renders disabled with `worktreeNote` beside it. */
  worktreesAvailable: boolean
  /** Why worktrees are unavailable (e.g. the SSH notice). Shown only when they are. */
  worktreeNote?: string
  /** The app-wide default agent — the conductor's initial selection. */
  defaultAgent: string
  onSubmit: (v: SpawnTeamInput) => void
  onCancel: () => void
}

/** A selectable agent in a dropdown: builtin or custom. The label is the menu/node title the user
 *  already sees elsewhere (Dock `+`), so the dialog reads as the same set. */
interface AgentOption {
  id: string
  label: string
  custom: boolean
}

/**
 * The agents a role may run, filtered to canvas-control-capable — a teammate that can't drive the
 * canvas (and, for a custom agent, whose `baseAgent` isn't control-capable) is a poor default for
 * an orchestration team. The conductor dropdown is NOT filtered this way (it just opens a node and
 * types a prompt), so it lists every enabled agent; `buildAgentOptions(true)` is the role set.
 */
function buildAgentOptions(
  customAgents: CustomAgent[],
  disabledAgents: string[],
  controlOnly: boolean
): AgentOption[] {
  const builtins = BUILTIN_AGENT_IDS.filter((aid) => !disabledAgents.includes(aid)).map((aid) => ({
    id: aid,
    label: AGENT_CONFIG[aid].label,
    custom: false
  }))
  const customs = customAgents
    .filter((c) => !disabledAgents.includes(c.id))
    .map((c) => ({ id: c.id, label: c.label || c.id, custom: true }))
  const all = [...builtins, ...customs]
  return controlOnly ? all.filter((o) => canControlCanvas(o.id as AgentId)) : all
}

/** Default role state — the first control-capable agent, blank prompt. */
function emptyRole(agent: string): TeamRole {
  return { title: '', prompt: '', agent }
}

/**
 * "Spawn a team…" (issue #78): the user types a task and ONE conductor agent node is opened
 * pre-prompted with it — the conductor's own manage-nodeterm-canvas skill does the role split
 * and the fan-out, so no model plumbing lives in the app. Reuses the `.confirm*` shell like
 * InputDialog; the input is a textarea (Enter inserts a newline — tasks are prose), so submit
 * is ⌘/Ctrl+Enter or the button.
 *
 * Per-role harness (issue #4): a "Define the team explicitly" toggle replaces the conductor with a
 * list of roles, each `{ title?, prompt, agent }`, mirroring the canvas-control `spawn-team` verb.
 * With roles set, `spawnTeam` composes the team inline (no conductor); without, the conductor opens
 * with `conductorAgent` (defaulting to `defaultAgent`). Either path may pick its harness from every
 * enabled agent (builtins + customs); role agents are filtered to control-capable.
 */
export function SpawnTeamDialog({
  worktreesAvailable,
  worktreeNote,
  defaultAgent,
  onSubmit,
  onCancel
}: SpawnTeamDialogProps) {
  const customAgents = useSettings((s) => s.settings.customAgents)
  const disabledAgents = useSettings((s) => s.settings.disabledAgents)
  const [task, setTask] = useState('')
  const [worktrees, setWorktrees] = useState(false)
  const [explicit, setExplicit] = useState(false)
  const [conductorAgent, setConductorAgent] = useState(defaultAgent)
  const [roles, setRoles] = useState<TeamRole[]>(() => [
    emptyRole(defaultAgent),
    emptyRole(defaultAgent)
  ])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // In the modal stack so a ConfirmDialog underneath does not also answer Escape (its listener
  // is on `window`); Enter never leaves the textarea, so nothing else is needed.
  useDialogStack()

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const conductorOptions = useMemo(
    () => buildAgentOptions(customAgents, disabledAgents, false),
    [customAgents, disabledAgents]
  )
  const roleOptions = useMemo(
    () => buildAgentOptions(customAgents, disabledAgents, true),
    [customAgents, disabledAgents]
  )
  // If the conductor selection was disabled/removed from settings, fall back to the default.
  const effectiveConductor = conductorOptions.some((o) => o.id === conductorAgent)
    ? conductorAgent
    : (conductorOptions[0]?.id ?? defaultAgent)

  // Roles whose agent left the role set (disabled / lost control-capability) snap back to the first
  // eligible agent, so a row never holds a value the submit cannot honor.
  const effectiveRoles = roles.map((r) =>
    roleOptions.some((o) => o.id === r.agent) ? r : { ...r, agent: roleOptions[0]?.id ?? r.agent }
  )

  const validRoles = effectiveRoles.filter((r) => r.prompt.trim().length > 0)
  const canSubmit = explicit
    ? validRoles.length > 0
    : task.trim().length > 0

  const submit = (): void => {
    if (!canSubmit) return
    const resolvedWorktrees = worktreesAvailable && worktrees
    if (explicit) {
      onSubmit({
        task,
        worktrees: resolvedWorktrees,
        roles: validRoles.slice(0, MAX_TEAM_ROLES).map((r) => ({
          title: r.title?.trim() || undefined,
          prompt: r.prompt.trim(),
          agent: r.agent
        }))
      })
    } else {
      onSubmit({
        task,
        worktrees: resolvedWorktrees,
        conductorAgent: effectiveConductor
      })
    }
  }

  const addRole = (): void => {
    if (effectiveRoles.length >= MAX_TEAM_ROLES) return
    setRoles([...effectiveRoles, emptyRole(roleOptions[0]?.id ?? defaultAgent)])
  }
  const removeRole = (i: number): void => {
    setRoles(effectiveRoles.filter((_, idx) => idx !== i))
  }
  const updateRole = (i: number, patch: Partial<TeamRole>): void => {
    setRoles(effectiveRoles.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return createPortal(
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm spawn-team" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg">
          Spawn a team — describe the task, and a conductor agent will split it into workstreams
          and open the team on the canvas.
        </p>
        <textarea
          ref={inputRef}
          className="confirm__input confirm__textarea"
          value={task}
          placeholder="What should the team build?"
          rows={3}
          spellCheck={false}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={onKeyDown}
        />

        {!explicit && (
          <label className="spawn-team__field">
            <span className="spawn-team__field-label">Conductor agent</span>
            <div className="spawn-team__select-wrap">
              <AgentIcon agentId={effectiveConductor as AgentId} size={14} />
              <select
                className="spawn-team__select"
                value={effectiveConductor}
                onChange={(e) => setConductorAgent(e.target.value)}
              >
                {conductorOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </label>
        )}

        <label className="confirm__option">
          <input
            type="checkbox"
            checked={worktreesAvailable && worktrees}
            disabled={!worktreesAvailable}
            onChange={(e) => setWorktrees(e.target.checked)}
          />
          Give each workstream its own git worktree
          {!worktreesAvailable && worktreeNote ? ` — ${worktreeNote}` : ''}
        </label>

        <label className="confirm__option">
          <input
            type="checkbox"
            checked={explicit}
            onChange={(e) => setExplicit(e.target.checked)}
          />
          Define the team explicitly (one agent per role, no conductor)
        </label>

        {explicit && (
          <div className="spawn-team__roles">
            {effectiveRoles.map((r, i) => (
              <div className="spawn-team__role" key={i}>
                <div className="spawn-team__role-head">
                  <div className="spawn-team__select-wrap">
                    <AgentIcon agentId={r.agent as AgentId} size={13} />
                    <select
                      className="spawn-team__select"
                      value={r.agent}
                      onChange={(e) => updateRole(i, { agent: e.target.value })}
                    >
                      {roleOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    className="spawn-team__role-title"
                    placeholder="Title (optional — pins the node name)"
                    value={r.title}
                    spellCheck={false}
                    onChange={(e) => updateRole(i, { title: e.target.value })}
                  />
                  <button
                    type="button"
                    className="spawn-team__role-remove"
                    title="Remove role"
                    onClick={() => removeRole(i)}
                  >
                    ×
                  </button>
                </div>
                <textarea
                  className="confirm__input spawn-team__role-prompt"
                  placeholder="This role's task / prompt"
                  rows={2}
                  spellCheck={false}
                  value={r.prompt}
                  onChange={(e) => updateRole(i, { prompt: e.target.value })}
                  onKeyDown={onKeyDown}
                />
              </div>
            ))}
            {effectiveRoles.length < MAX_TEAM_ROLES && (
              <button type="button" className="spawn-team__add" onClick={addRole}>
                + Add role
              </button>
            )}
          </div>
        )}

        <div className="confirm__actions">
          <button className="confirm__btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="confirm__btn primary" disabled={!canSubmit} onClick={submit}>
            {explicit ? 'Spawn team' : 'Open conductor'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
