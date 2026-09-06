import { useEffect, useState } from 'react'
import type { ClaudeAccount } from '@shared/types'
import type { CodexAccount } from '@shared/codex-account'
import { E_UNSUPPORTED } from '@shared/rpc'
import { sshHostKey } from '@shared/ssh'
import { useSettings } from '../../../state/settings'
import { useSystemAccount } from '../../../state/systemAccount'
import { useSystemCodexAccount } from '../../../state/systemCodexAccount'
import { isAccountLoginNode, NODE_COLORS } from '../../../state/workspace'
import { useProjects } from '../../../state/projects'
import { useSshConn } from '../../../state/sshConn'
import { useSshServers } from '../../../state/sshServers'
import {
  applyResolvedCodexAccounts,
  discoverResolvedCodexAccounts
} from '../../../state/codexAccountReconcile'
import {
  codexRemoteTargets,
  groupCodexAccountsByMachine,
  strayCodexAccounts
} from '../../../lib/codexMachineGroups'
import { presentAccount } from '../../../lib/accountPresentation'
import { codexAccountSelectable } from '../../../canvas/codex-account-switch'
import { AccountIdentityPills } from '../../AccountIdentityPills'
import { ConfirmDialog } from '../../ConfirmDialog'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { cn } from '@renderer/ui/cn'

const ROWS = {
  accounts: {
    title: 'Claude accounts',
    keywords: ['account', 'claude', 'login', 'isolated', 'multi', 'email']
  },
  codex: {
    title: 'Codex accounts',
    keywords: ['account', 'codex', 'openai', 'login', 'isolated', 'multi', 'email', 'machine', 'ssh']
  }
}
const ENTRIES = Object.values(ROWS)

/** The bridge's "this shell registers no such handler" rejection (renderer/bridge/stubs.ts). It is
 *  a fact about the SURFACE, not about this account — worth a different sentence than a failure. */
const isUnsupported = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { code?: string }).code === E_UNSUPPORTED

/** One machine's card in the accounts UI: a connectivity dot, the machine label, a Local/SSH pill,
 *  and (for a remote machine) its `user@host` subtitle. Children are the provider account rows. */
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
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
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
        {remote && hostKey ? <span className="text-[12px] text-muted">{hostKey}</span> : null}
      </div>
      {children}
    </div>
  )
}

/** `addingOn` sentinel for the local button — a host key can never be this. */
const LOCAL_TARGET = ''

/** Spinner + label for an Add button that is mid-setup. */
function AddingLabel({ where }: { where: string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="ui-spinner" aria-hidden />
      Setting up on {where}…
    </span>
  )
}

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
      {NODE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          // "<what> <hex>", the convention the Appearance accent picker set — a bare hex is not a
          // name a screen reader can do anything with.
          aria-label={`Node color ${c}`}
          aria-pressed={color === c}
          onClick={() => onPick(c)}
          style={{ background: c }}
          className={cn(
            'size-5 rounded-full border-2',
            color === c ? 'border-text' : 'border-transparent'
          )}
        />
      ))}
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
  const systemLabelSetting = useSettings((s) => s.settings.systemAccountLabel)
  const systemEmail = useSystemAccount((s) => s.email)
  useEffect(() => useSystemAccount.getState().ensure(), [])
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const activeProject = useProjects((s) => s.projects.find((p) => p.id === activeProjectId))
  // The active project's SSH host key (`user@host`), when it's a connected SSH project. Present →
  // the "Add account" control also offers adding an account ON that host.
  const activeHostKey = activeProject?.ssh ? sshHostKey(activeProject.ssh.server) : undefined
  // Subscribe to live SSH connections so a remote account's Retry button enables/disables as its
  // host connects/disconnects while this panel is open.
  const sshByProject = useSshConn((s) => s.byProject)
  const [versionWarning, setVersionWarning] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<ClaudeAccount | null>(null)
  /**
   * Which "Add account" button is mid-setup: the host key, or LOCAL_TARGET for this machine.
   * Minting a REMOTE account is 10–15 s of real work on the host — mkdir, merging the status hook
   * into the account dir's settings.json, installing the canvas-control + context-link skills, and
   * a `claude --version` through a login shell — and until this state existed the button simply
   * sat there, so the click read as "nothing happened" until the login node appeared.
   */
  const [addingOn, setAddingOn] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)

  const setLabel = (id: string, label: string): void =>
    applyAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, label } : a)))

  const setColor = (id: string, color?: string): void =>
    applyAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, color } : a)))

  // The open project whose SSH host matches a remote account (needed for the ssh context of
  // waitLogin / remove). Undefined for local accounts, or when no such project is open.
  const projectIdForHost = (host?: string): string | undefined => {
    if (!host) return undefined
    return useProjects.getState().projects.find((p) => p.ssh && sshHostKey(p.ssh.server) === host)?.id
  }

  // A remote account can only log in on a CONNECTED matching-host project (live ControlMaster in
  // useSshConn). Undefined when the account is remote but no such project is currently connected —
  // Retry is then disabled so `claude /login` never runs against the local system account.
  const connectedProjectIdForHost = (host?: string): string | undefined => {
    const id = projectIdForHost(host)
    return id && sshByProject[id] ? id : undefined
  }

  // ── Codex accounts (machine-grouped) ─────────────────────────────────────────────────────────
  const codexAccounts = useSettings((s) => s.settings.codexAccounts)
  const sshServers = useSshServers((s) => s.servers)
  const systemCodexEmail = useSystemCodexAccount((s) => s.email)
  const remoteSystemCodexEmails = useSystemCodexAccount((s) => s.remoteEmails)
  useEffect(() => useSystemCodexAccount.getState().ensure(), [])
  useEffect(() => {
    void useSshServers.getState().hydrate?.()
  }, [])
  const [pendingRemoveCodex, setPendingRemoveCodex] = useState<CodexAccount | null>(null)
  const [addingCodex, setAddingCodex] = useState(false)
  const [codexAddError, setCodexAddError] = useState<string | null>(null)

  // The reachable machines: this Mac first, then every saved SSH server unioned with the active
  // project's own server (deduped by host key). Accounts partition onto them by `host`.
  const remoteTargets = codexRemoteTargets(sshServers, activeProject?.ssh?.server)
  const codexGroups = groupCodexAccountsByMachine(codexAccounts, remoteTargets)
  const codexStrays = strayCodexAccounts(codexAccounts, remoteTargets)

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

  // Reconcile LOCAL pending Codex accounts against their now-authenticated homes. Remote accounts
  // are intentionally NOT probed here: `codexAccounts.identity` reads the LOCAL managed home, so
  // resolving a remote account against it would read the wrong machine. Their reconcile arrives
  // with the host relay (a follow-up); until then a remote row stays pending, not misattributed.
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

  const setCodexLabel = (id: string, label: string): void =>
    applyCodexAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, label } : a)))

  const setCodexColor = (id: string, color?: string): void =>
    applyCodexAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, color } : a)))

  // Add a LOCAL managed Codex account and open its device-login node. Remote Codex account creation
  // is fail-closed here: the base `codexAccounts.add()` mints on THIS Mac, so offering it under a
  // remote machine would silently create a local account — the remote leg lands with the host relay.
  const onAddCodexAccount = async (): Promise<void> => {
    if (addingCodex) return
    setAddingCodex(true)
    setCodexAddError(null)
    try {
      const added = await window.nodeTerminal.codexAccounts.add()
      const account: CodexAccount = { id: added.id, label: 'New Codex account', pending: true }
      applyCodexAccounts((accs) => [...accs, account])
      window.dispatchEvent(
        new CustomEvent('nodeterm:add-codex-account-login', { detail: { accountId: added.id } })
      )
      const captured = await window.nodeTerminal.codexAccounts.waitLogin(added.id)
      if (captured) {
        applyCodexAccounts((accs) =>
          applyResolvedCodexAccounts(accs, [{ id: added.id, email: captured.email }])
        )
      }
    } catch (e) {
      // Without this the browser's E_UNSUPPORTED rejection was an UNHANDLED promise rejection: the
      // spinner stopped and nothing else happened, which reads as a dead button. Managed Claude
      // accounts now work in the browser, so a user who just added one has every reason to expect
      // the button beneath it to work too — say why it does not.
      setCodexAddError(
        isUnsupported(e)
          ? 'Managed Codex accounts are not available in the browser yet — manage them from the desktop app.'
          : 'Could not set up the Codex account.'
      )
    } finally {
      setAddingCodex(false)
    }
  }

  const confirmRemoveCodex = async (account: CodexAccount): Promise<void> => {
    setPendingRemoveCodex(null)
    if (account.pending) await window.nodeTerminal.codexAccounts.cancelWaitLogin(account.id)
    // A remote account's home lives on its host; the base remove() acts locally only, so a remote
    // account is dropped from settings without a local fs op it does not own (fail-closed — it never
    // deletes the wrong machine's home).
    if (!account.host) await window.nodeTerminal.codexAccounts.remove(account.id)
    applyCodexAccounts((accs) => accs.filter((a) => a.id !== account.id))
    useProjects.setState((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        nodes: p.nodes.map((n) => (n.accountId === account.id ? { ...n, accountId: undefined } : n))
      }))
    }))
  }

  // The presented account for a row, resolving the friendly machine label from saved servers.
  const presentCodex = (account: CodexAccount) => {
    const server = account.host
      ? sshServers.find((entry) => sshHostKey(entry) === account.host)
      : undefined
    return presentAccount({
      label: account.label,
      email: account.email,
      host: account.host,
      machineLabel: server?.label
    })
  }

  /** A machine's managed-account rows + the system row header. `remoteHost` set ⇒ that host. */
  const codexRowsFor = (
    accounts: readonly CodexAccount[],
    remoteHost?: string
  ): React.JSX.Element => {
    const systemEmail = remoteHost ? (remoteSystemCodexEmails[remoteHost] ?? null) : systemCodexEmail
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-2">
          <AccountIdentityPills
            account={presentAccount({
              label: null,
              email: systemEmail,
              host: remoteHost,
              machineLabel: remoteHost
                ? sshServers.find((s) => sshHostKey(s) === remoteHost)?.label
                : undefined
            })}
          />
        </div>
        {accounts.map((account) => {
          // The SAME fail-closed gate the create/switch UI uses (§5 Property 4): an account that is
          // unsafe, missing, or a remote account with no live connection is not operable. Driving
          // the row's warning state through it (rather than an ad-hoc host check) makes
          // `codexAccountSelectable` a real reader and keeps one definition of "operable".
          const selectable = codexAccountSelectable(account.id, codexAccounts, (host) =>
            connectedProjectIdForHost(host)
          )
          const blockedReason = selectable.ok
            ? undefined
            : selectable.reason === 'no-connection'
              ? `Connect to ${account.host} to use this account`
              : 'This account is unavailable'
          return (
            <div
              key={account.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-2"
              title={blockedReason}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <Input
                    className="w-48"
                    placeholder="Codex account label"
                    value={account.label}
                    onChange={(e) => setCodexLabel(account.id, e.target.value)}
                  />
                  <AccountIdentityPills account={presentCodex(account)} warning={!selectable.ok} />
                  {account.pending ? (
                    <span className="rounded-full bg-[color:var(--warn)]/15 px-2 py-0.5 text-[11px] font-medium text-[color:var(--warn)]">
                      pending
                    </span>
                  ) : null}
                </div>
                <AccountColorSwatches
                  label={account.label}
                  color={account.color}
                  onPick={(c) => setCodexColor(account.id, c)}
                />
              </div>
              <Button
                variant="ghost"
                aria-label="Remove Codex account"
                onClick={() => setPendingRemoveCodex(account)}
              >
                ×
              </Button>
            </div>
          )
        })}
      </div>
    )
  }

  // Open a login terminal for an account and wait (up to ~5 min) for the CLI to write its
  // credentials; on success flip the row out of `pending` and adopt the captured email. A remote
  // account (`host` set) logs in on its host: the login node runs in remote tmux and waitLogin polls
  // the remote `.claude.json` over ssh (via the ctx `projectId`).
  const runLogin = async (account: Pick<ClaudeAccount, 'id' | 'host'>): Promise<void> => {
    const remote = !!account.host
    const projectId = remote ? projectIdForHost(account.host) : undefined
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
  // then carries the host chip and only appears in that host's projects.
  const onAddAccount = async (host?: string): Promise<void> => {
    if (addingOn) return // one setup at a time — the buttons are disabled, this is the guard
    const projectId = host ? projectIdForHost(host) : undefined
    setAddingOn(host ?? LOCAL_TARGET)
    setAddError(null)
    let added: { id: string; versionSupported: boolean }
    try {
      added = await window.nodeTerminal.claudeAccounts.add(projectId ? { projectId } : undefined)
    } catch (e) {
      // The remote path does not reject on a failed setup (it answers with an empty configDir and
      // lets the login node report the connection error), so reaching here means the call itself
      // never landed. Say so: after a spinner, silence is the one outcome that teaches nothing.
      // E_UNSUPPORTED is a separate sentence because it is a fact about the surface, not this
      // account: the Server Edition serves these channels now, but a relay tab still refuses them
      // and so does a server binary older than that change.
      setAddError(
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
      setAddingOn(null)
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

  const confirmRemove = async (account: ClaudeAccount): Promise<void> => {
    setPendingRemove(null)
    // Removing a pending account: stop the 5-minute waitLogin poll loop first.
    if (account.pending) await window.nodeTerminal.claudeAccounts.cancelWaitLogin(account.id)
    const projectId = projectIdForHost(account.host)
    await window.nodeTerminal.claudeAccounts.remove(
      account.id,
      projectId ? { projectId } : undefined
    )
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
    return `Remove account "${a.label}"? Its logged-in credentials and all its Claude transcripts will be deleted. ${n} node(s) currently use it and will fall back to the system account.`
  }

  return (
    <SettingsSection
      id="accounts"
      title="Accounts"
      description="Isolated Claude logins. Each account has its own config dir, credentials, and transcripts; a node keeps the account it was created with for life."
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

          {/* The SYSTEM account (the machine's default ~/.claude login) is implicit — not a
              ClaudeAccount record — but gets a fixed row so it can be told apart from managed
              accounts: detected email as subtitle, renamable display label (empty = default). */}
          <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <Input
                  className="w-56"
                  placeholder="System account"
                  value={systemLabelSetting}
                  onChange={(e) => useSettings.getState().update({ systemAccountLabel: e.target.value })}
                />
                <span
                  className="rounded-full bg-fill-weak px-2 py-0.5 text-[11px] font-medium text-muted"
                  title="The machine's default Claude login (~/.claude). Used when a node has no account."
                >
                  system
                </span>
              </div>
              {systemEmail ? <p className="text-[12px] text-muted">{systemEmail}</p> : null}
            </div>
          </div>

          {accounts.length === 0 ? null : (
            accounts.map((account) => (
              <div
                key={account.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <Input
                      className="w-56"
                      placeholder="Account label"
                      value={account.label}
                      onChange={(e) => setLabel(account.id, e.target.value)}
                    />
                    {account.pending ? (
                      <span className="rounded-full bg-[color:var(--warn)]/15 px-2 py-0.5 text-[11px] font-medium text-[color:var(--warn)]">
                        pending
                      </span>
                    ) : null}
                    {account.host ? (
                      <span
                        className="rounded-full bg-[color:var(--accent)]/15 px-2 py-0.5 text-[11px] font-medium text-[color:var(--accent)]"
                        title={`Remote account on ${account.host}`}
                      >
                        {account.host}
                      </span>
                    ) : null}
                  </div>
                  {account.email && !account.pending ? (
                    <p className="text-[12px] text-muted">{account.email}</p>
                  ) : null}
                  <AccountColorSwatches
                    label={account.label}
                    color={account.color}
                    onPick={(c) => setColor(account.id, c)}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {account.pending
                    ? (() => {
                        // A remote account can only retry login on a connected matching-host
                        // project; without one, disable Retry (a local spawn would log into the
                        // system account instead of the remote host).
                        const blocked = !!account.host && !connectedProjectIdForHost(account.host)
                        return (
                          <Button
                            disabled={blocked}
                            title={
                              blocked
                                ? `Connect to ${account.host} to finish logging in`
                                : undefined
                            }
                            onClick={() => void runLogin(account)}
                          >
                            Retry login
                          </Button>
                        )
                      })()
                    : null}
                  <Button
                    variant="ghost"
                    aria-label="Remove account"
                    onClick={() => setPendingRemove(account)}
                  >
                    ×
                  </Button>
                </div>
              </div>
            ))
          )}

          {activeHostKey ? (
            // Inside an SSH project: choose where the new account lives. "On this Mac" is a normal
            // local account; "On <host>" creates it on the remote host (usable only there).
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  disabled={addingOn !== null}
                  onClick={() => void onAddAccount()}
                >
                  {addingOn === LOCAL_TARGET ? (
                    <AddingLabel where="this Mac" />
                  ) : (
                    'Add account — On this Mac'
                  )}
                </Button>
                <Button
                  variant="primary"
                  disabled={addingOn !== null}
                  onClick={() => void onAddAccount(activeHostKey)}
                >
                  {addingOn === activeHostKey ? (
                    <AddingLabel where={activeHostKey} />
                  ) : (
                    `Add account — On ${activeHostKey}`
                  )}
                </Button>
              </div>
              {/* A spinner says "wait"; this says what for. Setting up a remote account is a
                  handful of ssh round-trips plus a login-shell `claude --version`, so it takes
                  long enough that silence reads as a broken button. */}
              {addingOn !== null ? (
                <p className="text-[12px] leading-relaxed text-muted">
                  {addingOn === LOCAL_TARGET
                    ? 'Creating the config dir and installing the status hook…'
                    : `Creating the config dir on ${addingOn} and installing the status hook and agent skills over SSH — this takes a few seconds. The login terminal opens when it's ready.`}
                </p>
              ) : null}
              {addError ? <p className="text-[12px] text-[color:var(--danger)]">{addError}</p> : null}
            </div>
          ) : (
            <div className="space-y-2">
              <Button
                variant="primary"
                disabled={addingOn !== null}
                onClick={() => void onAddAccount()}
              >
                {addingOn === LOCAL_TARGET ? <AddingLabel where="this Mac" /> : 'Add account'}
              </Button>
              {addingOn !== null ? (
                <p className="text-[12px] leading-relaxed text-muted">
                  Creating the config dir and installing the status hook…
                </p>
              ) : null}
              {addError ? <p className="text-[12px] text-[color:var(--danger)]">{addError}</p> : null}
            </div>
          )}

          <p className="text-[12px] leading-relaxed text-muted">
            Accounts are isolated Claude logins. New Claude nodes pick an account from the add
            menus; each node keeps its account for life. A node color applies to nodes opened under
            that account from then on — existing ones keep the color they have. Remote accounts live
            on an SSH host and are only offered in that host&apos;s projects.
          </p>
        </div>
      </SearchableRow>

      {/* Codex accounts, grouped by machine. Each managed Codex login has its own CODEX_HOME and
          credentials; a node keeps its account for life. Machine provenance (Local / SSH · host)
          is shown as a pill; the credential-storage kind is deliberately not surfaced. */}
      <SearchableRow {...ROWS.codex}>
        <div className="space-y-4">
          {codexGroups.map((group) => (
            <MachinePanel
              key={group.host || 'local'}
              label={group.remote ? (group.server?.label ?? group.host) : 'This Mac'}
              remote={group.remote}
              hostKey={group.host || undefined}
              connected={group.remote ? !!connectedProjectIdForHost(group.host) : true}
            >
              {codexRowsFor(group.accounts, group.remote ? group.host : undefined)}
              {!group.remote ? (
                <div className="space-y-2">
                  <Button variant="primary" disabled={addingCodex} onClick={() => void onAddCodexAccount()}>
                    {addingCodex ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="ui-spinner" aria-hidden />
                        Setting up on this Mac…
                      </span>
                    ) : (
                      'Add Codex account'
                    )}
                  </Button>
                  {codexAddError ? (
                    <p className="text-[12px] text-[color:var(--danger)]">{codexAddError}</p>
                  ) : null}
                </div>
              ) : (
                <p className="text-[12px] leading-relaxed text-muted">
                  Codex accounts on this machine are managed from its own NodeTerm. Accounts already
                  created here are shown above.
                </p>
              )}
            </MachinePanel>
          ))}

          {codexStrays.length > 0 ? (
            <div className="space-y-2 rounded-md border border-[color:var(--warn)]/40 p-3">
              <p className="text-[12px] font-medium text-[color:var(--warn)]">
                Accounts on machines you no longer have saved
              </p>
              {codexRowsFor(codexStrays)}
            </div>
          ) : null}

          <p className="text-[12px] leading-relaxed text-muted">
            Codex accounts are isolated logins, grouped by the machine their credentials live on.
            New Codex nodes pick an account from the add menus; each node keeps its account for life.
            A node color applies to nodes opened under that account from then on — existing ones
            keep the color they have.
          </p>
        </div>
      </SearchableRow>

      {pendingRemove ? (
        <ConfirmDialog
          message={removeMessage(pendingRemove)}
          confirmLabel="Remove"
          onConfirm={() => void confirmRemove(pendingRemove)}
          onCancel={() => setPendingRemove(null)}
        />
      ) : null}
      {pendingRemoveCodex ? (
        <ConfirmDialog
          message={`Remove Codex account "${pendingRemoveCodex.label}"?${
            pendingRemoveCodex.host
              ? ' It is dropped from this NodeTerm; its credentials on the host are untouched.'
              : ' Its logged-in credentials and its Codex home will be deleted.'
          }`}
          confirmLabel="Remove"
          onConfirm={() => void confirmRemoveCodex(pendingRemoveCodex)}
          onCancel={() => setPendingRemoveCodex(null)}
        />
      ) : null}
    </SettingsSection>
  )
}
