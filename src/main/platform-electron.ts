import { app, ipcMain, safeStorage, shell, webContents } from 'electron'
import type { CorePlatform } from '../core/platform'
import { mainWindowClientIds, sendToMain } from './main-window'
import { peerRegistry } from './peer-registry'
import { HOST_ONLY_REFUSAL, isHostOnlyChannel } from '../shared/host-control'
import { E_NO_HANDLER, type RpcErr, type RpcOk, type RpcRequest } from '../shared/rpc'

type Handler = { fn: (...args: any[]) => unknown; withSender: boolean }
type Listener = { fn: (...args: any[]) => void; withSender: boolean }

/** How often a REFUSED host-control cast may be logged. The refusal itself is unconditional; only
 *  the log line is throttled, because the rate is chosen by the peer: a guest casting in a loop
 *  would otherwise turn the host's log into its own amplifier. One line per window is the whole
 *  diagnostic — that it happened at all. */
const REFUSAL_LOG_INTERVAL_MS = 60_000
let lastRefusalLog = 0

/**
 * The Electron platform, with the two extra members a relay PEER needs (they are deliberately NOT
 * on CorePlatform: the core never dispatches, only the shell that owns the socket does — exactly as
 * attach/detach/dispatch are extras on ServerPlatform).
 */
export interface ElectronPlatform extends CorePlatform {
  /** Answer one peer RPC request from the recorded handler table. The peer's clientId is the
   *  sender, so handleWithSender attributes it correctly. Never rejects: a missing handler is
   *  E_NO_HANDLER and a throwing handler is E_HANDLER, so the peer's `await` always settles. */
  dispatch(clientId: number, req: RpcRequest): Promise<RpcOk | RpcErr>
  /** Fire one peer cast at every listener on that channel, in registration order. */
  cast(clientId: number, method: string, args: unknown[]): void
}

/**
 * The Electron shell's CorePlatform. Getters keep app.getPath lazy (safe pre-ready).
 *
 * A client here is EITHER a webContents (the main window) OR a relay PEER — a phone, or another
 * desktop (4c) — addressed by a UiSink in the peer registry. Everything Stages 1-3 built (presence
 * hub, canvas reflector, terminal co-attach) is already written against CorePlatform and is
 * multi-client; a peer was half-joined only because these three members resolved ids through
 * `webContents.fromId` alone, so every send aimed at one silently no-op'd. Peer ids are minted ≥
 * 1_000_000 (allocateRelayClientId), so they can never collide with a webContents id.
 *
 * SOLO COST: zero. With no peer registered the registry holds an empty Map — `has` is a miss, `ids`
 * is empty — and the webContents path below is the code it replaced, byte for byte.
 */
export function electronPlatform(): ElectronPlatform {
  // THE INVARIANT (4c): a channel is REACHABLE BY A REMOTE PEER if, and only if, it is registered
  // through platform().handle/on. A raw `ipcMain.handle` is invisible to a peer — a peer has no
  // webContents, so its request never travels through ipcMain at all; it is answered from THIS
  // table by dispatch() below. When you add an IPC handler, that is the choice you are making:
  //   - core-bound / acts on THIS machine's state (fs, git, pty, workspace, transcripts) → platform
  //   - acts on the USER's own machine or is host-security-sensitive (dialogs, shell, notifications,
  //     updater, pairing/relay control plane) → raw ipcMain, on purpose. See src/main/index.ts.
  // handle/handleWithSender are ONE handler per channel (last wins, like ipcMain.handle);
  // on/onWithSender are an ordered set of listeners. Mirrors ServerPlatform exactly — a divergence
  // here would be a behavior difference between the two remote surfaces.
  //
  // SOLO COST: one Map.set per boot-time registration. With no peer connected nothing ever reads it.
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Set<Listener>>()
  const addListener = (channel: string, listener: Listener): void => {
    let set = listeners.get(channel)
    if (!set) {
      set = new Set()
      listeners.set(channel, set)
    }
    set.add(listener)
  }

  return {
    get userDataDir() {
      return app.getPath('userData')
    },
    get appVersion() {
      return app.getVersion()
    },
    get isPackaged() {
      return app.isPackaged
    },
    // `<app>/Contents/Resources` when packaged; node_modules/electron/…/Resources in dev (which is
    // why bundledTmuxPath falls back to the repo's own resources/bin).
    get resourcesPath() {
      return process.resourcesPath
    },
    // `<resourcesPath>/app.asar` when packaged, the repo root under `electron-vite dev` — one
    // candidate that answers for both, which is why the session-host lookup prefers it.
    get appPath() {
      return app.getAppPath()
    },
    // The ipcMain half of each registration is UNCHANGED — the local window's call is bit-identical
    // to what it was before the table existed (same event-stripping, same sender id).
    handle: (ch, fn) => {
      handlers.set(ch, { fn, withSender: false })
      ipcMain.handle(ch, (_e, ...args) => fn(...args))
    },
    on: (ch, fn) => {
      addListener(ch, { fn, withSender: false })
      ipcMain.on(ch, (_e, ...args) => fn(...args))
    },
    handleWithSender: (ch, fn) => {
      handlers.set(ch, { fn, withSender: true })
      ipcMain.handle(ch, (e, ...args) => fn(e.sender.id, ...args))
    },
    onWithSender: (ch, fn) => {
      addListener(ch, { fn, withSender: true })
      ipcMain.on(ch, (e, ...args) => fn(e.sender.id, ...args))
    },
    async dispatch(clientId, req) {
      // Host-control admission, from the ONE shared list (src/shared/host-control.ts) rather than a
      // prefix test written out here — the second shell copying a stale copy of that test is the
      // failure mode this closes.
      if (isHostOnlyChannel(req.method)) {
        return {
          t: 'res', id: req.id, ok: false,
          error: { code: 'E_FORBIDDEN', message: HOST_ONLY_REFUSAL }
        }
      }
      const h = handlers.get(req.method)
      if (!h) {
        return {
          t: 'res', id: req.id, ok: false,
          error: { code: E_NO_HANDLER, message: `no handler for ${req.method}` }
        }
      }
      try {
        const result = h.withSender ? await h.fn(clientId, ...req.args) : await h.fn(...req.args)
        return { t: 'res', id: req.id, ok: true, result: result ?? null }
      } catch (err) {
        return {
          t: 'res', id: req.id, ok: false,
          error: { code: 'E_HANDLER', message: err instanceof Error ? err.message : String(err) }
        }
      }
    },
    cast(clientId, method, args) {
      // The SAME admission as dispatch, because a cast is a second door into the same table. Gating
      // dispatch alone would still admit `project-setup:consent-submit`, which the renderer sends as
      // a cast (ws-bridge.ts) — i.e. a guest could not start a run but could still answer the host's
      // trust prompt for it. A cast has no reply channel, so a refusal can only be dropped + logged.
      if (isHostOnlyChannel(method)) {
        const now = Date.now()
        if (now - lastRefusalLog >= REFUSAL_LOG_INTERVAL_MS) {
          lastRefusalLog = now
          console.warn(`[peer] refused host-control cast ${method} from peer ${clientId}`)
        }
        return
      }
      const set = listeners.get(method)
      if (!set) return
      for (const l of set) {
        // A cast has no reply channel (unlike dispatch, which returns E_HANDLER), so isolate each
        // listener: one throw must not skip the rest — a broken attribution listener would
        // otherwise swallow the peer's keystrokes. Log it, keep going. (Mirrors ServerPlatform.)
        try {
          if (l.withSender) l.fn(clientId, ...args)
          else l.fn(...args)
        } catch (err) {
          console.warn(
            `[peer] cast listener for ${method} threw`,
            err instanceof Error ? err.message : String(err)
          )
        }
      }
    },
    sendTo: (id, ch, ...args) => {
      // A peer id resolves to a UiSink (RPC-framed; pty:data goes out as a binary frame, with the
      // registry's WS backpressure). Everything else is a webContents, dispatched natively.
      const peers = peerRegistry()
      if (peers.has(id)) {
        peers.sendTo(id, ch, ...args)
        return
      }
      const wc = webContents.fromId(id)
      if (wc && !wc.isDestroyed()) wc.send(ch, ...args)
    },
    broadcast: (ch, ...args) => {
      sendToMain(ch, ...args) // the main window, exactly as before
      // …plus every relay peer. Not optional: presence diffs (presence:peer) and canvas mutations
      // fan out via broadcast, so a peer that only received sendTo would still see nothing.
      const peers = peerRegistry()
      if (peers.size === 0) return // solo desktop: no ids() array, no loop — allocation-free
      for (const id of peers.ids()) {
        // One peer must never break the fan-out. UiSinkRegistry.sendTo already contains a throwing
        // SINK (and evicts a dead one), so this only catches the rest of the path — the flow
        // controller it may call into. Either way the invariant is the same: an exception here
        // would skip every peer after this one AND unwind into the emitter (presenceHub.emit, the
        // canvas reflector), freezing the HOST's own presence/canvas over someone else's socket.
        try {
          peers.sendTo(id, ch, ...args)
        } catch (err) {
          console.warn(
            `[peer] broadcast of ${ch} to peer ${id} failed`,
            err instanceof Error ? err.message : String(err)
          )
        }
      }
    },
    clientIds: () => [...mainWindowClientIds(), ...peerRegistry().ids()],
    openExternal: (url) => shell.openExternal(url),
    // Seal / unseal node secrets at rest with the OS keychain. Byte-in byte-out, mirroring #167's
    // codex-node-auth-key.json shape: encrypt the UTF-8 content of the passed buffer, decrypt back to
    // the same bytes. Both are supplied together (a shell must supply BOTH hooks or NEITHER — see
    // CorePlatform). If the keychain is unavailable safeStorage throws, which node-auth-secret.ts
    // surfaces as a rejected load; both shells catch that and run legacy (fail-open), never crash.
    sealSecret: (b) => safeStorage.encryptString(b.toString('utf8')),
    unsealSecret: (b) => Buffer.from(safeStorage.decryptString(b), 'utf8'),
  }
}
