// buildRelayApi — assemble a full `NodeTerminalApi` for a remote-desktop (relay) project tab.
//
// A relay tab is a client of ANOTHER desktop's core, exactly as the browser is a client of the
// Server Edition's core (docs/remote-sessions.md, Stage 4). So it reuses the SAME ws-bridge builders
// the browser uses (`buildRealApi`/`buildFilesApi`/`buildAgentApi`/`buildCanvasApi`/`buildPresenceApi`/
// `buildClaudeApi`) — but over the E2EE relay tunnel (`RelayFrameTransport`) instead of a WebSocket.
// This is the 4a "swap the API object" payoff: a remote tab's `useSession().api` is this object, and
// `createSession('relay', api, label)` (Task 6) wires it into the session registry.
//
// ── The API split (binding, from docs/remote-sessions.md line 70–76) ──────────────────────────────
// • CORE-BOUND namespaces (`pty`, `workspace`, `fs`, `git`, `files`, `context`, `canvas`, `presence`,
//   the `onAgentStatus`/`onSubagentActivity` streams, `claude.cliCaps`, `userDataDir`) route over the
//   relay RpcClient → they hit the REMOTE core. This is what makes the tab actually remote: its
//   terminals, repos, files, canvas and presence all live on the host's machine.
// • APP-GLOBAL namespaces (`updates`, `license`, `clipboard`, `shell`, `dialog`, `media`,
//   `settings`, `pairing`, `announcements`, `usage`, `ssh*`, `remote*`, `relay*`, notifications, menu events)
//   stay LOCAL (`window.nodeTerminal.*`). Your update banner shows YOUR version, a file picker
//   browses YOUR disk, your UI settings/theme are yours, and the relay-tunnel machinery itself is
//   your local main process. Routing one of these to the remote core would be a latent bug.
//
// ── Two gotchas that make or break the tab ───────────────────────────────────────────────────────
// 1. `pty.onData` is the ONE core-bound member that does NOT go through the RpcClient. Relay pty
//    output is decoded in the main process and re-emitted on the LOCAL per-session `pty:data`
//    channel (`src/main/index.ts` `onPtyData` → `IPC.ptyData(sessionId)` → preload), NOT over the
//    RpcClient frame stream (`RelayFrameTransport.onMessage` only carries JSON frames). So it
//    delegates to the LOCAL preload's `pty.onData` — the exact same channel a local pty uses. Wire
//    it to the RpcClient instead and the remote terminal is blank.
// 2. `RelayFrameTransport.ready()` resolves on `onApproved`, which fires exactly ONCE. The transport
//    must be constructed (registering that listener) BEFORE the humans confirm the SAS — i.e. Task 6
//    calls `buildRelayApi` while the approval dialog is still open, THEN awaits `ready()`. Building
//    it after approval already fired leaves `ready()` pending forever and the api never comes up.

import type { NodeTerminalApi } from '../../shared/types'
import { type FrameTransport, RelayFrameTransport } from './frame-transport'
import {
  RpcClient,
  buildRealApi,
  buildFilesApi,
  buildAgentApi,
  buildCanvasApi,
  buildPresenceApi,
  buildClaudeApi,
  buildGitHubApi
} from './ws-bridge'
import { buildStubApi } from './stubs'
import { mountPickerRoot, openDirectoryPicker } from './dialog-picker'

/** What Task 6 consumes: the bridged api for `createSession`, an approval gate to await, and a
 *  teardown hook to run on disconnect/revoke. */
export interface RelayApiHandle {
  /** The bridged `NodeTerminalApi` for `createSession('relay', api, label)`. */
  api: NodeTerminalApi
  /** Resolves once BOTH humans confirmed the SAS (the relay frame pipe is live). Delegates to the
   *  transport's `ready()`; see gotcha 2 about construction order. */
  ready(): Promise<void>
  /** Tear the connection down: close the relay socket for this connectionId. */
  close(): void
}

/**
 * Build the bridged api for a relay connection. `transport` is a test seam — production passes
 * nothing and a `RelayFrameTransport(connectionId)` is constructed here (which is what registers the
 * one-shot `onApproved` listener; see gotcha 2).
 */
export function buildRelayApi(connectionId: string, transport?: FrameTransport): RelayApiHandle {
  // The LOCAL preload — this is a desktop-only path (relay hosting/joining is Electron), so
  // `window.nodeTerminal` is the full real preload, not the browser stub surface.
  const local = (window as unknown as { nodeTerminal: NodeTerminalApi }).nodeTerminal
  const client = new RpcClient(transport ?? new RelayFrameTransport(connectionId))

  const real = buildRealApi(client) // { pty, workspace, settings, userDataDir }
  const files = buildFilesApi(client) // { fs, git, files, context }
  const github = buildGitHubApi(client)
  const stub = buildStubApi()

  const api: NodeTerminalApi = {
    // ── Base: every APP-GLOBAL namespace stays LOCAL. Spreading the whole preload gives the real
    //    desktop implementations (updates/license/clipboard/shell/dialog/media/settings/pairing/
    //    announcements/usage/ssh*/remote*/relay*/notifications/menu events). The core-bound spreads
    //    below override the handful that must hit the remote core.
    ...local,

    // ── CORE-BOUND: route to the REMOTE core over the relay RpcClient. ──
    workspace: real.workspace, // the host's canvas/project files
    userDataDir: real.userDataDir, // the host's writable base — worktree default paths live there
    fs: files.fs,
    git: files.git,
    files: files.files,
    context: files.context,
    githubIssues: github.githubIssues,
    githubControl: local.githubControl,
    ...buildAgentApi(client), // onAgentStatus / onSubagentActivity — the host's agent hooks
    ...buildCanvasApi(client), // canvas sync against the host's reflector
    ...buildPresenceApi(client), // the host's presence hub
    // `cliCaps` is REAL over the relay so the --permission-mode auto version gate probes the HOST's
    // claude CLI (a remote node launches on the host); `readTranscript` stays LOCAL (v1 degrade —
    // transcripts aren't relayed, so it reads this machine's; the only consumer reads the global api).
    claude: buildClaudeApi(client, local.claude),

    // pty is core-bound EXCEPT `onData` (gotcha 1): its output arrives on the LOCAL per-session
    // channel, so subscribe on the local preload, same shape as a local pty.
    pty: {
      ...real.pty,
      onData: (sessionId, listener) => local.pty.onData(sessionId, listener)
    },

    // boardLog is CORE-BOUND: a relay guest reads and writes the HOST project's board comments/activity
    // (with its OWN presence identity in each entry), routed to the host's registry-jailed board-log
    // handlers (and scope-jailed to the shared project host-side in connectRelayHost). Version-skew
    // degrade: an OLDER host with no board-log rpc answers E_NO_HANDLER, which we map to today's
    // behavior — read → `{ entries: [], unsupported: true }`, append → `false` — instead of a rejection.
    // `onChanged` casts subscribe/unsubscribe (fire-and-forget, no reject) and rides the host push.
    boardLog: {
      append: (projectId, entry) => files.boardLog.append(projectId, entry).catch(() => false),
      read: (projectId, opts) =>
        files.boardLog.read(projectId, opts).catch(() => ({ entries: [], unsupported: true })),
      onChanged: (projectId, cb) => files.boardLog.onChanged(projectId, cb)
    },

    // `settings` stays LOCAL (font/cursor/theme render in YOUR window). It came in via `...local`;
    // `real.settings` is deliberately left unused so a remote tab never adopts the host's prefs.

    // `dialog` REFINES Task 5's coarse "dialog → local". `selectFolder`/`selectFile` are the only
    // members `DialogApi` exposes, and in a remote tab BOTH are host-path pickers, not local ones:
    // the chosen path is fed to the SESSION core (a clone destination for `api.git.clone`, an
    // "open folder/file" target on the host fs), so a native LOCAL picker would land the op on the
    // wrong machine (obligation d). Route both to the SAME in-app directory browser the Server
    // Edition uses, over the HOST's `fs.list` (`files.fs`, already core-bound). There is no other,
    // genuinely-local `dialog.*` method that would want to stay on `...local`. Desktop-only path, so
    // `document` exists for `mountPickerRoot`.
    dialog: (() => {
      mountPickerRoot()
      const startDir = '/' // navigable up/down from the host root; no cross-call memory in v1
      return {
        selectFolder: () => openDirectoryPicker({ mode: 'folder', startDir, list: files.fs.list }),
        selectFile: () => openDirectoryPicker({ mode: 'file', startDir, list: files.fs.list })
      }
    })(),

    // ── Deferred over the relay in v1 — documented degrades (a clean refusal, not a wrong-machine
    //    silent no-op): ──
    // `chat` is now just readTranscript (the SDK chat node was removed). It has no relay builder:
    // reading a transcript over the relay would read THIS machine's transcript, not the host's, so
    // refuse with E_UNSUPPORTED instead. contextLink / transcripts / handoff stay LOCAL by way of
    // `...local` (a v1 degrade: they read/write on this machine, not the host). boardLog is now
    // bridged to the host (see above) — it no longer rides `...local`.
    chat: stub.chat,
    // Agent canvas-control (`agent:control`) is not wired over the relay (matches the Server
    // Edition); inert no-ops rather than a local subscription that never carries the host's events.
    onAgentControl: stub.onAgentControl,
    sendAgentControlResult: stub.sendAgentControlResult
  } satisfies NodeTerminalApi

  return {
    api,
    ready: () => client.ready(),
    close: () => local.relayClient.disconnect(connectionId)
  }
}
