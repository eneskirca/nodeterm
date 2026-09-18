import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import { quantizeCharSize } from '../terminal/char-size-quantize'
import { reportsOwnCopy } from '@shared/agents/config'
import type { AgentId, BuiltinAgentId } from '@shared/agents/config'
import { useSession } from '../session/session'
import { useSettings } from '../state/settings'
import { LocalTransport } from '../terminal/local-transport'
import { parseOsc52 } from '../terminal/osc52'
import { activateUnicode11 } from '../terminal/unicode-width'
import { useCopyFeedback } from '../terminal/useCopyFeedback'
import {
  attachReplay,
  cursorPlacementSeq,
  seedPaint,
  stripTrailingNewline,
  terminalKeyAction,
  toXtermText,
  xtermOptionsFromSettings,
  SHIFT_ENTER_SEQ,
  CO_ATTACH_MOUSE_SEQ
} from '../terminal/terminal-config'
import { resolveSshRemote, reportSshDrop } from './TerminalNode'
import { buildSshArgs, type SshConnection } from '@shared/ssh'
import { travelToNode } from './travel-handler'
import { liveProjectJumpTarget } from '../lib/projectJump'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'
import type { CanvasNodeState, Project } from '@shared/types'

/** The B-side context the projection needs to co-attach to B's session — the subset of B's node's
 *  `data` plus B's project identity, handed down from the ephemeral derivation in Canvas. */
export interface XProjectSpawn {
  bProjectId: string
  bNodeId: string
  /** B's serialized node — the owner of the session this projection joins. */
  bNode: CanvasNodeState
  /** B's project, for ssh resolution + the origin badge. */
  bProject: Project
}

/**
 * A cross-project PROJECTION (ticket 05) — a derived, greyed/dotted canvas node that is a SECOND
 * live client on ANOTHER project's tmux session.
 *
 * It is the canvas-node analogue of `ModalTerminal`: the same viewer-identity co-attach (a per-mount
 * `viewerId` makes this an independent subscriber of B's shared session), the same seed-paint from
 * the joiner screen, the same CO_ATTACH_MOUSE fix. What is DIFFERENT and load-bearing:
 *
 * - **`requireExisting: true`** — a projection is a VIEWER, never the owner. It must never spawn B's
 *   session. The refusal lives in core's `create()` (after the in-flight barrier + tombstone, before
 *   the spawn branch): if B's session is not live yet, the create returns `unavailable: 'no-session'`
 *   rather than becoming the node's owner. A projection that spawned would steal pane ownership,
 *   run under the wrong project's resolved cwd/account, and persist a session B never asked for.
 * - **B's project context, not A's.** `cwd`/`agentId`/`accountId`/`ssh` come from B's node; ssh is
 *   resolved against B's (possibly remote) ControlMaster via `resolveSshRemote(bProject.ssh.server,
 *   …)`, which keys on connection scope — not on the active canvas — so a projection in A reaches
 *   B's host. `ownerProjectId` is B (B owns the session).
 * - **No park, no WebGL budget, no flow-control** (DOM renderer only). A projection must not be a
 *   budget-free second GPU context on top of B's node, and it is a viewer — the shared session's
 *   flow/pacing is driven by B's canvas client. Same stance as the modal.
 * - **Retry on `no-session`.** B's canvas may not be mounted, so the session may not exist yet. The
 *   projection shows a placeholder and re-tries on a bounded interval; once B mounts its node and
 *   spawns, a retry joins it.
 *
 * Like `subagent`/`loop`, this node lives outside React Flow's managed `nodes` array (merged only at
 * `<ReactFlow nodes={allNodes}>`), is never persisted (its `xproj-` id is filtered out by
 * `isEphemeralNodeId`), and is `selectable: false` so a rubber band never sweeps it into a
 * selection meant for real nodes.
 */
export function XProjectNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { api } = useSession()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const transportRef = useRef<LocalTransport | null>(null)

  // The B-side context rides the ephemeral node's data (set by the Canvas derivation, §4). It is
  // NOT persisted — the node itself never round-trips through flowToNodeStates — so reading it
  // through the `[key: string]: unknown` index is fine.
  const spawn = data.xprojSpawn as XProjectSpawn | undefined
  const originName = (data.xprojOriginName as string) || spawn?.bProject.name || ''
  const originColor = (data.color as string) || spawn?.bProject.color || '#8e8e93'

  const copy = useCopyFeedback({
    hostRef,
    hasSelection: () => !!termRef.current?.hasSelection(),
    // Same agent gate as the modal/canvas node: a claude projection stays silent because claude
    // prints its own "copied N chars" line — a second message for one gesture is noise.
    enabled: !reportsOwnCopy(
      (spawn?.bNode.agentBaseId ?? spawn?.bNode.agentId) as AgentId | undefined
    )
  })

  // Bump to re-run the create effect after a `no-session` retry timeout (see below).
  const [retry, setRetry] = useState(0)
  // The plate shown when B's session is not live / not connected. `null` once attached.
  const [plate, setPlate] = useState<'no-session' | 'ssh' | 'closed' | null>('no-session')

  useEffect(() => {
    if (!spawn) return
    const { bProjectId, bNodeId, bNode, bProject } = spawn
    // A unique viewerId per mount: the core namespaces it per connection, so uniqueness only has to
    // hold within THIS window. `xproj-<B>-<node>` makes it a distinct subscriber of B's session.
    const viewerId = `xproj-${bProjectId}-${bNodeId}-${Math.random().toString(36).slice(2, 8)}`
    const transport = new LocalTransport(api, viewerId)
    const s = useSettings.getState().settings
    const term = new Terminal(xtermOptionsFromSettings(s))
    activateUnicode11(term)
    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term
    fitRef.current = fit
    transportRef.current = transport
    term.open(hostRef.current!)
    quantizeCharSize(term)
    fit.fit()

    let sessionId: string | null = null
    let dead = false
    const cleanups: Array<() => void> = []
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    // `retry` from the closure is the run index — use it to cap retries so a projection whose B
    // never mounts stops polling after a bounded window and leaves the persistent plate.
    const attempt = retry

    // MIRROR ModalTerminal — the OSC 52 clipboard-write path (tmux's mouse is ON; a drag-select in
    // copy-mode emits OSC 52 to this client). `parseOsc52` returns null for a `?` read query so a
    // remote program can never read the local clipboard. Returning true swallows the sequence.
    term.parser.registerOscHandler(52, (oscData) => {
      const text = parseOsc52(oscData)
      if (text !== null) {
        window.nodeTerminal.clipboard.writeText(text)
        copy.notifyCopy(text)
      }
      return true
    })

    // MIRROR ModalTerminal — copy chords (Cmd+C / Ctrl+Shift+C / Ctrl+Insert) copy the xterm
    // selection and are always swallowed (else Ctrl+Shift+C falls through to the pty as \x03);
    // Shift+Enter → ESC+CR so agent CLIs insert a newline; project-jump digits are swallowed when
    // the app owns the key.
    term.attachCustomKeyEventHandler((e) => {
      const action = terminalKeyAction(e, term.hasSelection(), liveProjectJumpTarget(e) !== null)
      if (action === 'pass') return true
      e.preventDefault()
      if (action === 'copy') window.nodeTerminal.clipboard.writeText(term.getSelection())
      else if (action === 'shift-enter' && sessionId) transport.write(sessionId, SHIFT_ENTER_SEQ)
      return false
    })

    void (async () => {
      const bSsh = bProject.ssh
      const sshRemote = bSsh ? await resolveSshRemote(bSsh.server, bNode.cwd) : undefined
      if (dead) return
      // B is an SSH project whose master is down: spawn NOTHING (the requireRemote precedent — a
      // create without `sshRemote` would fall through to a LOCAL session wearing B's identity). The
      // projection says so and queues B's project for the reconnect coordinator.
      if (bSsh && !sshRemote) {
        setPlate('ssh')
        reportSshDrop(bProjectId, bNodeId)
        return
      }
      // A local `ssh <host>` node runs ssh as its own pty program; an SSH-PROJECT node uses remote
      // tmux (sshRemote). B's node carries `ssh` for the former; `bProject.ssh` implies the latter.
      const localSsh = !!bNode.ssh && !bNode.sshRemoteTmux && !bSsh
      const res = await transport.create({
        cols: term.cols,
        rows: term.rows,
        shell: localSsh ? 'ssh' : bNode.shell,
        shellArgs: localSsh ? buildSshArgs(bNode.ssh!) : undefined,
        cwd: bNode.cwd,
        persistKey: bNodeId,
        // B owns the session — recorded main-side on a genuine fresh spawn (which `requireExisting`
        // forbids here, but the ledger value is still correct for any co-attach accounting).
        ownerProjectId: bProjectId,
        agentId: bNode.agentId,
        agentBaseId: bNode.agentBaseId,
        accountId: bNode.accountId,
        sshRemote,
        requireRemote: !!bSsh,
        // The load-bearing difference: a projection JOINS or refuses, never spawns. Without this a
        // projection of a not-yet-mounted B would become the owner of B's session.
        requireExisting: true
      })
      // B's session is not live yet (B's canvas not mounted / B's node never spawned). Show the
      // placeholder and re-try on a bounded interval — once B mounts and spawns, a retry joins it.
      if (res.unavailable === 'no-session') {
        setPlate('no-session')
        // Stop re-trying after a bounded window: a projection whose B never mounts leaves the
        // persistent plate rather than polling forever (the user opens B to start the session).
        if (attempt < XPROJ_RETRY_MAX) {
          retryTimer = setTimeout(() => setRetry((v) => v + 1), XPROJ_RETRY_MS)
        }
        return
      }
      // Refused core-side (B's remote master died inside the round-trip, or `ssh` is missing).
      if (res.unavailable === 'ssh') {
        setPlate('ssh')
        reportSshDrop(bProjectId, bNodeId)
        return
      }
      // Another client permanently deleted B's node — never resurrect it.
      if (res.closed) {
        setPlate('closed')
        return
      }
      // Unmounted while the create was in flight: detach the viewer we may have registered.
      if (dead) {
        transport.kill(res.sessionId)
        return
      }
      sessionId = res.sessionId
      setPlate(null)
      cleanups.push(transport.onData(res.sessionId, (d) => term.write(d)))
      cleanups.push(
        transport.onExit(res.sessionId, () =>
          term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n')
        )
      )
      if (transport.onSize)
        cleanups.push(transport.onSize(res.sessionId, (size) => term.resize(size.cols, size.rows)))
      term.onData((d) => sessionId && transport.write(sessionId, d))
      // DELIBERATELY omitted vs. TerminalNode: no flow-control pause (transport.setFlow) — the pty's
      // pacing comes from B's canvas client; the projection is a second view and never drives flow.

      // A projection never owns a cold-start scrollback (`requireExisting` ⇒ no fresh spawn), so the
      // snapshot is always null and `fresh` is false. Paint B's server-captured screen exactly as the
      // modal co-attach does (capture-pane text → CRLFs via toXtermText, then the cursor placement).
      const paint = seedPaint({
        replay: attachReplay({ parked: false, fresh: res.fresh, hasInitialCommand: false }),
        superseded: false,
        snapshot: null,
        screen: res.screen
      })
      if (paint === 'create-screen' && res.screen) {
        term.write('\x1b[0m' + toXtermText(stripTrailingNewline(res.screen)))
        term.write(cursorPlacementSeq(res.cursor))
      }
      // Co-attach joiners miss the mouse-tracking mode tmux only sends at its own attach — enable it
      // here so the wheel scrolls tmux history (byte-identical to ModalTerminal).
      if (res.coAttachMouse) term.write(CO_ATTACH_MOUSE_SEQ)

      const ro = new ResizeObserver(() => {
        fit.fit()
        if (sessionId) transport.resize(sessionId, term.cols, term.rows)
      })
      ro.observe(hostRef.current!)
      cleanups.push(() => ro.disconnect())
      transport.resize(res.sessionId, term.cols, term.rows)
      term.focus()
    })()

    return () => {
      dead = true
      cleanups.forEach((fn) => fn())
      if (retryTimer) clearTimeout(retryTimer)
      // Kill ONLY this projection's viewer — the instance appends its viewerId. B's canvas client
      // (or parked client) is a different composite subscriber and is untouched; B's shared pty
      // lives on until its last view goes.
      if (sessionId) transport.kill(sessionId)
      term.dispose()
      termRef.current = null
      fitRef.current = null
      transportRef.current = null
    }
    // `retry` is the re-trigger; `id` pins the effect to this projection. `spawn` is captured per
    // run (the derivation rebuilds it when B's nodes/links change). The copy object is stable per
    // mount (useCopyFeedback memoizes its sink) so it is intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, spawn, retry])

  const onJump = () => {
    if (spawn) travelToNode(spawn.bNodeId)
  }

  return (
    <div
      className={`xproj-node${selected ? ' selected' : ''}`}
      style={{ '--xproj-stroke': originColor } as React.CSSProperties}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={NODE_MIN_SIZES.terminal.width}
        minHeight={NODE_MIN_SIZES.terminal.height}
        color={originColor}
      />
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="xproj-node__header nodrag">
        <span className="xproj-node__origin" style={{ color: originColor }}>
          <span className="xproj-node__dot" style={{ background: originColor }} />
          {originName}
        </span>
        <span className="xproj-node__title">{(data.title as string) || 'projection'}</span>
        <button
          className="xproj-node__jump"
          title={`Open in ${originName}`}
          onClick={(e) => {
            e.stopPropagation()
            onJump()
          }}
        >
          ↗
        </button>
      </div>
      <div className="xproj-node__body nodrag nowheel" ref={hostRef} />
      {plate && (
        <div className="xproj-node__plate">
          {plate === 'no-session' &&
            `${originName}'s session is not live yet — open ${originName} (or wait for it to mount) and this view connects.`}
          {plate === 'ssh' &&
            `Not connected to ${originName}'s host — nothing was started. Reconnect ${originName} and retry.`}
          {plate === 'closed' && `${originName}'s session was closed by another user.`}
        </div>
      )}
    </div>
  )
}

/** How long a projection waits before re-trying a `no-session` create. B's canvas mount is the real
 *  signal; this interval is the honest bounded fallback until B's `TerminalNode` mounts and spawns.
 *  Bounded by `XPROJ_RETRY_MAX` attempts, after which the plate persists (open B to start it). */
const XPROJ_RETRY_MS = 2000
const XPROJ_RETRY_MAX = 15
