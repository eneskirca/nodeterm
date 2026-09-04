import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { useProjects } from '../state/projects'
import { isOmniKanbanEnabled, useViewMode, viewFor } from '../state/viewMode'
import { useAgentStatus } from '../state/agentStatus'
import { useSettings } from '../state/settings'
import { accountsForProject, sshAccountsHint, systemAccountDisplay } from '../state/workspace'
import { useSshConn } from '../state/sshConn'
import { sshAutoModeHint } from '../state/permissionMode'
import { useSystemAccount } from '../state/systemAccount'
import { sessionCount, sessionForProject, useProjectSession } from '../session/session'
import { tabClickAction } from '../session/relay-tab'
import { useMenuFlip } from '../ui/useMenuFlip'
import { commandTooltip } from '../lib/keybindingOverrides'
import { IconCanvasView, IconChevronDown, IconKanban, IconPlus } from './icons'
import { ProjectGlyph } from './ProjectGlyph'
import {
  ALL_PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  type AgentPermissionMode
} from '@shared/agents/config'
import { bypassSandboxCaveat, permissionModeAgentsLabel } from '@shared/agents/approval-mode'

interface TabBarProps {
  onSwitch: (id: string) => void
  /** Reconnect an offline (dropped) relay tab in place (Stage 4 Task 7). Called when an
   *  "unavailable" tab whose session is a relay/server source is clicked. */
  onReconnect: (id: string) => void
  /** Reorder a project to sit before another (null = to the end). Shared with the sessions
   *  sidebar: both surfaces render the projects array, so one drag updates both. */
  onReorder: (draggedId: string, beforeId: string | null) => void
  /** Open the start screen (New project / Open folder / Clone repo), what "+" now shows. */
  onOpenWelcome: () => void
  onRename: (id: string, name: string) => void
  onSetFolder: (id: string) => void
  /** Close (hide) the project without destroying it, reopenable from the start screen. */
  onCloseProject: (id: string) => void
  /** Open the Remote access dialog (host/share + connect). Shown for every project. */
  onRemoteAccess: () => void
  /** Set (or clear, with undefined) the project's default Claude account for new nodes. */
  onSetDefaultAccount: (id: string, accountId: string | undefined) => void
  /** Set (or clear, with undefined = use the global setting) the project's default permission mode. */
  onSetDefaultPermissionMode: (id: string, mode: AgentPermissionMode | undefined) => void
  /** Deep-link to this project's own pane in Settings — everything this menu can change plus the
   *  shared/machine-local settings families, which have no other entry point. */
  onOpenProjectSettings: (id: string) => void
}

/**
 * The runtime session dimension of a tab (which core the project lives on). Rendered ONLY when
 * more than one session exists, `sessionCount()` is 1 for a solo user today, so this never
 * mounts and the solo tab bar is pixel-identical. Its own component because
 * `useProjectSession` is a hook and the tabs render in a `.map()`. Nothing here is persisted:
 * the project → session binding is resolved at runtime by `sessionForProject`.
 */
function TabSessionLabel({ projectId }: { projectId: string }) {
  const session = useProjectSession(projectId)
  return (
    <span className="tab__session" title={`Session: ${session.label} (${session.status})`}>
      {session.label}
    </span>
  )
}

/**
 * Top tab bar, one tab per project. Click to switch, "+" to add. The active tab
 * exposes a caret menu (Rename / Set folder / Delete). The menu is rendered in a body
 * portal with fixed positioning so it is never clipped by the tab strip's overflow nor
 * hidden behind the canvas.
 */
export function TabBar({
  onSwitch,
  onReconnect,
  onReorder,
  onOpenWelcome,
  onRename,
  onSetFolder,
  onCloseProject,
  onRemoteAccess,
  onSetDefaultAccount,
  onSetDefaultPermissionMode,
  onOpenProjectSettings
}: TabBarProps) {
  // Select the raw array and filter in a memo, a `.filter()` inside the selector returns a
  // fresh array every store snapshot, which re-rendered the TabBar on EVERY projects change.
  const allProjects = useProjects((s) => s.projects)
  // Closed projects are hidden here (reopen them from the start screen's "Recently closed").
  const projects = useMemo(() => allProjects.filter((p) => !p.closed), [allProjects])
  const activeId = useProjects((s) => s.activeProjectId)
  const omniEnabled = useSettings((s) => isOmniKanbanEnabled(s.settings))
  const globalKanban = useViewMode((s) => s.globalKanban)
  const isGlobal = omniEnabled && globalKanban
  const perProjectKanban = useViewMode((s) => !!activeId && viewFor(s, activeId) === 'kanban')
  const kanbanActive = isGlobal || perProjectKanban
  const highlightedId = useViewMode((s) => s.highlightedSwimlaneId)
  // Unread dots need only the unread id set — subscribing to the whole status map re-rendered
  // the TabBar on every working/waiting flip of any agent. Primitive signature → rare updates.
  const unreadIds = useAgentStatus((s) => {
    let ids = ''
    for (const [id, st] of Object.entries(s.byId)) if (st?.unread) ids += `${id}|`
    return ids
  })
  const unreadSet = useMemo(() => new Set(unreadIds.split('|').filter(Boolean)), [unreadIds])
  const [menuId, setMenuId] = useState<string | null>(null)
  // `flipBase` is the ANCHOR's top edge: when the menu would overflow the bottom of the window,
  // it opens upward from the caret button instead (see useMenuFlip below).
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; flipBase: number } | null>(
    null
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Tab drag-reorder: the project id being dragged + the current drop target ('' = end zone).
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  // Whether the caret menu's "Default Claude account" group is expanded (inline, in-place).
  const [acctOpen, setAcctOpen] = useState(false)
  // Whether the caret menu's "Default permission mode" group is expanded (same idiom as acctOpen).
  const [modeOpen, setModeOpen] = useState(false)
  const claudeAccounts = useSettings((s) => s.settings.claudeAccounts)
  // The mode a project without an override falls back to, shown in the "Use global (…)" entry.
  const globalMode = useSettings((s) => s.settings.claudePermissionMode)
  const systemLabelSetting = useSettings((s) => s.settings.systemAccountLabel)
  const systemEmail = useSystemAccount((s) => s.email)
  const systemLabel = systemAccountDisplay(systemLabelSetting, systemEmail)

  // Session labels appear only once a second session exists (4c: remote tabs). For a solo user
  // this is always false, so the tab strip renders exactly as before. Plain call, not a
  // subscription: sessions are registered at boot (and, in 4c, on connect, which re-renders
  // through its own state), so no store is needed here.
  const multiSession = sessionCount() > 1

  const menuProject = projects.find((p) => p.id === menuId)
  // Accounts eligible as the caret-menu project's default: local accounts for a local project, this
  // host's accounts for an SSH project (pending logins always excluded).
  const menuAccounts = accountsForProject(claudeAccounts, menuProject)
  // SSH project with no accounts on its host: say where accounts for this host come from instead
  // of presenting a bare System-only list (which read as "multi-account is broken on SSH").
  const menuAccountsHint = sshAccountsHint(menuProject, menuAccounts)
  // Live remote-probe view for the Auto rows below: on an SSH project `auto` only applies once the
  // REMOTE claude CLI is confirmed >= 2.1.71, and without a hint that silent fail-open degrade is
  // indistinguishable from a broken dropdown. Subscribed (not getState) so the ⚠︎ clears the
  // moment the probe answers while the menu is open.
  const autoPermByProject = useSshConn((s) => s.autoPermByProject)
  const remoteClaudeVersionByProject = useSshConn((s) => s.remoteClaudeVersionByProject)
  const menuAutoHint = menuProject?.ssh
    ? sshAutoModeHint(
        autoPermByProject[menuProject.id] === undefined
          ? 'unknown'
          : autoPermByProject[menuProject.id]
            ? 'yes'
            : 'no',
        remoteClaudeVersionByProject[menuProject.id]
      )
    : null

  const closeMenu = () => {
    setMenuId(null)
    setMenuPos(null)
    setAcctOpen(false)
    setModeOpen(false)
  }

  const openMenu = (id: string, anchor: HTMLElement) => {
    const r = anchor.getBoundingClientRect()
    setMenuId(id)
    setMenuPos({ top: r.bottom + 4, left: r.left, flipBase: r.top - 4 })
  }

  // Viewport-edge flip for the caret menu, same behavior as the right-click ContextMenu. The
  // hook runs unconditionally (menuPos may be null while closed; the ref is simply unattached
  // then) and re-measures on size changes, so EXPANDING the account/permission sub-lists near
  // the bottom edge lifts the menu instead of growing it off-screen.
  const menuFlip = useMenuFlip(menuPos?.top ?? 0, menuPos?.left ?? 0, menuPos?.flipBase)

  const startRename = (id: string, current: string) => {
    setEditingId(id)
    setDraft(current)
    closeMenu()
  }

  const commitRename = () => {
    if (editingId) {
      const name = draft.trim()
      if (name) onRename(editingId, name)
    }
    setEditingId(null)
  }

  // Drop-at-end: the wrapper (gap between pill and +, empty title-bar to the right of +,
  // and the + itself). Per-tab handlers stopPropagation, so a drop ON a tab is still
  // insert-before. The + used to live inside the scroller, so a drop on it already meant
  // "after the last tab".
  const onEndZoneDragOver = (e: DragEvent) => {
    if (!dragId) return
    e.preventDefault()
    if (dropId !== '') setDropId('')
  }
  const onEndZoneDrop = (e: DragEvent) => {
    if (!dragId) return
    e.preventDefault()
    onReorder(dragId, null)
    setDragId(null)
    setDropId(null)
  }

  // The strip scrolls without a visible scrollbar (see .tabbar__tabs), so keep it navigable:
  // a plain mouse wheel scrolls it horizontally, and the active tab is brought into view.
  const tabsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    tabsRef.current
      ?.querySelector('.tab.active')
      ?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  }, [activeId, projects.length])

  return (
    <>
      {(menuId || editingId) && (
        <div
          className="tab-backdrop"
          onClick={() => {
            closeMenu()
            commitRename()
          }}
        />
      )}

      <div className="tabbar">
        <div className="brand">
          <svg className="brand__mark" viewBox="0 0 48 48" width="26" height="26" aria-hidden="true">
            <defs>
              <linearGradient id="ntg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#a38dff" />
                <stop offset="1" stopColor="#622994" />
              </linearGradient>
            </defs>
            <path
              d="M13 12 L31 24 L13 36"
              fill="none"
              stroke="url(#ntg)"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="13" cy="12" r="3.6" fill="#a38dff" />
            <circle cx="13" cy="36" r="3.6" fill="#a38dff" />
            <circle cx="31" cy="24" r="3.6" fill="#fff" />
            <rect x="33.5" y="32.5" width="10.5" height="5" rx="2.5" fill="#a38dff" />
          </svg>
          <span className="brand__name">nodeterm</span>
        </div>

        {/* Projects group: the pill scrolls; the + is a SIBLING so it cannot scroll away
            with the tabs (issue #375). End-zone drop lives on this wrapper (covers the
            4px gap and the +); per-tab handlers still stopPropagation. */}
        <div
          className="tabbar__projects"
          onDragOver={onEndZoneDragOver}
          onDrop={onEndZoneDrop}
        >
          <div
            className="tabbar__tabs"
            ref={tabsRef}
            onWheel={(e) => {
              // Translate a vertical mouse wheel into horizontal strip scrolling (trackpads
              // already produce deltaX). Nothing above the canvas scrolls vertically anyway.
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
            }}
          >
          {projects.map((p) => {
            const active = isGlobal ? (highlightedId ? p.id === highlightedId : p.id === activeId) : p.id === activeId
            const swimlaneHighlight = isGlobal && p.id === highlightedId
            const unreadCount = p.nodes.filter((n) => unreadSet.has(n.id)).length
            return (
              <div
                key={p.id}
                className={`tab${active ? ' active' : ''}${swimlaneHighlight ? ' tab--swimlane-highlight' : ''}${p.unavailable ? ' unavailable' : ''}${dropId === p.id ? ' is-drop-before' : ''}`}
                style={active ? { color: p.color } : undefined}
                draggable={editingId !== p.id}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  setDragId(p.id)
                }}
                onDragEnd={() => {
                  setDragId(null)
                  setDropId(null)
                }}
                onDragOver={(e) => {
                  if (!dragId) return
                  // Swallow even over the dragged tab itself, so the strip's end-zone
                  // highlight doesn't flicker on while passing over it.
                  e.stopPropagation()
                  if (dragId === p.id) return
                  e.preventDefault()
                  if (dropId !== p.id) setDropId(p.id)
                }}
                onDragLeave={() => setDropId((d) => (d === p.id ? null : d))}
                onDrop={(e) => {
                  if (!dragId || dragId === p.id) return
                  e.preventDefault()
                  e.stopPropagation()
                  onReorder(dragId, p.id)
                  setDragId(null)
                  setDropId(null)
                }}
                onClick={() => {
                  if (editingId) return
                  // In global swimlane overview, clicking the top project tab jumps to its
                  // swimlane instead of switching the canvas project (analog zu Cmd+1..9).
                  if (isGlobal) {
                    useViewMode.getState().setHighlightedSwimlaneId(p.id)
                    window.dispatchEvent(new CustomEvent('nodeterm:swimlane-jump', { detail: { projectId: p.id } }))
                    return
                  }
                  const action = tabClickAction(!!p.unavailable, sessionForProject(p.id).source)
                  if (action === 'switch') onSwitch(p.id)
                  else if (action === 'reconnect') onReconnect(p.id)
                }}
                title={
                  p.unavailable
                    ? sessionForProject(p.id).source === 'local'
                      ? `${p.cwd ?? 'project'} is unavailable (folder missing or unreachable)`
                      : `${p.name} disconnected, click to reconnect`
                    : p.ssh
                      ? `${p.ssh.server.user}@${p.ssh.server.host}:${p.ssh.remoteCwd}`
                      : p.cwd || undefined
                }
              >
                <ProjectGlyph
                  icon={p.icon}
                  color={active ? p.color : undefined}
                  name={p.name}
                  variant="dot"
                  // With an icon set, the glyph needs a larger, tint-free box (--icon modifier);
                  // without one it stays the plain 9px fallback dot, byte-identical to before.
                  className={p.icon ? 'tab__dot tab__dot--icon' : 'tab__dot'}
                />
                {/* An SSH project looks identical to a local one once it is named, and the
                    difference matters: its terminals, git and file ops all run on another
                    machine. The chip says so at a glance; the tab title carries user@host. */}
                {p.ssh && (
                  <span className="tab__ssh" title={`${p.ssh.server.user}@${p.ssh.server.host}`}>
                    SSH
                  </span>
                )}
                {editingId === p.id ? (
                  <input
                    className="tab__edit"
                    value={draft}
                    autoFocus
                    spellCheck={false}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="tab__name">{p.name}</span>
                )}

                {multiSession && <TabSessionLabel projectId={p.id} />}

                {unreadCount > 0 && (
                  <span className="tab__badge" title={`${unreadCount} unread`}>
                    {unreadCount}
                  </span>
                )}

                {active && editingId !== p.id && (
                  // The title was a hardcoded `(⌘⇧B)` — mac glyphs shown to Linux/Windows users
                  // (a pre-existing bug: it was never even hintLabel-wrapped), and stale after a
                  // remap. `commandTooltip` fixes both and drops the chord entirely when the
                  // command is unbound.
                  <button
                    className="tab__board-toggle"
                    title={commandTooltip(
                      kanbanActive ? 'Canvas view' : 'Kanban view',
                      'view.kanbanToggle'
                    )}
                    onClick={(e) => {
                      e.stopPropagation() // a tab click switches projects, this only flips the view
                      const vm = useViewMode.getState()
                      const settings = useSettings.getState().settings
                      const omni = isOmniKanbanEnabled(settings)
                      const asDefault = settings.omniKanbanAsDefault === true
                      // Closing: global overlay is exclusive — any board toggle while it's open closes it.
                      if (vm.globalKanban) {
                        vm.toggleGlobalKanban()
                        return
                      }
                      if (omni && asDefault) {
                        vm.toggleGlobalKanban()
                      } else {
                        vm.toggle(p.id)
                      }
                    }}
                  >
                    {kanbanActive ? <IconCanvasView /> : <IconKanban />}
                  </button>
                )}
                {active && editingId !== p.id && (
                  <button
                    className="tab__caret"
                    title="Project options"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (menuId === p.id) closeMenu()
                      else openMenu(p.id, e.currentTarget)
                    }}
                  >
                    <IconChevronDown />
                  </button>
                )}
              </div>
            )
          })}
          </div>
          <button
            type="button"
            className="tab__add"
            title="New project"
            aria-label="New project"
            onClick={onOpenWelcome}
          >
            <IconPlus />
          </button>
        </div>
      </div>

      {menuId &&
        menuPos &&
        menuProject &&
        createPortal(
          <div
            ref={menuFlip.ref}
            className="tab-menu"
            style={{ top: menuFlip.top, left: menuFlip.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => startRename(menuProject.id, menuProject.name)}>Rename</button>
            <button
              onClick={() => {
                onSetFolder(menuProject.id)
                closeMenu()
              }}
            >
              Set folder…
            </button>
            <button
              onClick={() => {
                onRemoteAccess()
                closeMenu()
              }}
            >
              Remote access…
            </button>
            {menuAccounts.length > 0 && (
              <>
                <button
                  className={`tab-menu__group${acctOpen ? ' open' : ''}`}
                  onClick={() => setAcctOpen((v) => !v)}
                >
                  Default Claude account
                  <span className="tab-menu__caret">▸</span>
                </button>
                {acctOpen && (
                  <div className="tab-menu__sub">
                    <button
                      onClick={() => {
                        onSetDefaultAccount(menuProject.id, undefined)
                        closeMenu()
                      }}
                    >
                      <span className="tab-menu__check">
                        {menuProject.defaultAccountId ? '' : '✓'}
                      </span>
                      {systemLabel}
                    </button>
                    {menuAccounts.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => {
                          onSetDefaultAccount(menuProject.id, a.id)
                          closeMenu()
                        }}
                      >
                        <span className="tab-menu__check">
                          {menuProject.defaultAccountId === a.id ? '✓' : ''}
                        </span>
                        {a.label}
                      </button>
                    ))}
                    {menuAccountsHint && (
                      <button disabled title={menuAccountsHint}>
                        <span className="tab-menu__check" />
                        No accounts on this host yet
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            <button
              className={`tab-menu__group${modeOpen ? ' open' : ''}`}
              onClick={() => setModeOpen((v) => !v)}
            >
              Default permission mode
              <span className="tab-menu__caret">▸</span>
            </button>
            {modeOpen && (
              <div className="tab-menu__sub">
                <button
                  // On an SSH project the global Auto only applies once the REMOTE CLI is
                  // confirmed, surface why it may currently do nothing (see menuAutoHint).
                  title={globalMode === 'auto' ? (menuAutoHint ?? undefined) : undefined}
                  onClick={() => {
                    onSetDefaultPermissionMode(menuProject.id, undefined)
                    closeMenu()
                  }}
                >
                  <span className="tab-menu__check">
                    {menuProject.defaultPermissionMode ? '' : '✓'}
                  </span>
                  Use global ({PERMISSION_MODE_LABELS[globalMode]})
                  {globalMode === 'auto' && menuAutoHint ? ' ⚠︎' : ''}
                </button>
                {ALL_PERMISSION_MODES.map((m) => (
                  <button
                    key={m}
                    // A project override is written to <cwd>/.nodeterm/project.json, which is
                    // git-shared and mirrored to SSH servers, spell out for "Bypass all" that
                    // the choice travels to everyone who clones the repo. The Auto row instead
                    // explains when it will NOT apply on this SSH project's host (remote CLI too
                    // old / not found / not probed yet), still selectable: the setting is kept
                    // and applies the moment the host's CLI qualifies.
                    title={
                      m === 'bypassPermissions'
                        ? // Both the agent list and the sandbox caveat are derived from the mapping
                          // (approval-mode.ts): the list names exactly the agents "Bypass all"
                          // actually reaches, so it cannot warn about an agent the mode never applies
                          // to — or fall silent about one it newly does. The caveat is owed because
                          // for codex the mode skips APPROVALS only: `--ask-for-approval never` does
                          // not touch `--sandbox`, which we deliberately leave alone, so "no
                          // permission checks" must not be read as "no sandbox either".
                          `Skips every permission prompt. This override is saved in the project file (.nodeterm/project.json), so if you commit it, everyone who clones the repo runs their ${permissionModeAgentsLabel({ mode: 'bypassPermissions' })} sessions without permission checks too. ${bypassSandboxCaveat()}`.trim()
                        : m === 'auto'
                          ? (menuAutoHint ?? undefined)
                          : undefined
                    }
                    onClick={() => {
                      onSetDefaultPermissionMode(menuProject.id, m)
                      closeMenu()
                    }}
                  >
                    <span className="tab-menu__check">
                      {menuProject.defaultPermissionMode === m ? '✓' : ''}
                    </span>
                    {m === 'bypassPermissions' || (m === 'auto' && menuAutoHint)
                      ? `${PERMISSION_MODE_LABELS[m]} ⚠︎`
                      : PERMISSION_MODE_LABELS[m]}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => {
                onOpenProjectSettings(menuProject.id)
                closeMenu()
              }}
            >
              Project settings…
            </button>
            <button
              onClick={() => {
                onCloseProject(menuProject.id)
                closeMenu()
              }}
            >
              Close project
            </button>
          </div>,
          document.body
        )}
    </>
  )
}
