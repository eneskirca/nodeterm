// Interop fixture for the Android protocol tests: runs the DESKTOP's real code on the other end of
// the wire, so the Kotlin client is checked against the implementation, not against a reading of it.
//
//   mode "relay": a tiny in-process relay broker (pairs a host and a client by room, forwards
//                 frames preserving text/binary — all the real relay does) plus the desktop's
//                 `connectHostSession` (src/main/remote/host-service.ts → relay-socket.ts host role)
//                 serving a FAKE pty/kanban/inbox bridge that records what the phone asked for.
//                 `projects.list` is NOT faked: the desktop's `buildProjectsListBlob` over a real
//                 `WorkspaceStore` and a mirror file the real agent-status mirror wrote, all under
//                 FIXTURE_USERDATA (see seedDesktopState; audit A64). Neither is `git.*`: the real
//                 `GitService` behind the real jail, over a repository in the project's folder (see
//                 seedGitRepo; audit A29). Nor the `lan` field beside the blob: the desktop's own
//                 `createHostLanReporter` over the test's interfaces and host-key dir (A74-refresh).
//   mode "pair":  the desktop's real `createPairingService` (src/main/pairing-service.ts) with the
//                 home dir pointed at a temp dir by the caller (HOME, and USERPROFILE for Windows, see
//                 InteropHarness.scratchHomeEnv; refused unless `os.homedir()` is FIXTURE_HOME), and a
//                 fake `/v1/relay/device` API. It exercises the direct-SSH pairing path on every OS.
//                 The SSH host keys its sealed answer names are read from FIXTURE_SSH_HOST_KEY_DIR (a
//                 dir of `ssh_host_*_key.pub` the test lays out), or from a dir that does not exist
//                 when unset, never from the machine's real /etc (audit A49-anchor).
//                 With FIXTURE_LATE_PIN_KEYS it then asks the service, per key, what the standing host
//                 asks on a relay handshake (`approvePairedRelayKey`, audit A07-late), before and
//                 after revoking every device.
//   mode "ack-sweep": the real shared-file consumers (also bundled independently by
//                 ack-fixture-runner.ts), receiving ownership and a scratch home from the caller.
//   mode "launch-parity": real mirror host facts and shared desktop approval command assembly.
//   mode "pairing-network": real QR builder, adapter policy and LAN reporter over an explicit
//                 fake OS-interface boundary. No HTTP pairing/authentication or socket is simulated.
//   mode "never-ready": prints nothing and stays alive, so InteropHarnessTest can check that a
//                 harness whose ready wait fails still kills the process.
//
// Protocol with the Kotlin test: line 1 on stdout is a JSON "ready" object; every later line is a
// JSON event. Bundled by esbuild at test time (see InteropHarness.kt); `ws` stays external and
// resolves from the repo's node_modules, and `electron` is aliased to ./electron-stub.ts, so the
// real package (whose first `require` downloads the Electron binary) is never loaded (audit A60).
// esbuild only strips types, so this file is type-checked by `npm run typecheck` as part of
// tsconfig.node.json (audit A67): a desktop interface it implements cannot drift from it unseen.
// Do not cast what it hands to the desktop code (`as unknown as`, `as never`); a cast turns that
// check off for the value, and the drift then shows up only at run time.
import { execFileSync } from 'child_process'
import { createInterface } from 'readline'
import { runAckSweep } from './ack-fixture'
import { composedBackendFixture } from './composed-backend-fixture'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import { initPlatform, platform } from '../../../../../src/core/platform'
import { genKeyPair, publicKeyToB64 } from '../../../../../src/main/remote/e2ee'
import {
  connectHostSession,
  type HostPtyManager,
  type HostSession
} from '../../../../../src/main/remote/host-service'
import { createHostNewSessions } from '../../../../../src/main/remote/host-new-sessions'
import { createHostLanReporter } from '../../../../../src/main/remote/host-lan-report'
import {
  flush as flushMirror,
  initAgentStatusMirror,
  mirrorClaudeAccount,
  recordAgentEvent,
  recordRawToolEvent,
  setMirrorSettingsProvider,
  setNodeSessionName,
  type MirrorSettings
} from '../../../../../src/core/agent-status-mirror'
import {
  claudeAccountsSnapshot,
  claudeConfigDirFor,
  observedClaudeAccount,
  registerClaudeAccountsSource
} from '../../../../../src/core/claude-config-dir'
import { GitService } from '../../../../../src/core/git-service'
import { searchTerminalHistory } from '../../../../../src/core/terminal-history'
import { buildProjectsListBlob } from '../../../../../src/core/projects-list-blob'
import { WorkspaceStore } from '../../../../../src/core/workspace-store'
import { codexApprovalValuesFrom } from '../../../../../src/shared/agents/codex-approval-values'
import { assembleLaunchCommand, assembleResumeCommand } from '../../../../../src/shared/agents/launch'
import { AGENT_CONFIG, ALL_PERMISSION_MODES, gatePermissionMode } from '../../../../../src/shared/agents/config'
import { normalizeFor } from '../../../../../src/shared/agents/normalize'
import { createPairingService } from '../../../../../src/main/pairing-service'
import { emptyApprovedDevices, isPinned, pinDevice } from '../../../../../src/main/remote/approved-devices-core'
import { createRevoker } from '../../../../../src/main/remote/revocation'
import { buildPairingPayload } from '../../../../../src/main/pairing-core'
import { pairingNetworkChoices, pairingNetworkIPv4, type PairingInterfaces } from '../../../../../src/shared/pairing-network'
import type { DetachedSinks } from '../../../../../src/core/pty-manager'
import { DEFAULT_SETTINGS, type ClaudeAccount, type Workspace } from '../../../../../src/shared/types'

const emit = (obj: unknown): void => {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

initPlatform({
  userDataDir: process.env.FIXTURE_USERDATA ?? process.cwd(),
  appVersion: '0.0.0-interop',
  isPackaged: false,
  handle: () => {},
  on: () => {},
  handleWithSender: () => {},
  onWithSender: () => {},
  sendTo: () => {},
  broadcast: () => {},
  clientIds: () => [],
  openExternal: async () => {}
})

// ---- a relay broker: pair `?token=host-<room>` with `?token=client-<room>` ------------------------

export function startBroker(): Promise<number> {
  const rooms = new Map<string, { host?: WebSocket; client?: WebSocket; queue: { to: 'host' | 'client'; data: unknown; binary: boolean }[] }>()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  wss.on('connection', (ws, req) => {
    const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? ''
    const m = /^(host|client)-(.+)$/.exec(token)
    if (!m) {
      ws.close(4001, 'bad token')
      return
    }
    const role = m[1] as 'host' | 'client'
    const room = rooms.get(m[2]) ?? { queue: [] }
    rooms.set(m[2], room)
    room[role] = ws
    emit({ event: 'broker-join', role })
    const peerOf = (r: 'host' | 'client'): 'host' | 'client' => (r === 'host' ? 'client' : 'host')
    const flush = (): void => {
      room.queue = room.queue.filter((q) => {
        const target = room[q.to]
        if (!target) return true
        target.send(q.data as Buffer, { binary: q.binary })
        return false
      })
    }
    flush()
    ws.on('message', (data, isBinary) => {
      room.queue.push({ to: peerOf(role), data: isBinary ? data : data.toString('utf-8'), binary: isBinary })
      flush()
    })
    ws.on('close', () => {
      emit({ event: 'broker-close', role })
      room[peerOf(role)]?.close()
      room[role] = undefined
    })
  })
  return new Promise((resolve) => wss.on('listening', () => resolve((wss.address() as { port: number }).port)))
}

// ---- mode "relay" ----------------------------------------------------------------------------------

/**
 * What the phone lists (`projects.list`), produced by the desktop's own code (audit A64), under the
 * caller's scratch userData (FIXTURE_USERDATA; the Kotlin test deletes it):
 *  - the workspace: the real `WorkspaceStore` writes it as the desktop does (a v3 index plus the
 *    folder's `.nodeterm/project.json`), and the blob serves the store's read-only `load()` of it;
 *  - `agent-status.json`: the real mirror, fed the hook POSTs a Claude session makes, as both shells
 *    feed it (the raw listener's `recordRawToolEvent`, then the normalized event with the hook
 *    server's account label into `recordAgentEvent`), and flushed by its own writer;
 *  - the mirror's settings block: the shells' provider body over one managed Claude account.
 * Hand-written here: the workspace the renderer would hand the store, the hook payloads (with the
 * `nodeterm_pending_id` the hook server merges in from its form field), the session name the
 * name sweep would publish, and the tmux session list (there is no tmux).
 */
async function seedDesktopState(settings: Partial<MirrorSettings> = {}): Promise<WorkspaceStore> {
  const userData = platform().userDataDir
  const workspace: Workspace = {
    version: 2,
    activeProjectId: 'p1',
    projects: [
      {
        id: 'p1',
        name: 'Demo',
        color: '#0a84ff',
        cwd: path.join(userData, 'demo'),
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          { id: 'term-abc-1', kind: 'terminal', title: 'Claude', color: '#d97757', agentId: 'claude', group: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } },
          { id: 'note-1', kind: 'sticky', title: 'Note', color: '#fff', group: null, text: 'hi', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }
        ],
        kanban: {
          columns: [{ id: 'c1', title: 'To Do', color: '#0a84ff' }],
          assignments: [{ nodeId: 'term-abc-1', columnId: 'c1' }],
          labels: [{ id: 'l1', name: 'bug', color: 'red' }],
          meta: [{ nodeId: 'term-abc-1', labels: ['l1'], priority: 'high' }]
        }
      }
    ]
  }
  const store = new WorkspaceStore()
  await store.save(workspace)

  // A39/A75: one managed Claude account, registered the way both shells register settings.
  const accounts: ClaudeAccount[] = [{ id: 'acct-1', label: 'Work', email: 'me@work.example', createdAt: 0 }]
  registerClaudeAccountsSource(() => accounts)
  setMirrorSettingsProvider(() => ({
    claudePermissionMode: 'manual',
    autoSupported: false,
    ...settings,
    claudeAccounts: claudeAccountsSnapshot()
      .filter((a) => !a.host && !a.pending)
      .map((a) => mirrorClaudeAccount(a, claudeConfigDirFor(a.id)))
  }))

  // As both shells do at boot: the mirror's default file, `<userData>/agent-status.json`, which is
  // where `buildProjectsListBlob` reads it back.
  initAgentStatusMirror()
  const nodeId = 'term-abc-1'
  const session = {
    session_id: 's-1',
    // Under the account's config dir, so the hook server's label names acct-1.
    transcript_path: path.join(claudeConfigDirFor('acct-1'), 'projects', '-demo', 's-1.jsonl'),
    cwd: workspace.projects[0].cwd
  }
  const hook = (payload: Record<string, unknown>, id = nodeId): void => {
    recordRawToolEvent(id, payload)
    const ev = normalizeFor('claude', { nodeId: id, agentId: 'claude', payload })
    const account = observedClaudeAccount('claude', payload)
    if (ev) recordAgentEvent({ ...ev, ...(account ? { account } : {}) })
  }
  const bash = { tool_name: 'Bash', tool_input: { command: 'npm test' } }
  hook({ ...session, hook_event_name: 'PreToolUse', ...bash })
  // A held hook-reply approval: the managed hook's deterministic ticket.
  hook({ ...session, hook_event_name: 'PermissionRequest', ...bash, nodeterm_pending_id: 'term-abc-1-1700000000000-42',
    ...(process.env.FIXTURE_STRUCTURED_HOOKS === '1' ? { nodeterm_hook_reply: 2, permission_suggestions: [
      { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }
    ] } : {}) })
  if (process.env.FIXTURE_STRUCTURED_HOOKS === '1') hook({ ...session, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
    tool_use_id: 'question-tool', nodeterm_hook_reply: 2, nodeterm_pending_id: 'term-question-1-1700000000000-43', tool_input: { questions: [
      { question: 'Languages?', header: 'Languages', multiSelect: true, options: [{ label: 'Kotlin', description: 'Phone' }, { label: 'TypeScript', description: 'Host' }] },
      { question: 'Where?', header: 'Place', multiSelect: false, options: [{ label: 'Here', description: '' }, { label: 'There', description: '' }] }
    ] } }, 'term-question-1')
  setNodeSessionName(nodeId, 'fix bug')
  await flushMirror()
  return store
}

/**
 * The project's folder as a git repository the phone's source control works on (audit A29), made the
 * way a user would make one: an initial commit (the project's own `.nodeterm/project.json` included)
 * pushed to a bare `origin` beside the folder, then one change of each kind the status reports — a
 * staged new file, a modified tracked file and an untracked file. Repo-local identity, no signing and
 * no hooks, so a contributor's global git config cannot decide whether the phone's commit succeeds.
 */
function seedGitRepo(dir: string): void {
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'pipe' })
  }
  const origin = path.join(path.dirname(dir), 'origin.git')
  git(path.dirname(dir), 'init', '--bare', '--initial-branch=main', origin)
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.name', 'Interop')
  git(dir, 'config', 'user.email', 'interop@example.test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'))
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'initial')
  git(dir, 'remote', 'add', 'origin', origin)
  git(dir, 'push', '-u', 'origin', 'main')
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello again\n')
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n')
  git(dir, 'add', 'staged.txt')
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new file\n')
}

async function runRelay(): Promise<void> {
  // Relay mode writes a workspace and the agent-status mirror under userData: never into the
  // checkout the fixture runs from.
  if (!process.env.FIXTURE_USERDATA) throw new Error('relay mode needs FIXTURE_USERDATA (a scratch dir)')
  const alternative = process.env.FIXTURE_COMPOSED_BACKEND
    ? await composedBackendFixture(path.join(process.env.FIXTURE_USERDATA, 'composed-backend'), process.env.FIXTURE_COMPOSED_BACKEND, emit)
    : null
  const port = await startBroker()
  const keys = genKeyPair()
  const approveAfter = Number(process.env.FIXTURE_APPROVE_AFTER_MS ?? '0')
  // "Deny" on the desktop: standing-host.ts removes the pooled session, which closes it.
  const rejectAfter = Number(process.env.FIXTURE_REJECT_AFTER_MS ?? '-1')
  // The standing host's SILENT decision (standing-host.ts onPeerReady: the pin store read and, for a
  // paired phone it has not pinned yet, the late pin, A07-late) takes this long, and is handed to
  // connectHostSession as the promise it returns, as standing-host.ts does. FIXTURE_DECIDE=approve
  // approves when it settles (a pinned key, or a pairing that recorded it); anything else settles
  // without approving, which is the dialog's case (FIXTURE_APPROVE_AFTER_MS then stands for the
  // human). Unset: onPeerReady decides nothing and returns nothing, as before.
  const decideAfter = Number(process.env.FIXTURE_DECIDE_AFTER_MS ?? '-1')
  const decideApproves = process.env.FIXTURE_DECIDE === 'approve'
  // A snapshot over the 256 KB chunk size, made of 3-byte code points so a chunk boundary splits
  // one: the reassembler must join BYTES before decoding.
  const bigSnapshot = 'SNAP-' + '€'.repeat(100_000) + '-END'
  let sinks: DetachedSinks | null = null
  let sessionCounter = 0

  let releaseScroll: (() => void) | null = null
  let firstScroll = true
  let historyCalls = 0
  const holdScroll = process.env.FIXTURE_HISTORY_HOLD === '1'
  const pty: HostPtyManager = {
    async scrollAttached(clientId, sessionId, up, lines, capture, current) {
      historyCalls++
      emit({ event: 'scrollAttached', sessionId, up, lines, capture })
      if (!current()) return { status: 'refused', message: 'This terminal is no longer attached.' }
      const outcome = process.env.FIXTURE_HISTORY_RESULT
      if (outcome === 'refused' || outcome === 'uncertain') return { status: outcome, message: 'Explicit history fixture ' + outcome }
      if (alternative) {
        const result = await alternative.scroll(up, lines, capture, current)
        if (holdScroll && firstScroll) {
          firstScroll = false
          await new Promise<void>(resolve => { releaseScroll = resolve; emit({ event: 'history-scroll-held' }) })
        }
        return result
      }
      // Explicit ordinary tmux recorder. Native tests above use actual backend/emulator code.
      for (let i = 0; i < lines; i++) pty.write(clientId, sessionId, `\x1b[<${up ? 64 : 65};1;1M`)
      return { status: 'input' }
    },
    async submitComposed(sessionId, input, current) {
      emit({ event: 'submitComposed', sessionId, input })
      if (!current()) return { status: 'refused', message: 'This terminal is no longer attached.' }
      if (alternative) return alternative.submit(input, current)
      if (process.env.FIXTURE_COMPOSED_INPUT === 'refused') return { status: 'refused', message: 'The fixture pane changed.' }
      if (process.env.FIXTURE_COMPOSED_INPUT === 'uncertain') return { status: 'uncertain', message: 'The fixture acknowledgment was lost.' }
      return { status: 'delivered' }
    },
    async historySearch(sessionId, query) {
      emit({ event: 'historySearch', sessionId, query })
      return searchTerminalHistory('old.* Ω 😀\n' + 'recent\n'.repeat(500), query)
    },
    createDetached() {
      throw new Error('not used')
    },
    attachDetached(persistKey, s, options) {
      sinks = s
      const id = `sess-${++sessionCounter}`
      emit({ event: 'attach', persistKey, cols: options?.cols, rows: options?.rows, adaptsToSize: s.adaptsToSize, cwd: options?.cwd, accountId: options?.accountId, agentId: options?.agentId, ownerProjectId: options?.ownerProjectId })
      setTimeout(() => s.onData(`hello ${persistKey}\r\n`), 20)
      return id
    },
    async captureSnapshot(persistKey) {
      return persistKey === 'term-big-1' ? bigSnapshot : `screen of ${persistKey}`
    },
    async sessionExists(persistKey) {
      // `term-slow-*`: the host is still deciding when the phone gives up on the attach (A40). The
      // request has arrived (and the host has reserved the stream) once `probe` is emitted.
      if (persistKey.startsWith('term-slow-')) {
        emit({ event: 'probe', persistKey })
        await new Promise((r) => setTimeout(r, 300))
      }
      return !persistKey.startsWith('term-new-')
    },
    write(clientId, sessionId, data) {
      emit({ event: 'write', sessionId, data })
      if (data === 'exit\r') sinks?.onExit(7)
      else sinks?.onData(`echo:${data}`)
    },
    resize(clientId, sessionId, cols, rows) {
      emit({ event: 'resize', sessionId, cols, rows })
      if (cols === 100) sinks?.onSize?.({ cols: 132, rows: 43 })
    },
    setFlow() {},
    kill(clientId, sessionId) {
      emit({ event: 'kill', sessionId })
      alternative?.close()
    },
    // A12 for nodes of the desktop's SSH projects (`remoteNodes` below): the keys typed on THAT host
    // over its master (PtyManager.backgroundWriteOver). A node id containing `gone` stands for a
    // session the host does not have.
    async backgroundWriteOver(persistKey, data, sshRemote) {
      emit({ event: 'sendKeysOver', nodeId: persistKey, keys: data, controlPath: sshRemote.controlPath })
      return !persistKey.includes('gone')
    }
  }
  if (process.env.FIXTURE_COMPOSED_INPUT === 'unsupported') delete pty.submitComposed
  if (process.env.FIXTURE_HISTORY_SCROLL === 'unsupported') delete pty.scrollAttached
  if (process.env.FIXTURE_HISTORY_ADVERTISE_FALSE === '1') {
    // Explicit negotiation seam: the actual attach response omits the capability once, while
    // the recorder route remains observable if a broken client sends an unadvertised RPC.
    const route = pty.scrollAttached
    let read = 0
    Object.defineProperty(pty, 'scrollAttached', { configurable: true,
      get: () => ++read === 1 ? undefined : route })
  }

  // Explicit test-only control channel; product traffic still crosses the actual E2EE handlers.
  if (process.env.FIXTURE_HISTORY_SCROLL || holdScroll || process.env.FIXTURE_HISTORY_ADVERTISE_FALSE === '1') {
    let controls = Promise.resolve()
    createInterface({ input: process.stdin }).on('line', line => {
      controls = controls.then(async () => {
        if (line === 'history-state') emit({ event: 'history-state', calls: historyCalls })
        else if (line === 'history-release') {
          if (!releaseScroll) throw new Error('No held history fixture response')
          const release = releaseScroll; releaseScroll = null; release()
        } else if (alternative) await alternative.control(line)
        else throw new Error('No native history fixture backend')
        emit({ event: 'history-control-done', command: line })
      }).catch(() => emit({ event: 'fatal', message: 'History fixture control failed' }))
    })
  }


  const store = await seedDesktopState()
  // The folder the WorkspaceStore just wrote the project file into (`project.cwd` in projects.list).
  const [projectDir] = store.localProjectCwds()
  if (!projectDir) throw new Error('the seeded workspace has no local project folder')
  seedGitRepo(projectDir)

  let session: HostSession | null = null
  const approveNow = (): void => {
    if (session && !session.isApproved()) {
      session.approve()
      emit({ event: 'approved' })
    }
  }
  session = connectHostSession({
    url: `ws://127.0.0.1:${port}`,
    token: 'host-room',
    ourKeys: keys,
    pty,
    getLatestCanvas: () => null,
    subscribeCanvas: () => () => {},
    applyMutation: () => {},
    // The desktop's own assembly (listProjectsOutput in src/main/index.ts calls the same function):
    // the store's read-only load, the mirror file, and the session names, between the markers.
    listProjects: () =>
      buildProjectsListBlob({ workspace: store, userDataDir: platform().userDataDir, listSessions: async () => ['nt-term-abc-1'] }),
    // A74-refresh: the `lan` field beside the blob, from the desktop's own reporter (the QR's
    // `pairingNetworkIPv4` over the interfaces, and the sealed answer's host-key reader). The interfaces are
    // the test's (FIXTURE_LAN_ADDRESS, as a Wi-Fi adapter beside loopback), never this machine's, and
    // the host keys/config Include root come from FIXTURE_SSH_HOST_KEY_DIR or a dir that does not
    // exist, never /etc. PairingInteropTest also lays out recursive external Includes under scratch.
    // `FIXTURE_NO_LAN=1` stands for a desktop that predates the field.
    ...(process.env.FIXTURE_NO_LAN === '1'
      ? {}
      : {
          lanReport: createHostLanReporter({
            platform: 'linux',
            interfaces: () => ({
              lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
              ...(process.env.FIXTURE_LAN_ADDRESS
                ? { wlan0: [{ address: process.env.FIXTURE_LAN_ADDRESS, family: 'IPv4', internal: false }] }
                : {})
            }),
            sshHostKeyDirs: [process.env.FIXTURE_SSH_HOST_KEY_DIR || path.join(platform().userDataDir, 'no-ssh-host-keys')]
          })
        }),
    // A viewer on a node is an Eco shield and a size ceiling on the desktop (A18): the phone must
    // never leave one behind.
    remoteViewer: {
      attached: (nodeId) => emit({ event: 'viewer-attached', nodeId }),
      detached: (nodeId) => emit({ event: 'viewer-detached', nodeId })
    },
    // A29: the git bridge both phone hosts serve (`hostBridge.git` in src/main/index.ts is this same
    // class), jailed like production's: the canvas cwds (none here) plus every local project folder,
    // read from the store exactly as `workspaceRoots` reads it. `FIXTURE_NO_GIT=1` stands for a
    // desktop that serves no git bridge.
    ...(process.env.FIXTURE_NO_GIT === '1' ? {} : { git: new GitService() }),
    extraRoots: () => store.localProjectCwds(),
    registerNode: async (projectId, node) => {
      emit({ event: 'registerNode', projectId, node })
      return true
    },
    destroyNode: async (nodeId) => {
      emit({ event: 'destroyNode', nodeId })
    },
    nodeActions: {
      wake: (nodeId) => (emit({ event: 'wake', nodeId }), true),
      refresh: (nodeId) => (emit({ event: 'refresh', nodeId }), true),
      rename: (nodeId, title) => (emit({ event: 'rename', nodeId, title }), true),
      // A12. `FIXTURE_NO_SENDKEYS=1` stands for a desktop that predates the verb; a node id
      // containing `gone` stands for a session the background write could not reach.
      ...(process.env.FIXTURE_NO_SENDKEYS === '1'
        ? {}
        : { sendKeys: async (nodeId: string, keys: string) => (emit({ event: 'sendKeys', nodeId, keys }), !nodeId.includes('gone')) })
    },
    kanban: {
      ensureBoard: async (projectId) => (emit({ event: 'ensureBoard', projectId }), [{ id: 'c1', title: 'To Do', color: '#0a84ff' }]),
      setCardColumn: async (projectId, nodeId, columnId) => (emit({ event: 'setCardColumn', projectId, nodeId, columnId }), true),
      editCardLabels: async (projectId, nodeId, edit) => (
        emit({ event: 'editCardLabels', projectId, nodeId, edit }),
        { edited: true, labels: [{ id: 'l1', name: 'bug', color: 'red' as const }], cardLabelIds: ['l1'] }
      )
    },
    inbox: {
      // A pendingId ending in `-expired` stands for a hold that already ended (the real writer finds
      // no request file and answers `gone`, audit A06).
      answerPermission: async (nodeId, pendingId, decision, suggestionIndex) => (
        emit({ event: 'answer', nodeId, pendingId, decision, ...(suggestionIndex !== undefined ? { suggestionIndex } : {}) }), pendingId.endsWith('-expired') ? 'gone' : 'sent'
      ),
      ...(process.env.FIXTURE_NO_STRUCTURED_QUESTIONS === '1' ? {} : { answerQuestion: async (nodeId: string, pendingId: string, selections: number[][]): Promise<'gone' | 'sent'> => (
        emit({ event: 'question-answer', nodeId, pendingId, selections }), pendingId.endsWith('-expired') ? 'gone' : 'sent'
      ) }),
      ackRead: (nodeId) => emit({ event: 'ack', nodeId })
    },
    // A09/A12: which nodes belong to one of the desktop's SSH projects. `ssh-*` ids do, reached over
    // a connected master; `ssh-offline-*` ones belong to a project whose master is down. Every other
    // id is local, as before.
    remoteNodes: {
      resolve: (nodeId) => {
        if (!nodeId.startsWith('ssh-')) return null
        if (nodeId.startsWith('ssh-offline-')) return { where: 'me@box' }
        return { where: 'me@box', sshRemote: { controlPath: '/cm/box.sock', conn: { host: 'box', user: 'me' }, remoteCwd: '~/repo' } }
      }
    },
    // A33/A72: the desktop's REAL resolver decides what a phone-started session is created with —
    // folder, account, agent and pane owner — over a fake index (local folder project p1) and one
    // logged-in managed Claude account. Kept apart from the store behind `projects.list` on purpose:
    // the fixed `/repo` lets RelayInteropTest assert the folder without knowing the scratch dir.
    newSessions: createHostNewSessions({
      projectTargetInfo: (projectId) => (projectId === 'p1' ? { cwd: '/repo' } : null),
      claudeAccounts: () => [{ id: 'acct-1' }]
    }),
    onPeerReady: (s) => {
      emit({ event: 'peer-ready', sas: s.sas(), pub: s.peerPublicKeyB64() })
      if (approveAfter >= 0) setTimeout(approveNow, approveAfter)
      if (rejectAfter >= 0) setTimeout(() => (emit({ event: 'rejected' }), session?.close()), rejectAfter)
      if (decideAfter < 0) return
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          if (decideApproves) approveNow()
          emit({ event: 'decided', approved: decideApproves })
          resolve()
        }, decideAfter)
      )
    },
    onClose: () => emit({ event: 'host-close' })
  })

  emit({ ready: true, relayUrl: `ws://127.0.0.1:${port}`, clientToken: 'client-room', hostPublicKeyB64: publicKeyToB64(keys.publicKey) })
}

// ---- mode "pair" -----------------------------------------------------------------------------------

async function runPair(): Promise<void> {
  // Test seam: the OS as the fixture and the pairing service see it. Both read `process.platform` at
  // call time; node's own modules captured the real one at startup and are unaffected. Lets a Linux
  // run check what a Windows run of this mode does (PairingInteropTest, audit A70).
  const asPlatform = process.env.FIXTURE_PROCESS_PLATFORM
  if (asPlatform) Object.defineProperty(process, 'platform', { value: asPlatform })
  // The service writes `.nodeterm/agent.json` (a device entry carrying a live bearer token) and
  // `.ssh/authorized_keys` under `os.homedir()`, which reads HOME on POSIX and USERPROFILE on Windows.
  // Refuse to start unless the caller named that dir as its scratch home, so a caller that set the
  // wrong variable fails here instead of pairing a test device into a real profile (audit A70).
  const scratch = process.env.FIXTURE_HOME
  if (!scratch || path.resolve(os.homedir()) !== path.resolve(scratch)) {
    throw new Error(`pair mode needs os.homedir() to be FIXTURE_HOME; it is ${os.homedir()}, FIXTURE_HOME is ${scratch ?? 'unset'}`)
  }
  const keys = genKeyPair()
  const api = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      emit({ event: 'api', path: req.url, body: JSON.parse(body || '{}') })
      if (req.url === '/v1/relay/device') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ deviceToken: 'device-token-xyz', hostId: 'minted-host-id', exp: 123 }))
      } else {
        res.writeHead(404).end()
      }
    })
  })
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
  const apiPort = (api.address() as { port: number }).port
  const withRelay = process.env.FIXTURE_RELAY === '1'
  const service = createPairingService(
    {
      getSettings: () => ({ ...DEFAULT_SETTINGS, phoneAccessEnabled: withRelay }),
      getEntitlement: () => null,
      loadHostKeyPair: async () => keys,
      relayEndpoint: 'wss://relay.example.test',
      apiBase: `http://127.0.0.1:${apiPort}`,
      relayAllowed: () => withRelay,
      pinRelayKey: async (pub) => emit({ event: 'pin', pub }),
      revokeRelayKey: async (pub) => (emit({ event: 'revoke-relay-key', pub }), { persisted: true, killed: true }),
      // A07-late. index.ts asks `stillPaired` inside the pin store's queue (pinApprovedDeviceIf, which
      // reads Electron's userData and is vitest's to cover); what this mode checks is the service's
      // own half: the key the phone sent is recorded, recognized later, and forgotten on revoke.
      pinRelayKeyIfPaired: async (pub, stillPaired) => {
        const paired = await stillPaired()
        if (paired) emit({ event: 'late-pin', pub })
        return paired
      }
    },
    // The direct-SSH path on every OS (audit A70): on win32 the service pairs relay-only (no key, the
    // QR says `ssh:false`), which pairing-service.windows.test.ts covers. `platform` only separates
    // win32 from the rest, so Linux and macOS run exactly what they always did.
    {
      timeoutMs: 60_000,
      platform: process.platform === 'win32' ? 'linux' : process.platform,
      sshHostKeyDirs: [process.env.FIXTURE_SSH_HOST_KEY_DIR || path.join(scratch, 'no-ssh-host-keys')]
    }
  )
  // A07-late: after a pairing, ask the service what the standing host asks on a relay handshake from
  // each of these keys (the phone's own and a stranger's, chosen by the test), then revoke every
  // device and ask again.
  const lateKeys = (process.env.FIXTURE_LATE_PIN_KEYS ?? '').split(',').filter(Boolean)
  const askLate = async (when: string): Promise<void> => {
    for (const pub of lateKeys) emit({ event: 'late-approval', when, pub, approved: await service.approvePairedRelayKey(pub) })
  }
  const started = await service.start((done) => {
    emit({ event: 'done', ...done })
    if (!done.ok || !lateKeys.length) return
    void (async () => {
      await askLate('paired')
      for (const device of await service.listDevices()) await service.revokeDevice(device.id)
      await askLate('revoked')
    })().catch((err) => emit({ event: 'fatal', message: String((err as Error)?.stack ?? err) }))
  })
  emit({ ready: true, payload: started.payload, hostPublicKeyB64: publicKeyToB64(keys.publicKey), relayPlan: started.relayPlan })
}

/** Actual sealed legacy pairing, approved E2EE session, guarded writer and exact revoker. The
 * public pin-store adapter and human SAS decision are explicit in-memory fixture boundaries. */
async function runLegacyPairing(): Promise<void> {
  const scratch = process.env.FIXTURE_HOME
  if (!scratch || path.resolve(os.homedir()) !== path.resolve(scratch) ||
      path.resolve(platform().userDataDir) !== path.resolve(scratch)) throw new Error('legacy pairing requires one scratch home/profile')
  const keys = genKeyPair()
  const port = await startBroker()
  const endpoint = `ws://127.0.0.1:${port}`
  let pins = emptyApprovedDevices()
  const sessions = new Map<string, HostSession>()
  const killed: string[] = []
  const revoker = createRevoker({
    load: async () => pins,
    save: async next => { pins = next },
    onRevoke: key => {
      killed.push(key)
      for (const session of sessions.values()) if (session.peerPublicKeyB64() === key) session.close()
    }
  })
  const api = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url !== '/v1/relay/device') { res.writeHead(404).end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ deviceToken: 'inert-legacy-device-token', hostId: 'legacy-fixture-host', exp: 123 }))
    })
  })
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  const apiPort = (api.address() as { port: number }).port
  const service = createPairingService({
    getSettings: () => ({ ...DEFAULT_SETTINGS, phoneAccessEnabled: true }),
    getEntitlement: () => null, loadHostKeyPair: async () => keys,
    relayEndpoint: endpoint, apiBase: `http://127.0.0.1:${apiPort}`, relayAllowed: () => true,
    pinRelayKey: async key => { pins = pinDevice(pins, key) },
    revokeRelayKey: key => revoker.revoke(key)
  }, { timeoutMs: 60_000, platform: 'linux', sshHostKeyDirs: [path.join(scratch, 'no-public-host-keys')],
    interfaces: () => ({ fixture: [{ address: '10.23.45.67', family: 'IPv4', internal: false }] }) })
  const store = await seedDesktopState()
  const legacyRelayPairings = process.env.FIXTURE_LEGACY_CLOSE_DURING_PROOF === '1' ? {
    ...service.legacyRelayPairings,
    inspect: async (pairingId: string, peerKey: string) => {
      const found = await service.legacyRelayPairings.inspect(pairingId, peerKey)
      sessions.get('subject')?.close()
      emit({ event: 'legacy-mid-proof-close' })
      return found
    }
  } : service.legacyRelayPairings
  for (const room of ['subject', 'other']) {
    const session = connectHostSession({
      ...(process.env.FIXTURE_LEGACY_UNSUPPORTED === '1' ? {} : { legacyRelayPairings }),
      url: endpoint, token: `host-${room}`, ourKeys: keys,
      pty: {
        createDetached() { throw new Error('no terminal is created in this fixture') },
        attachDetached() { throw new Error('no terminal is attached in this fixture') },
        captureSnapshot: async () => '', sessionExists: async () => false,
        write() { throw new Error('no terminal input is allowed') }, resize() {}, setFlow() {}, kill() {}
      },
      getLatestCanvas: () => null, subscribeCanvas: () => () => {}, applyMutation() {},
      listProjects: () => buildProjectsListBlob({ workspace: store, userDataDir: scratch, listSessions: async () => [] }),
      onPeerReady: session => {
        const peer = session.peerPublicKeyB64()
        if (!peer) throw new Error('a handshake must identify its peer')
        if (isPinned(pins, peer) || (room === 'subject' && process.env.FIXTURE_LEGACY_APPROVE !== '0')) {
          // This is the fixture's explicit human decision, never an association-based approval.
          const approve = (): void => { pins = pinDevice(pins, peer); session.approve() }
          const delay = Number(process.env.FIXTURE_LEGACY_APPROVE_AFTER_MS ?? '0')
          if (room === 'subject' && !isPinned(pins, peer) && delay > 0) setTimeout(approve, delay)
          else approve()
        }
        emit({ event: 'legacy-peer', room, approved: session.isApproved(), key: peer })
      },
      onClose: () => emit({ event: 'legacy-close', room })
    })
    sessions.set(room, session)
  }
  const state = async (): Promise<void> => {
    const obj: { devices: Array<{ id: string; relayBoxKey?: string }> } = JSON.parse(
      await fs.promises.readFile(path.join(scratch, '.nodeterm/agent.json'), 'utf8'))
    emit({ event: 'legacy-state', devices: obj.devices.map(({ id, relayBoxKey }) => ({ id, relayBoxKey })),
      pins: pins.pubkeys, killed, live: [...sessions].map(([room, session]) => ({ room, approved: session.isApproved() })) })
  }
  const pair = () => service.start(done => emit({ event: 'legacy-paired', ...done }))
  let tail = Promise.resolve()
  createInterface({ input: process.stdin }).on('line', line => {
    tail = tail.then(async () => {
      if (line === 'start-pair') emit({ event: 'legacy-pair-ready', payload: (await pair()).payload })
      else if (line === 'state') await state()
      else if (/^revoke:[0-9a-f-]{36}$/.test(line)) {
        emit({ event: 'legacy-revoked', result: await service.revokeDevice(line.slice(7)) })
        await state()
      } else throw new Error('unknown fixture command')
    }).catch(() => emit({ event: 'fatal', message: 'legacy fixture command failed' }))
  })
  emit({ ready: true, payload: (await pair()).payload, relayUrl: endpoint, hostPublicKeyB64: publicKeyToB64(keys.publicKey) })
}

/** No sockets: real mirror producer and desktop command assembler checked by the Kotlin client. */
async function runLaunchParity(): Promise<void> {
  const codexApprovalValues = codexApprovalValuesFrom(process.env.FIXTURE_CODEX_HELP)
  const autoSupported = process.env.FIXTURE_CLAUDE_AUTO === 'true'
  const store = await seedDesktopState({ autoSupported, ...(codexApprovalValues ? { codexApprovalValues } : {}) })
  const blob = await buildProjectsListBlob({ workspace: store, userDataDir: platform().userDataDir, listSessions: async () => [] })
  const commands = Object.entries(AGENT_CONFIG).flatMap(([agentId]) => ALL_PERMISSION_MODES.map((mode) => {
    const permissionMode = agentId === 'claude' ? gatePermissionMode(mode, autoSupported) : mode
    const facts = { agentId, permissionMode, approvalCaps: { codexApprovalValues }, sharedIdentity: false }
    return {
      agent: agentId, mode,
      launch: assembleLaunchCommand(facts, {}).command,
      resume: assembleResumeCommand({ ...facts, sessionId: 'interop-session' }, {}).command
    }
  }))
  emit({ ready: true, blob, commands })
}

/** No sockets: these are production wire producers; only the kernel's interface table is fake. */
async function runPairingNetwork(): Promise<void> {
  const userData = process.env.FIXTURE_USERDATA
  if (!userData) throw new Error('pairing-network needs FIXTURE_USERDATA (a scratch dir)')
  const ipv4 = (address: string): { address: string; family: string; internal: boolean } =>
    ({ address, family: 'IPv4', internal: false })
  // Docker and VPN deliberately precede the physical adapter in the kernel's enumeration.
  const base: PairingInterfaces = {
    docker0: [ipv4('172.17.0.1')], wg0: [ipv4('10.7.0.2')],
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wlan0: [ipv4('192.168.1.42')]
  }
  let interfaces = base
  let selected = 'wlan0'
  // The real desktop injects the same fresh settings getter into pairing and this reporter.
  // Reuse ONE reporter while the table and selection change, so a captured initial value fails.
  const report = createHostLanReporter({
    platform: 'linux', interfaces: () => interfaces, getPairingInterface: () => selected,
    sshHostKeyDirs: [process.env.FIXTURE_SSH_HOST_KEY_DIR || path.join(userData, 'no-ssh-host-keys')]
  })
  const keys = genKeyPair()
  const hostKey = publicKeyToB64(keys.publicKey)
  const cases: { name: string; payload: string | null; lan: Awaited<ReturnType<typeof report>>; choices: ReturnType<typeof pairingNetworkChoices> }[] = []
  const capture = async (name: string): Promise<void> => {
    const host = pairingNetworkIPv4(interfaces, selected)
    cases.push({
      name,
      payload: host ? buildPairingPayload({ host, user: 'fixture', token: 'fixture-pair-token',
        pairPort: 23456, name: 'Adapter fixture', hostKey,
        relay: { hostId: 'fixture-relay-host', hostPublicKeyB64: hostKey, relayEndpoint: 'wss://relay.example.test' }
      }) : null,
      lan: await report(), choices: pairingNetworkChoices(interfaces)
    })
  }
  await capture('selected')
  interfaces = { ...base, wlan0: [ipv4('192.168.1.77')] }
  await capture('dhcp-moved')
  interfaces = { docker0: base.docker0, wg0: base.wg0, lo: base.lo }
  await capture('selected-missing')
  selected = 'wg0'
  await capture('selection-changed')
  interfaces = base
  selected = ''
  await capture('automatic-physical')
  interfaces = { wg0: base.wg0 }
  await capture('automatic-virtual-only')
  // Windows has a relay-only pairing payload. Its OS default-route hint is accepted only when it
  // is a current eligible address; an explicit adapter still takes precedence over that hint.
  const multiple = { ...base, wlan0: [ipv4('192.168.1.42'), ipv4('192.168.1.99')] }
  const windowsPayload = (selection: string, route: string): string => {
    const host = pairingNetworkIPv4(multiple, selection, route)
    if (!host) throw new Error('fixture has no eligible route')
    return buildPairingPayload({ host, user: 'fixture', token: 'fixture-pair-token', pairPort: 23456,
      name: 'Windows adapter fixture', hostKey, ssh: false,
      relay: { hostId: 'fixture-relay-host', hostPublicKeyB64: hostKey, relayEndpoint: 'wss://relay.example.test' }
    })
  }
  emit({ ready: true, cases,
    windows: { currentRoute: windowsPayload('', '192.168.1.99'), staleRoute: windowsPayload('', '203.0.113.8'),
      explicitAdapter: windowsPayload('wg0', '192.168.1.99'),
      lan: await createHostLanReporter({ platform: 'win32', interfaces: () => multiple, getPairingInterface: () => 'wg0',
        sshHostKeyDirs: [process.env.FIXTURE_SSH_HOST_KEY_DIR || path.join(userData, 'no-ssh-host-keys')] })() }
  })
}

const mode = process.argv[2]
if (mode === 'never-ready') {
  setInterval(() => {}, 60_000)
} else if (mode !== 'project-launch') {
  ;(mode === 'pair' ? runPair() : mode === 'legacy-pairing' ? runLegacyPairing() : mode === 'ack-sweep' ? runAckSweep() : mode === 'launch-parity' ? runLaunchParity() : mode === 'pairing-network' ? runPairingNetwork() : runRelay()).catch((err) => {
    emit({ event: 'fatal', message: String((err as Error)?.stack ?? err) })
    process.exit(1)
  })
}
