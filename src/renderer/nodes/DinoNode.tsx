import { useEffect, useRef, useState } from 'react'
import { Tooltip } from '../components/Tooltip'
import { IconClose } from '../components/icons'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import { useShallow } from 'zustand/react/shallow'
import { type CanvasNode } from '../state/workspace'
import { useProjects } from '../state/projects'
import { useActiveSessionPresence } from '../session/session'
import { createDinoGame } from './dino/dino-game'
import { shouldSpectate } from './dino/dino-authority'

/**
 * A dino node: a small self-contained T-Rex–style runner on a canvas. No PTY.
 * The game is created once on mount and destroyed on unmount (React Flow keys
 * nodes by id, so the instance survives re-renders). High score persists via
 * data.highScore — we seed the game with it and store new records back. The game
 * scopes its own keyboard/sound to the focusable host element, so it only reacts
 * while this node is focused and stays silent when you're on another node.
 *
 * Live/shared play (docs/superpowers/specs/2026-07-14-dino-live-design.md): while WE author a run
 * the engine broadcasts each frame over presence (`presence.dino`); while a peer authors this
 * node we SPECTATE their snapshots (`game.setRemote`). A lowest-clientId tiebreak (shouldSpectate)
 * settles a brief take-over race so every client converges on one authority. Solo (no peers) →
 * `selectDino` is null → we never spectate and `presence.dino` skips the cast, so play is
 * byte-identical to before.
 */
export function DinoNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements } = useReactFlow()
  const hostRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<ReturnType<typeof createDinoGame> | null>(null)

  // The active session's presence. DinoNode renders under Canvas's active-session provider, which is
  // KEYED on `session.id` (Canvas.tsx), so this node REMOUNTS on a session swap — the mount-time
  // `presence` capture below is therefore always the current session's, no ref needed.
  const presence = useActiveSessionPresence()
  // The peer (if any) broadcasting a live dino for THIS node, and our own id for the tiebreak.
  // selectDino excludes self and already applies the lowest-clientId rule, so `peer` is the one
  // authority to consider. useShallow: a new PeerState object arrives ~20 Hz while spectating.
  const peer = presence.store(useShallow((s) => presence.selectDino(s, id)))
  const myId = presence.store((s) => s.myId)
  const [spectating, setSpectating] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const game = createDinoGame(host, {
      initialHighScore: data.highScore ?? 0,
      onHighScore: (score) => {
        updateNodeData(id, { highScore: score })
        // Also raise the project-level record so a NEW dino node (after this one is
        // closed) starts from it. Dino only runs while its project is active.
        const s = useProjects.getState()
        s.setDinoHighScore(s.activeProjectId, score)
      },
      // Authority broadcast: each throttled frame while we play, one null on stop/idle. Cast through
      // the SESSION wrapper `presence.dino` (not raw `api.presence.dino`), so a solo player's ~20 Hz
      // snapshots are SKIPPED with no peer to watch (the `null` stop always lands). `presence` is
      // captured once at mount (safe — DinoNode remounts on session change; see the note above).
      onSnapshot: (snap) => presence.dino(snap ? { nodeId: id, snap } : null)
    })
    gameRef.current = game
    return () => {
      // Belt-and-suspenders: guarantee our authority stop reaches the hub even if the last frame we
      // broadcast was mid-run (destroy() already emits null via onSnapshot when mid-broadcast; a
      // repeat null is an idempotent hub no-op).
      game.destroy()
      presence.dino(null)
      gameRef.current = null
    }
    // Mount once; never re-run (would respawn the game). data.highScore is read
    // as the seed only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Spectate vs. play. Reacts to the broadcasting peer + our id: when we should spectate, feed the
  // peer's snapshot to the engine; otherwise LOCAL. `setRemote(null)` is idempotent while already
  // LOCAL (it does NOT reset a live local run), so calling it on every non-spectating render is safe.
  useEffect(() => {
    const game = gameRef.current
    if (!game) return
    const spectate = shouldSpectate({
      myId,
      peerClientId: peer?.clientId ?? null,
      iAmAuthority: game.isAuthority()
    })
    if (spectate && peer?.dino) {
      game.setRemote(peer.dino.snap)
      setSpectating(true)
    } else {
      game.setRemote(null)
      setSpectating(false)
    }
  }, [peer, myId])

  return (
    <div className={`dino-node${selected ? ' selected' : ''}`} style={{ borderColor: data.color }}>
      <NodeResizer minWidth={NODE_MIN_SIZES.dino.width} minHeight={NODE_MIN_SIZES.dino.height} isVisible={selected} color={data.color} />

      <div className="dino-node__header" style={{ background: `${data.color}33` }}>
        <span className="term-node__color" style={{ background: data.color }} />
        <input
          className="term-node__title nodrag"
          value={data.title}
          spellCheck={false}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
        {spectating && peer && (
          <span
            className="dino-node__watching nodrag"
            style={{ color: peer.color, borderColor: `${peer.color}66` }}
            title={`${peer.name} is playing this dino`}
          >
            ▷ {peer.name} is playing
          </span>
        )}
        <Tooltip label="Close">
          <button className="term-node__close" aria-label="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
            <IconClose />
          </button>
        </Tooltip>
      </div>

      <div ref={hostRef} className="dino-node__body nodrag nowheel" tabIndex={0} />
    </div>
  )
}
