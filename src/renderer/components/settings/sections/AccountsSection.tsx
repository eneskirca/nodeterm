import { Fragment, useEffect, useState } from 'react'
import { IconClose } from '../../icons'
import { AgentIcon } from '../../../lib/agentIcons'
import type { ClaudeAccount, ClaudeSkillShareResult } from '@shared/types'
import type { CodexAccount } from '@shared/codex-account'
import { E_UNSUPPORTED } from '@shared/rpc'
import { sshHostKey } from '@shared/ssh'
import { useAgentStatus } from '../../../state/agentStatus'
import { useSettings } from '../../../state/settings'
import { useSystemAccount } from '../../../state/systemAccount'
import { useSystemCodexAccount } from '../../../state/systemCodexAccount'
import { isAccountLoginNode } from '../../../state/workspace'
import { NODE_COLOR_SECTIONS } from '@shared/node-colors'
import { useProjects } from '../../../state/projects'
import { useSshConn } from '../../../state/sshConn'
import { useSshServers } from '../../../state/sshServers'
import {
  applyResolvedCodexAccounts,
  discoverResolvedCodexAccounts
} from '../../../state/codexAccountReconcile'
import {
  codexRemoteTargets,
  groupAccountsByMachine,
  strayAccounts
} from '../../../lib/codexMachineGroups'
import { configDirLabel, unlinkedConfigDirs } from '../../../lib/accountChip'
import { presentAccount } from '../../../lib/accountPresentation'
import { skillShareNote } from '../../../lib/skillSharing'
import { codexAccountSelectable } from '../../../canvas/codex-account-switch'
import { ConfirmDialog } from '../../ConfirmDialog'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { Switch } from '@renderer/ui/Switch'
import { cn } from '@renderer/ui/cn'
import { thisMachine, thisMachineCap } from '../../../lib/machineName'

const ROWS = {
  accounts: {
    title: 'Claude & Codex accounts',
    keywords: [
      'account',
      'claude',
      'codex',
      'openai',
      'login',
      'isolated',
      'multi',
      'email',
      'link',
      'config dir',
      'existing',
      'detected',
      'machine',
      'ssh',
      'host',
      'remote'
    ]
  }
}
const ENTRIES = Object.values(ROWS)

/** The bridge's "this shell registers no such handler" rejection (renderer/bridge/stubs.ts). It is
 *  a fact about the SURFACE, not about this account — worth a different sentence than a failure. */
const isUnsupported = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { code?: string }).code === E_UNSUPPORTED

/** The rejection's own message when it has one, else `fallback`. `link` refuses for a handful of
 *  specific, user-fixable reasons (not a directory, already linked, that IS the system account) and
 *  every one of them is worth more than a generic failure line. Errors arrive as plain objects over
 *  the WS bridge, so this reads the field rather than testing `instanceof Error`. */
const errorText = (e: unknown, fallback: string): string => {
  const m = e && typeof e === 'object' ? (e as { message?: unknown }).message : undefined
  return typeof m === 'string' && m.trim() ? m.trim() : fallback
}

/** One machine's card in the accounts UI: a connectivity dot, the machine label, a Local/SSH pill,
 *  and (for a remote machine) its `user@host` subtitle. Children are the provider blocks. */
function MachinePanel({
  label,
  remote,
  hostKey,
  connected,
  children
}: {
  label: string
  remote: boolean
  hostKey?: string
  connected?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      aria-label={remote ? `Accounts on ${hostKey ?? label}` : `Accounts on ${label}`}
      className="space-y-3 rounded-md border border-border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            !remote || connected ? 'bg-[color:var(--ok,#30d158)]' : 'bg-[color:var(--muted-2)]'
          }`}
          aria-hidden
          title={!remote ? 'This machine' : connected ? 'Connected' : 'Not connected'}
        />
        <span className="text-[13px] font-medium text-text">{label}</span>
        <span className="rounded-full bg-fill-weak px-2 py-0.5 text-[11px] font-medium text-muted">
          {remote ? 'SSH' : 'Local'}
        </span>
        {remote && hostKey && hostKey !== label ? (
          <span className="text-[12px] text-muted">{hostKey}</span>
        ) : null}
        {remote && !connected ? (
          <span className="text-[12px] text-muted">
            · not connected — open a project on this host to add or log in accounts
          </span>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/**
 * One provider's accounts on one machine. The SAME frame for Claude and Codex — a heading with the
 * agent's icon and its Add button, then the system row, then the managed rows — so the two
 * providers read, and are added, the same way on every machine.
 */
function ProviderBlock({
  agentId,
  title,
  action,
  error,
  progress,
  children
}: {
  agentId: 'claude' | 'codex'
  title: string
  action: React.ReactNode
  error?: string | null
  progress?: string | null
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[12px] font-medium text-text">
          <AgentIcon agentId={agentId} size={14} />
          {title}
        </div>
        {action}
      </div>
      {progress ? <p className="text-[12px] leading-relaxed text-muted">{progress}</p> : null}
      {error ? <p className="text-[12px] text-[color:var(--danger)]">{error}</p> : null}
      <div className="space-y-2">{children}</div>
    </div>
  )
}

/** The machine's implicit SYSTEM login (`~/.claude` / `~/.codex`) — not an account record, so it
 *  has no remove and no color; `name` may be an editable label (the local Claude one is). */
function SystemAccountRow({
  name,
  detail
}: {
  name: React.ReactNode
  detail?: string | null
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-2">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          {name}
          <span
            className="rounded-full bg-fill-weak px-2 py-0.5 text-[11px] font-medium text-muted"
            title="The machine's default login. Used when a node has no account."
          >
            system
          </span>
        </div>
        {detail ? <p className="text-[12px] text-muted">{detail}</p> : null}
      </div>
    </div>
  )
}

/** A managed account row — identical for both providers; `extra` carries provider-only controls. */
function ManagedAccountRow({
  label,
  placeholder,
  onLabel,
  pending,
  pills,
  email,
  color,
  onColor,
  extra,
  actions,
  blockedReason
}: {
  label: string
  placeholder: string
  onLabel: (label: string) => void
  pending?: boolean
  pills?: React.ReactNode
  email?: string | null
  color?: string
  onColor: (color?: string) => void
  extra?: React.ReactNode
  actions: React.ReactNode
  blockedReason?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-md border p-2',
        blockedReason ? 'border-[color:var(--warn)]/40' : 'border-border/60'
      )}
      title={blockedReason}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Input
            className="w-56"
            placeholder={placeholder}
            value={label}
            onChange={(e) => onLabel(e.target.value)}
          />
          {pending ? (
            <span className="rounded-full bg-[color:var(--warn)]/15 px-2 py-0.5 text-[11px] font-medium text-[color:var(--warn)]">
              pending
            </span>
          ) : null}
          {pills}
        </div>
        {email && !pending ? <p className="text-[12px] text-muted">{email}</p> : null}
        {blockedReason ? (
          <p className="text-[11px] text-[color:var(--warn)]">{blockedReason}</p>
        ) : null}
        <AccountColorSwatches label={label} color={color} onPick={onColor} />
        {extra}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  )
}

/** Which Add button is mid-setup: `<provider>:<host>` (`''` host = this machine). */
type Provider = 'claude' | 'codex'
const addKey = (provider: Provider, host: string): string => `${provider}:${host}`

/** Reads fresh settings then applies a transform to the accounts list (avoids stale closures
 *  after an awaited login resolves late). */
function applyAccounts(fn: (accs: ClaudeAccount[]) => ClaudeAccount[]): void {
  const s = useSettings.getState()
  s.update({ claudeAccounts: fn(s.settings.claudeAccounts) })
}

/** The same fresh-read/transform for the Codex account list. */
function applyCodexAccounts(fn: (accs: CodexAccount[]) => CodexAccount[]): void {
  const s = useSettings.getState()
  s.update({ codexAccounts: fn(s.settings.codexAccounts) })
}

/**
 * The per-account default node color picker. ONE definition for both managed-account kinds: a
 * Claude and a Codex account carry the same optional `color` and feed the same `agentAccountColor`
 * read at node creation, so two copies of these swatches could only drift. `label` names the group
 * for assistive tech (and for the tests) — account labels are user-typed, so it is the only handle
 * a row reliably has.
 */
function AccountColorSwatches({
  label,
  color,
  onPick
}: {
  label: string
  color?: string
  onPick: (color?: string) => void
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={`Default node color for ${label}`}
      className="flex flex-wrap items-center gap-2 pt-1"
    >
      <span className="text-[12px] text-muted">Node color</span>
      <button
        type="button"
        aria-label="Default"
        aria-pressed={!color}
        title="Use the agent's own color"
        onClick={() => onPick(undefined)}
        className={cn(
          'flex size-5 items-center justify-center rounded-full border-2 text-[11px] text-muted',
          color ? 'border-transparent bg-fill-weak' : 'border-text bg-fill-weak'
        )}
      >
        ✕
      </button>
      {NODE_COLOR_SECTIONS.map((section, i) => (
        <Fragment key={section.label}>
          {/* The agent section is headed so a user can tell WHICH circle is Claude's — the whole
              point of putting the brand colors in the palette. The first section keeps its
              historical bare row. */}
          {i > 0 ? (
            <span className="text-[11px] text-muted">{section.label}</span>
          ) : null}
          {section.swatches.map((swatch) => (
            <button
              key={swatch.value}
              type="button"
              // "<what> <name>", the convention the Appearance accent picker set — a bare hex is
              // not a name a screen reader can do anything with, which is also why the palette
              // now carries labels rather than only values.
              aria-label={`Node color ${swatch.label}`}
              title={swatch.label}
              aria-pressed={color === swatch.value}
              onClick={() => onPick(swatch.value)}
              style={{ background: swatch.value }}
              className={cn(
                'size-5 rounded-full border-2',
                color === swatch.value ? 'border-text' : 'border-transparent'
              )}
            />
          ))}
        </Fragment>
      ))}
    </div>
  )
}

/**
 * The per-account "Share ~/.claude/skills with this account" switch (issue #643).
 *
 * A managed account's config dir REPLACES `~/.claude/skills` rather than adding to it — that is
 * Claude Code's own `join(CLAUDE_CONFIG_DIR, 'skills')` — so a fresh account shows only the skills
 * nodeterm installed. The isolation is often the point, which is why this is off by default; this
 * is the way back in.
 *
 * The copy says **edits flow both ways** because they do: each system skill is LINKED, not copied,
 * so editing one from inside this account edits the machine's copy. A user who reads "share" as
 * "copy" would find that out by losing work.
 *
 * The switch is DISABLED (never hidden) for a remote account, with the reason — a silently missing
 * control teaches nothing, and an SSH account's skills live on its host, which v1 does not reach.
 */
function SkillSharingRow({
  account,
  onChange
}: {
  account: ClaudeAccount
  /** Resolves to the line to show under the switch, or null for "nothing worth saying". */
  onChange: (enabled: boolean) => Promise<string | null>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const remote = !!account.host
  const on = !!account.shareSystemSkills
  return (
    <div className="pt-1">
      <div className="flex items-center gap-2">
        <Switch
          checked={on}
          disabled={remote || busy}
          ariaLabel={`Share system skills with ${account.label || account.id}`}
          onChange={(v) => {
            setBusy(true)
            setNote(null)
            void onChange(v)
              .then(setNote)
              .catch((e: unknown) => setNote(errorText(e, 'Could not update skill sharing.')))
              .finally(() => setBusy(false))
          }}
        />
        <span
          className="text-[12px] text-muted"
          // The full consequence rides the tooltip; the line below keeps the one fact a user must
          // not miss (an edit changes the machine's own file) visible without a paragraph per row.
          title={
            remote
              ? undefined
              : 'Links this machine’s skills into the account. They are shared, not copied, so an edit from either side changes the same file. Turning this off removes only the links.'
          }
        >
          Share ~/.claude/skills
        </span>
        <span className="text-[11px] text-muted">
          {remote
            ? 'Not available for accounts on an SSH host — their skills live on that machine.'
            : '— linked, not copied: edits change the same files'}
        </span>
      </div>
      {note ? <p className="pt-1 text-[11px] text-[color:var(--warn)]">{note}</p> : null}
    </div>
  )
}

/** Counts nodes bound to an account across every project's SERIALIZED nodes. The active
 *  project's live React Flow edits since the last commit aren't reflected here, so the count
 *  can be slightly stale for the active canvas — acceptable for a confirmation warning. */
function countNodesUsing(accountId: string): number {
  return useProjects
    .getState()
    .projects.reduce(
      (sum, p) => sum + p.nodes.filter((n) => n.accountId === accountId).length,
      0
    )
}

export function AccountsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const accounts = useSettings((s) => s.settings.claudeAccounts)
  const codexAccounts = useSettings((s) => s.settings.codexAccounts)
  const systemLabelSetting = useSettings((s) => s.settings.systemAccountLabel)
  const systemEmail = useSystemAccount((s) => s.email)
  useEffect(() => useSystemAccount.getState().ensure(), [])
  const systemCodexEmail = useSystemCodexAccount((s) => s.email)
  const remoteSystemCodexEmails = useSystemCodexAccount((s) => s.remoteEmails)
  useEffect(() => useSystemCodexAccount.getState().ensure(), [])
  const sshServers = useSshServers((s) => s.servers)
  useEffect(() => {
    void useSshServers.getState().hydrate?.()
  }, [])
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const activeProject = useProjects((s) => s.projects.find((p) => p.id === activeProjectId))
  // Subscribe to live SSH connections so a remote machine's Add / Retry buttons enable and disable
  // as its host connects and disconnects while this panel is open.
  const sshByProject = useSshConn((s) => s.byProject)
  const [versionWarning, setVersionWarning] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<ClaudeAccount | null>(null)
  const [pendingRemoveCodex, setPendingRemoveCodex] = useState<CodexAccount | null>(null)
  /**
   * Which Add button is mid-setup (`addKey(provider, host)`). Minting a REMOTE account is several
   * seconds of real work on the host — mkdir, hook/skill installs or the Codex runtime links, a CLI
   * probe — and until this state existed the button simply sat there, so the click read as
   * "nothing happened" until the login node appeared. One setup at a time, across providers.
   */
  const [adding, setAdding] = useState<string | null>(null)
  const [addErrors, setAddErrors] = useState<Record<string, string>>({})
  const [removeError, setRemoveError] = useState<string | null>(null)
  // "Link existing config dir…": the typed path, the in-flight guard, and the inline error.
  const [linkPath, setLinkPath] = useState('')
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  // A surface whose bridge registers no folder picker (a relay tab, an older server) answers
  // E_UNSUPPORTED once — after that the button is hidden rather than offered and broken. Typing
  // the path still works, which is why Browse is a convenience and never the only way in.
  const [browseUnsupported, setBrowseUnsupported] = useState(false)
  /**
   * Config dirs SEEN running on this core that we have no account for — the one-click Link
   * candidates. A primitive selector so the settings page does not re-render on every hook event
   * of every node just to discover the same list again.
   */
  const detectedDirs = useAgentStatus((s) =>
    // NUL-joined, not newline-joined: a path may legally contain a newline, and splitting one back
    // into two rows would offer the user a dir that does not exist.
    unlinkedConfigDirs(s.byId, accounts).join('\u0000')
  )
  const detected = detectedDirs ? detectedDirs.split('\u0000') : []

  const setAddError = (key: string, message: string | null): void =>
    setAddErrors((errs) => {
      const next = { ...errs }
      if (message) next[key] = message
      else delete next[key]
      return next
    })

  // The open project whose SSH host matches a remote account. Undefined for local accounts, or when
  // no such project is open.
  const projectIdForHost = (host?: string): string | undefined => {
    if (!host) return undefined
    return useProjects.getState().projects.find((p) => p.ssh && sshHostKey(p.ssh.server) === host)?.id
  }

  // A remote account can only be created, logged into or deleted over a CONNECTED matching-host
  // project (live ControlMaster in useSshConn). Undefined ⇒ that host is not reachable right now,
  // and every remote action is disabled — never quietly run against this machine instead.
  const connectedProjectIdForHost = (host?: string): string | undefined => {
    if (!host) return undefined
    return useProjects
      .getState()
      .projects.find((p) => p.ssh && sshHostKey(p.ssh.server) === host && sshByProject[p.id])?.id
  }

  // ── The machines ─────────────────────────────────────────────────────────────────────────────
  // This machine first, then every saved SSH server unioned with the active project's own server
  // (deduped by host key). BOTH providers' accounts partition onto the same list, so a host's
  // Claude and Codex logins always sit in the same panel.
  const remoteTargets = codexRemoteTargets(sshServers, activeProject?.ssh?.server)
  const claudeGroups = groupAccountsByMachine(accounts, remoteTargets)
  const codexGroups = groupAccountsByMachine(codexAccounts, remoteTargets)
  const claudeStrays = strayAccounts(accounts, remoteTargets)
  const codexStrays = strayAccounts(codexAccounts, remoteTargets)
  // A saved server with nothing on it and no connection is a panel of two empty lists and two
  // disabled buttons — noise, once a user has saved a handful of servers. It appears as soon as it
  // is connected (the moment its buttons would work) or holds an account.
  const machines = claudeGroups
    .map((group, i) => ({ ...group, claude: group.accounts, codex: codexGroups[i].accounts }))
    .filter(
      (m) =>
        !m.remote ||
        m.claude.length > 0 ||
        m.codex.length > 0 ||
        !!connectedProjectIdForHost(m.host)
    )
  const hiddenMachines = claudeGroups.length - machines.length

  // Discover the system Codex identity of every CONNECTED remote target, once per host. A host with
  // no live connection is skipped (and never fabricated — its panel simply shows no system email).
  useEffect(() => {
    if (!isActive) return
    for (const [host] of remoteTargets) {
      const projectId = connectedProjectIdForHost(host)
      if (projectId) useSystemCodexAccount.getState().ensureRemote(host, projectId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, remoteTargets.map(([h]) => h).join('|'), sshByProject])

  // Reconcile LOCAL pending Codex accounts against their now-authenticated homes. A remote pending
  // account is resolved by its own login wait (and its Retry), which asks the HOST — the local
  // `identity` read would look in this machine's managed home and misattribute it.
  useEffect(() => {
    if (!isActive) return
    let cancelled = false
    let timer: number | undefined
    const reconcile = async (): Promise<void> => {
      const localPending = useSettings
        .getState()
        .settings.codexAccounts.filter((account) => account.pending && !account.host)
      if (localPending.length === 0) return
      const resolved = await discoverResolvedCodexAccounts(localPending, (id) =>
        window.nodeTerminal.codexAccounts.identity(id)
      )
      if (cancelled) return
      if (resolved.length > 0) {
        applyCodexAccounts((accs) => applyResolvedCodexAccounts(accs, resolved))
      }
      const stillPending = useSettings
        .getState()
        .settings.codexAccounts.some((account) => account.pending && !account.host)
      if (!cancelled && stillPending) timer = window.setTimeout(() => void reconcile(), 2000)
    }
    void reconcile()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [isActive, codexAccounts])

  // ── Claude ───────────────────────────────────────────────────────────────────────────────────
  const setLabel = (id: string, label: string): void =>
    applyAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, label } : a)))

  const setColor = (id: string, color?: string): void =>
    applyAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, color } : a)))

  /**
   * Flip `~/.claude/skills` sharing for one account (issue #643). The FILESYSTEM is reconciled
   * first and the flag is persisted only if that call came back — because the flag is what the
   * launch sweep replays, and a stored `true` whose links were never made would make the switch
   * lie until the next boot. A REFUSAL is likewise not a state to store: nothing happened, so the
   * switch stays where it was and the note says why.
   */
  const setSkillSharing = async (id: string, enabled: boolean): Promise<string | null> => {
    let res: ClaudeSkillShareResult
    try {
      res = await window.nodeTerminal.claudeAccounts.setSkillSharing(id, enabled)
    } catch (e) {
      if (isUnsupported(e)) return 'Sharing skills is not available on this connection.'
      throw e
    }
    if (!res.refused) {
      applyAccounts((accs) =>
        accs.map((a) => (a.id === id ? { ...a, shareSystemSkills: enabled } : a))
      )
    }
    return skillShareNote(res, enabled)
  }

  // Open a login terminal for an account and wait (up to ~5 min) for the CLI to write its
  // credentials; on success flip the row out of `pending` and adopt the captured email. A remote
  // account (`host` set) logs in on its host: the login node runs in remote tmux and waitLogin polls
  // the remote `.claude.json` over ssh (via the ctx `projectId`).
  const runLogin = async (account: Pick<ClaudeAccount, 'id' | 'host'>): Promise<void> => {
    const remote = !!account.host
    const projectId = remote ? connectedProjectIdForHost(account.host) : undefined
    // Carry `host` so Canvas resolves the ssh binding BY HOST (among connected projects), not from
    // whatever project happens to be active when Retry fires.
    window.dispatchEvent(
      new CustomEvent('nodeterm:add-account-login', {
        detail: { accountId: account.id, remote, host: account.host }
      })
    )
    const captured = await window.nodeTerminal.claudeAccounts.waitLogin(
      account.id,
      projectId ? { projectId } : undefined
    )
    if (!captured) return // timeout / cancel: row stays pending, offers Retry
    applyAccounts((accs) =>
      accs.map((a) =>
        a.id === account.id
          ? {
              ...a,
              label: a.label === 'New account' ? captured.email : a.label,
              email: captured.email,
              pending: false
            }
          : a
      )
    )
  }

  // `host` set → create the account dir + hook ON that SSH host (via the ctx projectId); the row
  // then lives in that host's panel and is only offered in that host's projects.
  const onAddClaude = async (host?: string): Promise<void> => {
    if (adding) return // one setup at a time — the buttons are disabled, this is the guard
    const key = addKey('claude', host ?? '')
    const projectId = host ? connectedProjectIdForHost(host) : undefined
    if (host && !projectId) return
    setAdding(key)
    setAddError(key, null)
    let added: { id: string; versionSupported: boolean }
    try {
      added = await window.nodeTerminal.claudeAccounts.add(projectId ? { projectId } : undefined)
    } catch (e) {
      // The remote path does not reject on a failed setup (it answers with an empty configDir and
      // lets the login node report the connection error), so reaching here means the call itself
      // never landed. E_UNSUPPORTED is its own sentence: a fact about the surface, not the account.
      setAddError(
        key,
        isUnsupported(e)
          ? 'Managed Claude accounts are not available on this surface — manage them from the desktop app or the Server Edition directly.'
          : host
            ? `Could not set up an account on ${host}. Is the project still connected?`
            : 'Could not set up the account.'
      )
      return
    } finally {
      // Cleared before the login wait below: `runLogin` resolves only when the user finishes
      // logging in (up to 5 minutes), and a spinner running that long would claim the setup is
      // still going when the thing to do next is on the canvas.
      setAdding(null)
    }
    // Non-blocking: the account still isolates config, but an old CLI's unscoped macOS keychain
    // service would collide across accounts — surface a dismissable warning.
    if (!added.versionSupported) setVersionWarning(true)
    const account: ClaudeAccount = {
      id: added.id,
      label: 'New account',
      pending: true,
      createdAt: Date.now(),
      ...(host ? { host } : {})
    }
    applyAccounts((accs) => [...accs, account])
    await runLogin(account)
  }

  /**
   * Adopt a config dir the user already owns (`~/.claude-2` and friends) as a real account: core
   * validates the path, reads its `.claude.json` for the signed-in email, and installs the managed
   * status hook into it. From then on the dir has an id, so env injection, the transcript jail, the
   * usage rows, the pickers and the node chip all treat it like any other account.
   *
   * `~` is expanded by CORE, not here: the renderer does not know the home dir of the machine that
   * owns the files (the Server Edition's browser is not the filesystem's host).
   */
  const onLink = async (dir: string): Promise<void> => {
    const path = dir.trim()
    if (!path || linking) return
    setLinking(true)
    setLinkError(null)
    try {
      const linked = await window.nodeTerminal.claudeAccounts.link(path)
      applyAccounts((accs) => [
        ...accs,
        {
          id: linked.id,
          // Named by its login when the dir is signed in; otherwise by the folder, which is how
          // the user thinks of it anyway ("the .claude-2 one"). Never a generated placeholder.
          label: linked.email ?? configDirLabel(linked.configDir),
          ...(linked.email ? { email: linked.email } : {}),
          // The NORMALIZED path core resolved, never the raw text typed here: it is re-validated
          // at every point of use, and the two must be the same string for the jail to match.
          configDir: linked.configDir,
          createdAt: Date.now()
        }
      ])
      setLinkPath('')
    } catch (e) {
      setLinkError(
        isUnsupported(e)
          ? 'Linking a config dir is not available on this surface — do it from the desktop app or the Server Edition directly.'
          : errorText(e, 'Could not link that config dir.')
      )
    } finally {
      setLinking(false)
    }
  }

  const onBrowse = async (): Promise<void> => {
    try {
      const folder = await window.nodeTerminal.dialog.selectFolder()
      if (folder) setLinkPath(folder)
    } catch (e) {
      if (isUnsupported(e)) setBrowseUnsupported(true)
      else setLinkError(errorText(e, 'Could not open the folder picker.'))
    }
  }

  const confirmRemove = async (account: ClaudeAccount): Promise<void> => {
    setPendingRemove(null)
    setRemoveError(null)
    try {
      // Removing a pending account: stop the 5-minute waitLogin poll loop first.
      if (account.pending) await window.nodeTerminal.claudeAccounts.cancelWaitLogin(account.id)
      if (account.host) {
        // A remote account's dir is deleted ON its host, over a live connection. Without one there
        // is nothing to reach — the record is forgotten and the dir stays (the dialog said so). A
        // remote id must never reach the LOCAL remove, which would `rm -rf` this machine's copy.
        const projectId = connectedProjectIdForHost(account.host)
        if (projectId) await window.nodeTerminal.claudeAccounts.remove(account.id, { projectId })
      } else {
        await window.nodeTerminal.claudeAccounts.remove(account.id)
      }
    } catch (e) {
      setRemoveError(errorText(e, `Could not remove "${account.label}".`))
      return
    }
    applyAccounts((accs) => accs.filter((a) => a.id !== account.id))
    // Clear the account off serialized nodes (all projects) + any project default...
    useProjects.setState((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        ...(p.defaultAccountId === account.id ? { defaultAccountId: undefined } : {}),
        // The account's serialized login node is DROPPED, not kept account-less: respawned
        // without its env, its `claude /login` would run against the system ~/.claude and
        // overwrite the user's identity on completion. Other nodes just lose the accountId.
        nodes: p.nodes
          .filter((n) => !(n.accountId === account.id && isAccountLoginNode(n)))
          .map((n) => (n.accountId === account.id ? { ...n, accountId: undefined } : n))
      }))
    }))
    // ...and off the active project's LIVE nodes (Canvas listener patches React Flow).
    window.dispatchEvent(
      new CustomEvent('nodeterm:account-removed', { detail: { accountId: account.id } })
    )
  }

  const removeMessage = (a: ClaudeAccount): string => {
    const n = countNodesUsing(a.id)
    const fallout = `${n} node(s) currently use it and will fall back to the system account.`
    // A LINKED dir is the user's own folder — removing the account forgets the record and deletes
    // NOTHING (core refuses to `rm -rf` anything outside its own managed dirs). Saying "will be
    // deleted" here would be a lie that stops people unlinking.
    if (a.configDir) {
      return `Unlink account "${a.label}"? nodeterm forgets it — the folder ${a.configDir} keeps its login and transcripts exactly as they are. ${fallout}`
    }
    if (a.host && !connectedProjectIdForHost(a.host)) {
      return `Remove account "${a.label}"? ${a.host} is not connected, so nodeterm only forgets it — its login and transcripts stay on that host. ${fallout}`
    }
    return `Remove account "${a.label}"? Its logged-in credentials and all its Claude transcripts${
      a.host ? ` on ${a.host}` : ''
    } will be deleted. ${fallout}`
  }

  // ── Codex ────────────────────────────────────────────────────────────────────────────────────
  const setCodexLabel = (id: string, label: string): void =>
    applyCodexAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, label } : a)))

  const setCodexColor = (id: string, color?: string): void =>
    applyCodexAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, color } : a)))

  /** Open the account's `codex login` node (on its host for a remote one) and wait for the device
   *  login to land; on success the row leaves `pending` with the captured email. */
  const runCodexLogin = async (account: Pick<CodexAccount, 'id' | 'host'>): Promise<void> => {
    const remote = !!account.host
    const projectId = remote ? connectedProjectIdForHost(account.host) : undefined
    if (remote && !projectId) return
    window.dispatchEvent(
      new CustomEvent('nodeterm:add-codex-account-login', {
        detail: remote ? { accountId: account.id, remote, host: account.host } : { accountId: account.id }
      })
    )
    const captured = projectId
      ? await window.nodeTerminal.codexAccounts.waitLogin(account.id, { projectId })
      : await window.nodeTerminal.codexAccounts.waitLogin(account.id)
    if (captured) {
      applyCodexAccounts((accs) =>
        applyResolvedCodexAccounts(accs, [{ id: account.id, email: captured.email }])
      )
    }
  }

  // Add a managed Codex account on this machine or, with `host`, ON that connected SSH host: its
  // private CODEX_HOME is created there and the device login runs there, so the credential is
  // written on the machine that uses it and never travels.
  const onAddCodex = async (host?: string): Promise<void> => {
    if (adding) return
    const key = addKey('codex', host ?? '')
    const projectId = host ? connectedProjectIdForHost(host) : undefined
    if (host && !projectId) return
    setAdding(key)
    setAddError(key, null)
    let accountId: string
    try {
      const added = projectId
        ? await window.nodeTerminal.codexAccounts.add({ projectId })
        : await window.nodeTerminal.codexAccounts.add()
      accountId = added.id
      const account: CodexAccount = {
        id: added.id,
        label: 'New Codex account',
        pending: true,
        ...(host ? { host } : {})
      }
      applyCodexAccounts((accs) => [...accs, account])
      // PTY scoping identifies this agent-less login by the core's account list. The ordinary
      // settings save is coalesced for 300 ms; launching before it lands uses the system home.
      await useSettings.getState().flush()
    } catch (e) {
      // Without this the browser's E_UNSUPPORTED rejection was an UNHANDLED promise rejection: the
      // spinner stopped and nothing else happened, which reads as a dead button.
      setAddError(
        key,
        isUnsupported(e)
          ? 'Managed Codex accounts are not available in the browser yet — manage them from the desktop app.'
          : host
            ? errorText(e, `Could not set up a Codex account on ${host}.`)
            : 'Could not set up the Codex account.'
      )
      return
    } finally {
      setAdding(null)
    }
    await runCodexLogin({ id: accountId, host })
  }

  const confirmRemoveCodex = async (account: CodexAccount): Promise<void> => {
    setPendingRemoveCodex(null)
    setRemoveError(null)
    try {
      if (account.pending) await window.nodeTerminal.codexAccounts.cancelWaitLogin(account.id)
      if (account.host) {
        // Deleted ON its host over a live connection; without one the record is only forgotten
        // (the dialog said so). Never the local remove — it acts on this machine's homes.
        const projectId = connectedProjectIdForHost(account.host)
        if (projectId) await window.nodeTerminal.codexAccounts.remove(account.id, { projectId })
      } else {
        await window.nodeTerminal.codexAccounts.remove(account.id)
      }
    } catch (e) {
      // Local removal refuses while an account switch holds the account — say so, keep the row.
      setRemoveError(errorText(e, `Could not remove "${account.label}".`))
      return
    }
    applyCodexAccounts((accs) => accs.filter((a) => a.id !== account.id))
    useProjects.setState((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        nodes: p.nodes.map((n) => (n.accountId === account.id ? { ...n, accountId: undefined } : n))
      }))
    }))
  }

  const removeCodexMessage = (a: CodexAccount): string => {
    if (a.host && !connectedProjectIdForHost(a.host)) {
      return `Remove Codex account "${a.label}"? ${a.host} is not connected, so nodeterm only forgets it — its login and Codex home stay on that host.`
    }
    return `Remove Codex account "${a.label}"? Its logged-in credentials and its Codex home${
      a.host ? ` on ${a.host}` : ''
    } will be deleted.`
  }

  // ── Rows ─────────────────────────────────────────────────────────────────────────────────────
  const machineLabelFor = (host?: string): string | undefined =>
    host ? sshServers.find((entry) => sshHostKey(entry) === host)?.label : undefined

  /** The Retry-login button both providers show on a pending row; a remote one needs its host. */
  const retryButton = (host: string | undefined, onRetry: () => void): React.JSX.Element => {
    const blocked = !!host && !connectedProjectIdForHost(host)
    return (
      <Button
        disabled={blocked}
        title={blocked ? `Connect to ${host} to finish logging in` : undefined}
        onClick={onRetry}
      >
        Retry login
      </Button>
    )
  }

  const claudeRow = (account: ClaudeAccount, showHost: boolean): React.JSX.Element => {
    const presented = presentAccount({
      label: account.label,
      email: account.email,
      host: account.host,
      machineLabel: machineLabelFor(account.host),
      linked: !!account.configDir,
      configDir: account.configDir
    })
    return (
      <ManagedAccountRow
        key={account.id}
        label={account.label}
        placeholder="Account label"
        onLabel={(v) => setLabel(account.id, v)}
        pending={account.pending}
        email={account.email}
        color={account.color}
        onColor={(c) => setColor(account.id, c)}
        pills={
          <>
            {/* A LINKED account: the user's own dir, adopted rather than minted. The path is the
                identifying fact, so it rides the tooltip — through `presentAccount`, so this row
                says the same thing every other account surface would. */}
            {account.configDir ? (
              <span
                className="rounded-full bg-fill-weak px-2 py-0.5 text-[11px] font-medium text-muted"
                title={presented.tooltip}
              >
                {presented.provenance}
              </span>
            ) : null}
            {showHost && account.host ? (
              <span
                className="rounded-full bg-[color:var(--accent)]/15 px-2 py-0.5 text-[11px] font-medium text-[color:var(--accent)]"
                title={`Remote account on ${account.host}`}
              >
                {account.host}
              </span>
            ) : null}
          </>
        }
        extra={
          <SkillSharingRow account={account} onChange={(v) => setSkillSharing(account.id, v)} />
        }
        actions={
          <>
            {account.pending ? retryButton(account.host, () => void runLogin(account)) : null}
            <Button
              variant="ghost"
              // "Unlink" for a linked dir: the action really is different (the folder stays), and
              // the label is what a screen reader and the tests both go by.
              aria-label={account.configDir ? 'Unlink account' : 'Remove account'}
              onClick={() => setPendingRemove(account)}
            >
              <IconClose />
            </Button>
          </>
        }
      />
    )
  }

  const codexRow = (account: CodexAccount, showHost: boolean): React.JSX.Element => {
    // The SAME fail-closed gate the create/switch UI uses (§5 Property 4): an account that is
    // unsafe, missing, or a remote account with no live connection is not operable.
    const selectable = codexAccountSelectable(account.id, codexAccounts, (host) =>
      connectedProjectIdForHost(host)
    )
    const blockedReason = selectable.ok
      ? undefined
      : selectable.reason === 'no-connection'
        ? `Connect to ${account.host} to use this account`
        : 'This account is unavailable'
    return (
      <ManagedAccountRow
        key={account.id}
        label={account.label}
        placeholder="Codex account label"
        onLabel={(v) => setCodexLabel(account.id, v)}
        pending={account.pending}
        email={account.email}
        color={account.color}
        onColor={(c) => setCodexColor(account.id, c)}
        blockedReason={account.pending ? undefined : blockedReason}
        pills={
          showHost && account.host ? (
            <span
              className="rounded-full bg-[color:var(--accent)]/15 px-2 py-0.5 text-[11px] font-medium text-[color:var(--accent)]"
              title={`Remote account on ${account.host}`}
            >
              {account.host}
            </span>
          ) : null
        }
        actions={
          <>
            {account.pending ? retryButton(account.host, () => void runCodexLogin(account)) : null}
            <Button
              variant="ghost"
              aria-label="Remove Codex account"
              onClick={() => setPendingRemoveCodex(account)}
            >
              <IconClose />
            </Button>
          </>
        }
      />
    )
  }

  /** A provider's Add button on one machine: local always, remote only over a live connection. */
  const addButton = (provider: Provider, host: string): React.JSX.Element => {
    const key = addKey(provider, host)
    const where = host || thisMachine()
    const reachable = !host || !!connectedProjectIdForHost(host)
    const text = provider === 'claude' ? 'Add Claude account' : 'Add Codex account'
    return (
      <Button
        variant="primary"
        disabled={adding !== null || !reachable}
        title={reachable ? undefined : `Connect to ${host} to add an account there`}
        onClick={() =>
          void (provider === 'claude' ? onAddClaude(host || undefined) : onAddCodex(host || undefined))
        }
      >
        {adding === key ? (
          <span className="inline-flex items-center gap-2">
            <span className="ui-spinner" aria-hidden />
            Setting up on {where}…
          </span>
        ) : (
          text
        )}
      </Button>
    )
  }

  /** What the spinner is waiting for — a remote setup takes long enough that silence reads as a
   *  broken button. */
  const progressFor = (provider: Provider, host: string): string | null => {
    if (adding !== addKey(provider, host)) return null
    if (!host) return 'Creating the account directory and installing the status hook…'
    return provider === 'claude'
      ? `Creating the config dir on ${host} and installing the status hook and agent skills over SSH — this takes a few seconds. The login terminal opens when it's ready.`
      : `Creating the Codex home on ${host} over SSH — the login terminal opens when it's ready.`
  }

  const linkExisting = (
    // LINK an existing config dir. The other half of "several Claude logins": a user who already
    // keeps `~/.claude-2` and drives it from their own shell function does not want a new managed
    // dir — they want THIS one to have an id. Local only: a linked dir is a path on the machine that
    // owns the files. Folded away by default: it is the rarer way in, and the Add button is the
    // common one.
    <details className="rounded-md border border-border/60 p-2" open={!!linkPath || !!linkError}>
      <summary className="cursor-pointer text-[12px] font-medium text-text">
        Link an existing config dir…
      </summary>
      <div className="space-y-2 pt-2">
        <p className="text-[12px] leading-relaxed text-muted">
          Already have a second login in its own folder (say <code>~/.claude-2</code>)? Link it and
          nodeterm will label its terminals, read its transcripts, and offer it in the add menus.
          Nothing is copied or moved, and unlinking later leaves the folder alone.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-72"
            placeholder="~/.claude-2"
            value={linkPath}
            onChange={(e) => setLinkPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onLink(linkPath)
            }}
          />
          {browseUnsupported ? null : (
            <Button disabled={linking} onClick={() => void onBrowse()}>
              Browse…
            </Button>
          )}
          <Button
            variant="primary"
            // Named: the detected list repeats the word "Link" once per row, and a bare label
            // leaves both the user's screen reader and the tests guessing which.
            aria-label="Link config dir"
            disabled={linking || !linkPath.trim()}
            onClick={() => void onLink(linkPath)}
          >
            {linking ? (
              <span className="inline-flex items-center gap-2">
                <span className="ui-spinner" aria-hidden />
                Linking…
              </span>
            ) : (
              'Link'
            )}
          </Button>
        </div>
        {linkError ? <p className="text-[12px] text-[color:var(--danger)]">{linkError}</p> : null}
      </div>
    </details>
  )

  // DETECTED dirs: config dirs whose sessions actually posted hooks here and that we have no
  // account for. Derived from observations only — nothing on disk is read for an unlinked dir (a
  // forged POST must not make us stat anything), so the path is all that is shown. Shown OUTSIDE
  // the fold: it is a suggestion about a login the user is demonstrably using.
  const detectedBlock =
    detected.length > 0 ? (
      <div className="space-y-2 rounded-md border border-dashed border-border/60 p-2">
        <div className="text-[12px] font-medium text-text">Detected config dirs</div>
        {detected.map((dir) => (
          <div key={dir} className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={dir}>
              {dir}
            </span>
            <Button aria-label={`Link ${dir}`} disabled={linking} onClick={() => void onLink(dir)}>
              Link
            </Button>
          </div>
        ))}
      </div>
    ) : null

  return (
    <SettingsSection
      id="accounts"
      title="Accounts"
      description="Separate Claude and Codex logins, grouped by the machine they live on. Each account has its own login, settings and history; pick one when you open an agent, or move a running node to another from its right-click menu."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.accounts}>
        <div className="space-y-4">
          {versionWarning ? (
            <div className="flex items-start justify-between gap-3 rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-3 py-2 text-[13px] leading-relaxed text-[color:var(--danger)]">
              <span>
                Your installed Claude CLI is older than the version that scopes credentials per
                config dir. Accounts still isolate their config, but on macOS logins may collide in
                the shared keychain. Update the Claude CLI to keep them fully separate.
              </span>
              <button
                className="shrink-0 cursor-pointer text-muted hover:text-text"
                onClick={() => setVersionWarning(false)}
              >
                Dismiss
              </button>
            </div>
          ) : null}
          {removeError ? (
            <p className="text-[12px] text-[color:var(--danger)]">{removeError}</p>
          ) : null}

          {machines.map((m) => {
            const host = m.host // '' = this machine
            const connected = !m.remote || !!connectedProjectIdForHost(host)
            const codexSystemEmail = m.remote ? (remoteSystemCodexEmails[host] ?? null) : systemCodexEmail
            return (
              <MachinePanel
                key={host || 'local'}
                label={m.remote ? (m.server?.label ?? host) : thisMachineCap()}
                remote={m.remote}
                hostKey={host || undefined}
                connected={connected}
              >
                <ProviderBlock
                  agentId="claude"
                  title="Claude"
                  action={addButton('claude', host)}
                  progress={progressFor('claude', host)}
                  error={addErrors[addKey('claude', host)]}
                >
                  <SystemAccountRow
                    name={
                      m.remote ? (
                        <span className="text-[13px] text-text">System account</span>
                      ) : (
                        // The local SYSTEM account is implicit (no ClaudeAccount record) but gets
                        // a renamable display label (empty = default) so pickers tell it apart.
                        <Input
                          className="w-56"
                          placeholder="System account"
                          value={systemLabelSetting}
                          onChange={(e) =>
                            useSettings.getState().update({ systemAccountLabel: e.target.value })
                          }
                        />
                      )
                    }
                    detail={m.remote ? `~/.claude on ${host}` : systemEmail}
                  />
                  {m.claude.map((a) => claudeRow(a, false))}
                  {!m.remote ? (
                    <>
                      {detectedBlock}
                      {linkExisting}
                    </>
                  ) : null}
                </ProviderBlock>
                <div className="border-t border-border/60" aria-hidden />
                <ProviderBlock
                  agentId="codex"
                  title="Codex"
                  action={addButton('codex', host)}
                  progress={progressFor('codex', host)}
                  error={addErrors[addKey('codex', host)]}
                >
                  <SystemAccountRow
                    name={<span className="text-[13px] text-text">System account</span>}
                    detail={codexSystemEmail ?? (m.remote ? `~/.codex on ${host}` : '~/.codex')}
                  />
                  {m.codex.map((a) => codexRow(a, false))}
                </ProviderBlock>
              </MachinePanel>
            )
          })}

          {claudeStrays.length + codexStrays.length > 0 ? (
            <div className="space-y-2 rounded-md border border-[color:var(--warn)]/40 p-3">
              <p className="text-[12px] font-medium text-[color:var(--warn)]">
                Accounts on machines you no longer have saved
              </p>
              {claudeStrays.map((a) => claudeRow(a, true))}
              {codexStrays.map((a) => codexRow(a, true))}
            </div>
          ) : null}

          <p className="text-[12px] leading-relaxed text-muted">
            An account on an SSH host is created, logged into and removed ON that host — its
            credentials never leave it — and is only offered in that host&apos;s projects.
            {hiddenMachines > 0
              ? ` ${hiddenMachines} saved SSH ${hiddenMachines === 1 ? 'server has' : 'servers have'} no accounts yet and ${hiddenMachines === 1 ? 'appears' : 'appear'} here once connected.`
              : ''}{' '}
            A node color applies to nodes opened under that account from then on.
          </p>
        </div>
      </SearchableRow>

      {pendingRemove ? (
        <ConfirmDialog
          message={removeMessage(pendingRemove)}
          confirmLabel={pendingRemove.configDir ? 'Unlink' : 'Remove'}
          onConfirm={() => void confirmRemove(pendingRemove)}
          onCancel={() => setPendingRemove(null)}
        />
      ) : null}
      {pendingRemoveCodex ? (
        <ConfirmDialog
          message={removeCodexMessage(pendingRemoveCodex)}
          confirmLabel="Remove"
          onConfirm={() => void confirmRemoveCodex(pendingRemoveCodex)}
          onCancel={() => setPendingRemoveCodex(null)}
        />
      ) : null}
    </SettingsSection>
  )
}
