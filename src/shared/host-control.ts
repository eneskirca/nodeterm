import { IPC } from './ipc'

/**
 * HOST-ONLY channels: the RPC methods a relay GUEST may never reach, in ONE list both shells read.
 *
 * A relay peer (a paired phone, another desktop over 4c) is a first-class client of this machine's
 * core — that is the point of the peer registry — but it is NOT the host's user. A small set of
 * methods are the host's own control plane, and admitting one of them from a guest hands over
 * something the guest could not otherwise have:
 *
 *  - `githubControl:*` — the token/approval plane for the host's GitHub credentials.
 *  - `project-setup:run` — starts a script ON the host, in the host's shell, as the host's user.
 *  - `project-setup:consent-submit` — the ANSWER to the host's own trust prompt. Admitting `run`
 *    and this one together is the whole attack: a guest raises the prompt and then approves it
 *    itself, so a shared `.nodeterm/project.json` script executes with no human ever looking at a
 *    dialog. Either one alone is much weaker; the pair is a complete self-approval loop.
 *  - `project-setup:cancel` — the other side of the same run's control: a guest must not be able to
 *    kill the host's setup mid-write.
 *  - `project-setup:request-trust` — RAISES the host's own consent dialog for a project's launch
 *    settings. Alone it is prompt spam on someone else's screen; paired with an admitted
 *    consent-submit it is the same self-approval loop as run+consent-submit, ending in a shared
 *    `launchCmd`/`env` (or shell) approved for the host's own agent launches.
 *
 *  - `pty:launch-headless` (#925) — the desktop's canvas-control `--run-now` / `run`: it starts a
 *    node's session with no viewer and types its launch on the host. The relay guest's own bridge
 *    already refuses it (a relay tab inherits ws-bridge's `pty`), and this makes the refusal hold
 *    host-side for a peer that sends the raw request (spec §6: "Relay tab | Refuses").
 *  - `station-notice:dropped` — a DROPPED verdict makes the host tell an orchestrator, possibly in
 *    its own session, that one of its stations died. It is a pane measurement only the HOST's
 *    renderer makes (a relay tab takes the inert stub), so a guest sending it is claiming a fact
 *    about the host's panes it never measured.
 *  - `station-notice:list` — every project's failed-station ids and titles, unscoped. A relay tab
 *    never asks (it takes the inert stub), and a guest bound to ONE project must not read the rest.
 *
 * DELIBERATELY NOT LISTED: `project-setup:subscribe`/`unsubscribe` and the `project-setup:event:*`
 * push. They neither start nor authorize anything, and a peer that can see the canvas can already
 * see that a setup is running. The gate is on ACTION, not on the namespace — which is also why
 * this is an explicit list rather than a `project-setup:` prefix.
 *
 * This lives in `shared/` because it is a policy question, not a shell mechanism: two shells each
 * carrying their own `startsWith` is exactly how one of them ends up a release behind the other.
 */
export const HOST_ONLY_CHANNEL_PREFIXES: readonly string[] = [
  'githubControl:',
  // The host's credential and identity planes. None of these crosses the relay for a legitimate
  // tab (relay-api.ts keeps license/accounts/usage LOCAL), and each is something the invite never
  // granted: the license key and its seats, the managed Claude/Codex logins (a login node writes
  // credentials into the account dir, removal deletes one), and account usage read with the
  // host's stored tokens.
  'license:',
  'claude-accounts:',
  'codex-accounts:',
  'usage:',
  // The trust plane itself: who is paired, who may connect, and the invites that mint seats. A
  // peer that could reach these could pin its own key or revoke the host's other devices. Note the
  // trailing colons: `relay:host:` does not match the hosted-team verbs (`relay:hosted:*`), which
  // the Server Edition's hosted service intercepts and judges itself.
  'pairing:',
  'remote:',
  'relay:host:',
  'relay:client:'
]

export const HOST_ONLY_CHANNELS: ReadonlySet<string> = new Set([
  IPC.projectSetupRun,
  IPC.projectSetupCancel,
  IPC.projectSetupConsentSubmit,
  IPC.projectSetupRequestTrust,
  IPC.ptyLaunchHeadless,
  // A board comment that @mentions a session types into that session's pane. Only the host's own
  // user may do that: a relay peer's comment is display-only. Registered with a raw ipcMain handler
  // (so no peer can reach it at all); listed here too, so moving it onto the platform table later
  // cannot quietly open it.
  IPC.agentBoardCommentDeliver,
  IPC.stationNoticeDropped,
  // The host's own dispatcher state; a relay tab's board belongs to the host and its dispatch is
  // refused, so a peer has nothing true to report.
  IPC.boardDispatchReport,
  IPC.stationNoticeList,
  // Unscoped: every project's station outcomes and their notes. A relay guest bound to one project
  // must not read another's, and a relay tab's launch loop is refused anyway (its stub is inert).
  IPC.stationOutcomeList,
  // Same class: which of the host's stations (any project) have work handed to them.
  IPC.stationHandoverList,
  // "Open recent": the host's conversation history — titles are prompts the host's user typed, in
  // every project. A relay tab lists its OWN machine's history (relay-api keeps it `...local`), so
  // no legitimate peer asks the host for this.
  IPC.recentConversationsList,
  // The host's settings. `settings:save` is the dangerous half: `modelGateway.baseUrl` is the TRUST
  // ANCHOR `agent:discover-models` uses to decide whether it may resolve the stored
  // `${secret:model-gateway-api-key}` (core/agent-env-ipc.ts), so a peer that could save settings
  // and then ask for discovery would have the keychain-held key sent to a URL of its choosing.
  // `settings:load` goes too: settings.json carries custom agents' launch env (API keys), and a
  // relay tab keeps its settings LOCAL (relay-api.ts), so no legitimate peer reads the host's.
  IPC.settingsLoad,
  IPC.settingsSave,
  // Model-gateway discovery and the write-only gateway credential. Discovery resolves host-side
  // secrets against the saved gateway; the credential verbs write/clear the keychain-held key.
  IPC.agentDiscoverModels,
  IPC.agentGatewayCredentialStatus,
  IPC.agentGatewayCredentialSave,
  IPC.agentGatewayCredentialClear,
  // Dev-server ports: a scan lists the host's listening ports, and a forward binds a port on the
  // HOST machine's loopback over one of its SSH masters. Neither is a peer's to ask for.
  IPC.devPortsScan,
  IPC.devPortsForward,
  IPC.devPortsUnforward
])

/** What a refused peer is told. One wording, so the two shells answer identically. */
export const HOST_ONLY_REFUSAL = 'host-control method is not available to relay peers'

export function isHostOnlyChannel(channel: string): boolean {
  // The method name arrives off the wire; a non-string is never a channel (and must not throw).
  if (typeof channel !== 'string') return false
  if (HOST_ONLY_CHANNELS.has(channel)) return true
  return HOST_ONLY_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix))
}
