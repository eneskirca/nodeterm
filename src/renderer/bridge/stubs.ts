// Graceful non-terminal stub surface for the browser (Server Edition) build.
//
// The real namespaces (`pty`, `workspace`, `settings`, `speech`, the fs/git/files/context group
// from `buildFilesApi`, and `dialog` from the in-app `dialog-picker`) are provided by the
// ws-bridge; everything else here degrades benignly so the renderer boots without a full
// Electron preload.
// The exact per-member behavior is the boot-path contract encoded in the Task 7 brief (derived
// from a full renderer-boot audit): every `on*` subscription MUST return a callable no-op
// unsubscribe (the renderer uses the return value as a React effect cleanup — a missing member or
// a non-function return is a mount crash), promise members that the boot path awaits resolve to a
// benign value, and everything else rejects with a coded error.
//
// The object is `satisfies Omit<NodeTerminalApi, 'pty' | 'workspace' | 'settings' | 'fs' | 'git'
// | 'files' | 'context' | 'boardLog' | 'logs' | 'dialog'>`, so the TypeScript compiler is the completeness test: if
// `NodeTerminalApi` gains a member, this file fails to typecheck until the stub is declared.

import {
  UNKNOWN_CLAUDE_CLI_CAPS,
  UNKNOWN_CODEX_IDENTITY_CAPS,
  type ClaudeUsage,
  type NodeTerminalApi,
  type NotifyPayload,
  type UpdatePolicy
} from '../../shared/types'
import { E_UNSUPPORTED } from '../../shared/rpc'

/** Reject with a coded error the RPC layer + renderer recognize (renderer degrades silently). */
export function unsupported(name: string): Promise<never> {
  return Promise.reject(
    Object.assign(new Error(`${name} is not supported in the browser build`), {
      code: E_UNSUPPORTED
    })
  )
}

/** A subscription stub: ignores its listener, returns a no-op unsubscribe. */
export const noopUnsub: () => () => void = () => () => {}

// Per-member helpers. Each returned function ignores its arguments, so it is assignable to the
// real (more-specific) member signature while `satisfies` still enforces the member exists.
/** Promise member that is unavailable on the server. */
const U = (name: string) => (): Promise<never> => unsupported(name)
/** Void (fire-and-forget) member: a synchronous no-op. */
const noop = (): void => {}
/** Promise<void> member: a resolved no-op. */
const pnoop = (): Promise<void> => Promise.resolve()

/** Copy without the Clipboard API (non-secure context): a hidden textarea + execCommand('copy').
 *  Browsers only honor it inside a user gesture. That holds for the copy shortcut and the click-
 *  driven copy buttons, but NOT for the OSC 52 path (`TerminalNode.tsx` — driven by terminal
 *  OUTPUT, e.g. `vim "+y`, with no user activation): over plain http that one always fails and
 *  lands in the error banner below. Returns false when the copy fails, so the caller surfaces it
 *  rather than swallowing it — never silent.
 *
 *  Cleanup is in a `finally` on purpose: `select()`/`execCommand()` CAN throw (Firefox has thrown
 *  NS_ERROR_FAILURE on execCommand('copy')), and a leaked scratch textarea would be invisible,
 *  focused and `position:fixed` — i.e. it would swallow every subsequent keystroke. `select()` also
 *  steals focus from xterm's helper textarea, so the previously-focused element is restored too
 *  (the terminal's *selection* survives on its own — xterm paints it, it is not a DOM Selection). */
function copyViaExecCommand(text: string): boolean {
  const prev = document.activeElement as HTMLElement | null
  let ta: HTMLTextAreaElement | undefined
  try {
    ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    if (!document.execCommand('copy')) throw new Error('execCommand returned false')
    return true
  } catch {
    // Surfacing beats silence: the user needs to know why nothing landed in their clipboard. The
    // diagnosis differs — plain http has no Clipboard API at all, while in a secure context we got
    // here because the API rejected (permission denied / document not focused) AND the fallback
    // failed too. Canvas listens for this event and shows a banner.
    // This module only ever runs in a browser (it IS the browser shim), so `window` is there —
    // guarded consistently rather than half-guarded.
    const secure = window.isSecureContext
    window.dispatchEvent(
      new CustomEvent('nodeterm:toast', {
        detail: {
          kind: 'error',
          message: secure
            ? 'Copy failed — the browser denied clipboard access. Click the page and try again.'
            : 'Copy failed — the browser blocks clipboard access over plain http. Use https or localhost.'
        }
      })
    )
    return false
  } finally {
    // A throw in here would ESCAPE the function and replace the return value (a `finally` outranks
    // both the `return true` and the `return false` above) — so cleanup can never be allowed to
    // throw: `prev.focus()` on an exotic element is out of our control.
    try {
      ta?.remove()
      prev?.focus?.()
    } catch {
      // Cleanup is best-effort; the copy's outcome is what the caller must see.
    }
  }
}

export function buildStubApi(): Omit<
  NodeTerminalApi,
  | 'pty'
  | 'workspace'
  | 'settings'
  | 'fs'
  | 'git'
  | 'files'
  | 'context'
  | 'boardLog'
  | 'logs'
  | 'githubIssues'
  | 'githubControl'
  | 'canvas'
  | 'dialog'
  | 'onAgentStatus'
  | 'agentStatusSnapshot'
  | 'onSubagentActivity'
  | 'onUnreadClear'
  | 'answerPermission'
  | 'ackDone'
  // Real over the bridge (IPC.appUserDataDir): the worktree dialog's default path is derived from
  // it, and a '' stub would propose `/worktrees/…` at the filesystem root.
  | 'userDataDir'
  | 'presence'
  | 'speech'
> {
  const api = {
    ssh: {
      list: U('ssh.list'),
      save: U('ssh.save'),
      remove: U('ssh.remove'),
      importCandidates: U('ssh.importCandidates')
    },
    sshProject: {
      connect: U('sshProject.connect'),
      disconnect: U('sshProject.disconnect'),
      killSessions: U('sshProject.killSessions'),
      listDir: U('sshProject.listDir'),
      mkdir: U('sshProject.mkdir'),
      uploadFile: U('sshProject.uploadFile'),
      downloadFile: U('sshProject.downloadFile'),
      onStatus: noopUnsub,
      submitPassphrase: U('sshProject.submitPassphrase'),
      onPassphraseRequest: noopUnsub,
      onPassphraseDismiss: noopUnsub
    },
    sshFs: {
      list: U('sshFs.list'),
      read: U('sshFs.read'),
      readBinary: U('sshFs.readBinary'),
      write: U('sshFs.write'),
      mkdir: U('sshFs.mkdir'),
      exists: U('sshFs.exists'),
      quickOpen: U('sshFs.quickOpen')
    },
    clipboard: {
      // Clipboard API → execCommand → visible error. `navigator.clipboard` only exists in a SECURE
      // context (https or localhost); over plain http on a LAN it is undefined, and the old
      // optional-chained call copied nothing and told nobody. execCommand('copy') is deprecated but
      // is the only thing that works there.
      writeText: (text: string): void => {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          void navigator.clipboard.writeText(text).catch(() => copyViaExecCommand(text))
          return
        }
        copyViaExecCommand(text)
      },
      // A browser cannot place host-local file references on the viewer's OS clipboard.
      writeFiles: async (): Promise<boolean> => false
    },
    shell: {
      // no filesystem-reveal in a browser; intentionally inert (see docs/SERVER.md)
      reveal: noop,
      // no OS default-app open in a browser; intentionally inert (see docs/SERVER.md)
      openPath: noop,
      // The one browser-native member: open the URL in a new tab.
      openExternal: (url: string): void => {
        window.open(url, '_blank', 'noopener')
      },
      // Picking + re-encoding an icon needs the main process (native dialog + sharp); a browser
      // client has neither, so this degrades to "cancelled" rather than opening anything.
      pickProjectIcon: async () => null
    },
    media: {
      allow: U('media.allow'),
      // Deliberate graceful degrade: the remote-media cache lives on the DESKTOP shell (scp over
      // the project's ControlMaster). Resolve a typed refusal instead of rejecting so the
      // VideoNode shows the reason rather than a generic load failure.
      allowSsh: (): Promise<{ ok: false; error: string }> =>
        Promise.resolve({ ok: false, error: 'Playing videos from an SSH host is not available in the browser.' }),
      writeHtml: U('media.writeHtml')
    },
    browser: {
      register: noop,
      unregister: noop,
      onBrowserNewWindow: noopUnsub,
      // Browser control does not exist off the desktop shell (no <webview>, no CDP), so there is no
      // lease to push and nothing to stop — the chip simply never appears.
      onLeaseChanged: noopUnsub,
      stop: noop,
      stopAll: noop,
      stopProject: noop
    },
    updates: {
      onAvailable: noopUnsub,
      onDownloaded: noopUnsub,
      onProgress: noopUnsub,
      onError: noopUnsub,
      onNotAvailable: noopUnsub,
      check: noop,
      getVersion: U('updates.getVersion'),
      // Boot path awaits this and reads `p.mandatory` UNGUARDED (UpdateCard.tsx), so the old
      // `null as unknown as UpdatePolicy` — a cast that also defeats this file's `satisfies`
      // completeness gate — threw a TypeError on every Server Edition page load. There is no
      // server handler for the update policy (the browser cannot self-install anyway), so the
      // honest answer is the shape's own "no policy" value: nothing mandatory, no minimum.
      getPolicy: (): Promise<UpdatePolicy> => Promise.resolve({ minSupported: null, mandatory: false }),
      restart: noop
    },
    announcements: {
      fetch: () => Promise.resolve([])
    },
    license: {
      upgrade: U('license.upgrade'),
      activate: U('license.activate'),
      deactivate: U('license.deactivate'),
      // Renderer has no catch here and silently degrades to the free tier on rejection.
      getStatus: U('license.getStatus'),
      // Server Edition has no license layer at all (initLicense runs only in src/main), so these
      // reject rather than answer a fabricated "0 devices" — the same degrade as getStatus above.
      detail: U('license.detail'),
      releaseOthers: U('license.releaseOthers'),
      onChange: noopUnsub
    },
    contextLink: {
      setLinks: pnoop,
      info: U('contextLink.info')
    },
    usage: {
      // Superseded by the real WS-backed namespace in ws-bridge (the core usage service runs in
      // the server shell too), so nothing reaches these in a live browser session. Kept only to
      // satisfy `satisfies NodeTerminalApi`.
      //
      // The `null as unknown as ClaudeUsage` cast is retained on purpose: the boot path awaits
      // `fetch`, and UsageIndicator treats a null snapshot as "nothing to show" and renders
      // nothing. It still lies about its type — the honest fix is widening `UsageApi.fetch` to
      // `Promise<ClaudeUsage | null>`, a public-API change tracked separately.
      fetch: (): Promise<ClaudeUsage> => Promise.resolve(null as unknown as ClaudeUsage),
      refresh: U('usage.refresh'),
      // Empty, not a reject: "no providers configured" is a real answer and the popover
      // renders it as nothing. This one needs no cast — the honest type already fits.
      providers: () => Promise.resolve([]),
      // Same reasoning as `providers`: "no connected SSH hosts" is a real answer, and it is the
      // permanently correct one on a shell with no SSH projects.
      remote: () => Promise.resolve([]),
      setProviderCookie: U('usage.setProviderCookie'),
      cookieProviders: () => Promise.resolve({}),
      onUpdate: noopUnsub
    },
    sessionMemory: {
      // Superseded by the real WS-backed namespace in ws-bridge (the core session-memory service
      // runs in the server shell too), so nothing reaches these in a live browser session. Kept
      // only to satisfy `satisfies NodeTerminalApi`.
      //
      // Where it DOES stay in force is the relay tab, which shares this stub surface: there the
      // renderer runs on the guest while the sessions live on the host, so answering at all would
      // describe the wrong machine. `ok:false` / `null` are the service's own words for "could not
      // measure" — the one honest answer, and never mistakable for "nothing is using memory".
      read: () => Promise.resolve({ ok: false, rows: [], mem: null }),
      host: () => Promise.resolve(null)
    },
    codex: {
      // Overridden by the real WS-backed namespace in ws-bridge. The stub's answer is the same
      // one the Server Edition gives on purpose (see server/handlers/index.ts): no shared
      // identity, so every Codex launch line stays the bare `codex`.
      identityCaps: () => Promise.resolve(UNKNOWN_CODEX_IDENTITY_CAPS),
      onIdentity: noopUnsub
    },
    claude: {
      // Overridden by the real WS-backed namespace in ws-bridge; the stub still answers with the
      // fail-open caps (never rejects) because the permission-mode gate reads it on the boot path.
      cliCaps: () => Promise.resolve(UNKNOWN_CLAUDE_CLI_CAPS),
      readTranscript: U('claude.readTranscript')
    },
    agent: {
      // No env snapshot outside the desktop window: the stub (and ws-bridge, identically) answers
      // an empty env, so `${env:VAR}` expansion reports every referenced var as missing and the
      // launch/preview paths degrade to the missing-env refusal instead of a host-env dump.
      envSnapshot: () => Promise.resolve({}),
      discoverModels: () => Promise.resolve({ models: [], error: 'Model discovery is unavailable.' }),
      gatewayCredentialStatus: () =>
        Promise.resolve({ hasStoredKey: false, storage: 'unavailable' }),
      saveGatewayCredential: U('agent.saveGatewayCredential'),
      clearGatewayCredential: U('agent.clearGatewayCredential')
    },
    projectSettings: {
      // Overridden by the real WS-backed namespace in ws-bridge (same registerIpc() call as
      // `workspace`); this fallback only matters if some future assembly spreads the stub alone.
      // Fail-closed rather than reject: an unknown/unreachable project reads as "no settings" and
      // a write/update as "did not happen", matching the real handlers' contract for an unknown id.
      read: () => Promise.resolve(null),
      writeShared: () => Promise.resolve(false),
      updateLocal: () => Promise.resolve(false),
      launchInfo: () => Promise.resolve(null),
      onTrustChanged: noopUnsub
    },
    projectSetup: {
      // Same fallback story as `projectSettings` above — real over the bridge
      // (`buildRealApi`'s `projectSetup`); this only matters if some future assembly spreads the
      // stub alone. `run` fails closed with the SAME shape a real "nothing to run" answer uses, so
      // a caller needs no extra branch to handle the stub differently from the real thing.
      run: () => Promise.resolve({ status: 'skipped', reason: 'unavailable' }),
      cancel: () => Promise.resolve(false),
      consent: pnoop,
      // Fails closed, like `run`: no bridge means no way to ask a human, and an unasked question
      // is never an approval.
      requestTrust: () => Promise.resolve(false),
      onConsentRequest: noopUnsub,
      onConsentDismiss: noopUnsub,
      onEvent: noopUnsub
    },
    worktree: {
      // Real over the bridge (`buildRealApi`'s `worktree`); this fallback only matters if some
      // future assembly spreads the stub alone. Fails closed with the SAME empty-result shape a
      // real "nothing was linked" answer uses, so a caller needs no extra branch.
      materializeShared: () => Promise.resolve([])
    },
    chat: {
      readTranscript: U('chat.readTranscript')
    },
    claudeAccounts: {
      add: U('claudeAccounts.add'),
      waitLogin: U('claudeAccounts.waitLogin'),
      cancelWaitLogin: U('claudeAccounts.cancelWaitLogin'),
      remove: U('claudeAccounts.remove')
    },
    codexAccounts: {
      add: U('codexAccounts.add'),
      waitLogin: U('codexAccounts.waitLogin'),
      cancelWaitLogin: U('codexAccounts.cancelWaitLogin'),
      identity: U('codexAccounts.identity'),
      systemIdentity: U('codexAccounts.systemIdentity'),
      remove: U('codexAccounts.remove'),
      switchThread: U('codexAccounts.switchThread'),
      commitSwitch: U('codexAccounts.commitSwitch'),
      finishSwitch: U('codexAccounts.finishSwitch'),
      rollbackSwitch: U('codexAccounts.rollbackSwitch'),
      transferThreadToSsh: U('codexAccounts.transferThreadToSsh')
    },
    transcripts: {
      search: U('transcripts.search')
    },
    remoteHost: {
      start: U('remoteHost.start'),
      stop: U('remoteHost.stop'),
      sendCanvasState: noop,
      onApplyMutation: noopUnsub,
      onPeerPending: noopUnsub,
      onPeerPendingCleared: noopUnsub,
      approve: (_id: string) => {},
      reject: (_id: string) => {},
      setPhoneAccess: noop
    },
    // New relay tunnel (Stage 4). Hosting/connecting a peer-to-peer relay is a desktop-only
    // (Electron) capability — the Server Edition is itself the remote host, reached over its own WS
    // bridge — so the entry points (`start`/`connect`) reject with E_UNSUPPORTED and the UI hides
    // the affordance. Because those never yield a live connection, the gate/frame void members are
    // inert no-ops (there is no connectionId to act on) and the subscriptions are no-op unsubscribes.
    relayHost: {
      start: U('relayHost.start'),
      invite: U('relayHost.invite'),
      stop: U('relayHost.stop'),
      revoke: noop,
      onPeerPending: noopUnsub,
      confirm: noop,
      onOpen: noopUnsub,
      onClosed: noopUnsub
    },
    relayClient: {
      connect: U('relayClient.connect'),
      onSas: noopUnsub,
      confirm: noop,
      onApproved: noopUnsub,
      send: noop,
      onFrame: noopUnsub,
      onClosed: noopUnsub,
      disconnect: noop
    },
    handoff: {
      build: U('handoff.build')
    },
    pairing: {
      start: U('pairing.start'),
      stop: U('pairing.stop'),
      onDone: noopUnsub,
      probeSsh: U('pairing.probeSsh'),
      openRemoteLoginSettings: U('pairing.openRemoteLoginSettings'),
      listDevices: U('pairing.listDevices'),
      revokeDevice: U('pairing.revokeDevice')
    },
    shortcuts: {
      // Deliberate no-op (not a gap): the recording bit exists to stand the DESKTOP's
      // `before-input-event` intercepts down, and a browser tab has no application menu to steal
      // ⌘W/⌘M/⌘0 back from — nothing intercepts here, so there is nothing to suspend. The
      // recorder's own preventDefault/stopPropagation is the whole path in this shell.
      setRecording: noop,
      // Deliberate no-op for the same reason, one step further: the mirror exists so the DESKTOP's
      // intercepts can stand down under `terminal-first`, and there are no intercepts here to
      // stand down. The policy itself still works in the browser — it is enforced by the
      // renderer's own dispatcher (`keyDispatchContextFor`), which reads focus directly.
      setTerminalFocused: noop
    },
    onMarkdownToggle: noopUnsub,
    onCloseNode: noopUnsub,
    // Deliberate no-op (not a gap): a browser tab has no application menu to steal ⌘0, so the
    // renderer's own keydown handler is the whole path there.
    onZoomActualSize: noopUnsub,
    // Native app-menu events (desktop-only — the Server Edition has no native menu). Stubs so the
    // bridge satisfies NodeTerminalApi; the canvas only wires real listeners on desktop.
    onToggleAutoAlign: noopUnsub,
    onFitView: noopUnsub,
    onToggleKanban: noopUnsub,
    onOpenSettings: noopUnsub,
    closeWindow: noop,
    // Best-effort: a browser tab can't force itself frontmost the way the desktop BrowserWindow
    // can, but `window.focus()` still helps when the page is merely blurred (not another OS app).
    focusWindow: () => {
      try {
        window.focus()
      } catch {
        /* focus is a no-op in some embeddings — never throw into a drop handler */
      }
    },
    setBadgeCount: noop,
    // UI scale is page zoom, and a browser page cannot set its own — the browser already owns the
    // identical mechanism (Cmd/Ctrl+±, persisted per site). Intentionally inert; the Settings row
    // is disabled with this reason on the Server Edition (AppearanceSection's browser branch).
    setUiZoomFactor: noop,
    getPathForFile: (): string => '',
    notify: async (payload: NotifyPayload): Promise<'shown' | 'failed' | 'skipped'> => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(payload.title, { body: payload.body })
          return 'shown'
        } catch {
          return 'skipped'
        }
      }
      return 'skipped'
    },
    openNotificationSettings: pnoop,
    onFocusNode: noopUnsub,
    // Server Edition v1: the memory-pressure levers run HOST-side only (the session reaper, driven
    // by the same core monitor in src/server/index.ts). A browser tab's own memory — its WebGL
    // contexts and parked terminals — belongs to the browser, which already discards and reclaims
    // on its own terms; pushing our levers over the wire would fight it, not help it. Deliberate
    // no-op, not an oversight.
    onMemoryPressure: noopUnsub,
    // Same asymmetry, one step further: the desktop's pty-pressure banner exists to offer "Fix
    // automatically…", which ends in macOS's admin-password dialog on the HOST's physical display.
    // A browser tab cannot answer that prompt, so the host keeps the reaper leg and says nothing
    // here (see the note beside createPtyPressureMonitor in src/server/index.ts). The fix itself
    // rejects rather than pretending, so a stray call can never look like it worked.
    onPtyPressure: noopUnsub,
    // A browser tab has no raw input stream to classify — trackpad-vs-mouse ground truth exists
    // only under the Electron shell (main/trackpad-gesture.ts). Never fires here; the canvas
    // wheel router is constructed WITHOUT gesture reporting in this runtime and keeps its
    // delta-shape heuristics, so the degrade is a kept behavior, not a silent gap.
    onCanvasTrackpadGesture: noopUnsub,
    raisePtyDeviceLimit: async () => ({
      ok: false as const,
      error: 'Raising the terminal limit must be done on the machine running the server.'
    }),
    onAgentControl: noopUnsub,
    sendAgentControlResult: noop,
    // Browser control is desktop-only (no <webview>, no CDP on the Server Edition / relay), so the
    // resolve round-trip is inert here — the verb is refused by name before it reaches a handler.
    onBrowserControlResolve: noopUnsub,
    sendBrowserControlResolveResult: noop,
    // Messaging never runs in the browser: `onAgentControl` above is inert here, so no dispatch
    // can ever reach this. It answers the honest terminal refusal all the same, so a stray call
    // can never look like it delivered.
    agentMessage: {
      deliver: async () => ({
        ok: false as const,
        error: 'Agent messaging is only available in the desktop app. Do not retry.'
      })
    }
  } satisfies Omit<
    NodeTerminalApi,
    | 'pty'
    | 'workspace'
    | 'settings'
    | 'fs'
    | 'git'
    | 'files'
    | 'context'
    | 'boardLog'
    | 'logs'
    | 'githubIssues'
    | 'githubControl'
    | 'canvas'
    | 'dialog'
    | 'onAgentStatus'
    | 'agentStatusSnapshot'
    | 'onSubagentActivity'
    | 'onUnreadClear'
    | 'answerPermission'
  | 'ackDone'
    | 'userDataDir'
    | 'presence'
    | 'speech'
  >

  return api
}
