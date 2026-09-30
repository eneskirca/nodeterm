import { memo, useCallback, useState } from 'react'
import {
  devPortUrl,
  forwardRefusalText,
  type DevPortForwardRequest,
  type DevPortForwardResult
} from '@shared/dev-ports'
import { devPortsSig, parseDevPortsSig, portRowLabel, portsChipLabel, type PortRow } from '../lib/devPorts'
import { scanDevPorts, useDevPorts } from '../state/devPorts'
import { sessionForProject } from '../session/session'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { ConfirmDialog } from './ConfirmDialog'

function toast(message: string): void {
  window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } }))
}

interface Pending {
  message: string
  confirmLabel: string
  retry: Partial<DevPortForwardRequest>
  port: number
}

/**
 * The dev-server ports a node's session is listening on (CLAUDE.md → Dev-server ports), drawn by
 * the canvas node header AND the kanban card modal — one component, so the two views of one
 * session cannot disagree. Absent when the session listens on no (non-ephemeral) port.
 *
 * A row opens the port in a browser node. On an SSH project it first forwards the SAME port over
 * the project's master, so `http://localhost:<port>` — the URL the tool itself printed — reaches the
 * host. A local port that is taken, or a privileged one, is never forwarded silently: the person
 * is asked, and a different local port is only ever their explicit choice.
 */
export const PortsChip = memo(function PortsChip({
  nodeId,
  projectId,
  remote,
  onOpenUrl,
  menuZIndex = 70
}: {
  nodeId: string
  projectId: string
  /** The project is an SSH project: its ports are on the host and must be forwarded. */
  remote: boolean
  onOpenUrl: (url: string) => void
  menuZIndex?: number
}): React.JSX.Element | null {
  const sig = useDevPorts((s) => {
    const p = s.byProject[projectId]
    return devPortsSig(p?.nodes[nodeId], p?.forwards.filter((f) => f.nodeId === nodeId))
  })
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  const forward = useCallback(
    async (req: DevPortForwardRequest): Promise<void> => {
      let result: DevPortForwardResult
      try {
        result = await sessionForProject(projectId).api.devPorts.forward(req)
      } catch {
        result = { ok: false, reason: 'forward-failed', message: forwardRefusalText('forward-failed', req.port) }
      }
      if (result.ok) {
        useDevPorts.getState().noteForward(projectId, { nodeId, remotePort: req.port, localPort: result.localPort })
        onOpenUrl(result.url)
        return
      }
      if (result.reason === 'privileged') {
        setPending({
          port: req.port,
          message: `${result.message} Forward it to this computer anyway? Binding a port below 1024 may need administrator rights here.`,
          confirmLabel: 'Forward anyway',
          retry: { ...req, allowPrivileged: true }
        })
        return
      }
      if ((result.reason === 'local-port-busy' || result.reason === 'local-port-denied') && result.suggestedLocalPort !== undefined) {
        const alt = result.suggestedLocalPort
        setPending({
          port: req.port,
          message:
            `${result.message} Forward it to local port ${alt} instead? ` +
            `Links the tool prints (http://localhost:${req.port}) will not reach it — use the browser node this opens.`,
          confirmLabel: `Use port ${alt}`,
          retry: { ...req, localPort: alt }
        })
        return
      }
      if (result.reason === 'not-listening') void scanDevPorts(projectId, remote, 'user')
      toast(result.message)
    },
    [nodeId, onOpenUrl, projectId, remote]
  )

  const open = useCallback(
    (row: PortRow): void => {
      if (!remote) {
        onOpenUrl(devPortUrl(row.port))
        return
      }
      void forward({ projectId, nodeId, port: row.port })
    },
    [forward, nodeId, onOpenUrl, projectId, remote]
  )

  const rows = parseDevPortsSig(sig)
  const label = portsChipLabel(rows.map((r) => ({ port: r.port, ephemeral: r.ephemeral, addresses: [], command: r.command })))
  if (!label && !pending) return null

  const rowItems = (row: PortRow): MenuItem[] => {
    const items: MenuItem[] = [
      {
        label: `Open ${portRowLabel(row)}`,
        hint: remote
          ? row.forwardedTo !== undefined
            ? `Forwarded to localhost:${row.forwardedTo} on this computer — open it in a browser node`
            : `Forward port ${row.port} from the server to the same port here, then open it in a browser node`
          : `Open http://localhost:${row.port} in a browser node`,
        onClick: () => open(row)
      }
    ]
    if (remote && row.forwardedTo !== undefined) {
      const localPort = row.forwardedTo
      items.push({
        label: `Stop forwarding :${row.port}`,
        hint: `Close localhost:${localPort} on this computer`,
        onClick: () => {
          void sessionForProject(projectId)
            .api.devPorts.unforward({ projectId, localPort })
            .then(() => useDevPorts.getState().dropForward(projectId, localPort))
        }
      })
    }
    return items
  }
  const primary = rows.filter((r) => !r.ephemeral)
  const other = rows.filter((r) => r.ephemeral)
  const items: MenuItem[] = [
    { type: 'label', label: remote ? 'Listening on the server' : 'Listening in this session' },
    ...primary.flatMap(rowItems)
  ]
  if (other.length > 0) {
    items.push({
      type: 'submenu',
      label: `Other ports (${other.length})`,
      children: other.flatMap(rowItems)
    })
  }

  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
  return (
    // Inside a draggable header and a clickable card: every event stops here (TeamProgressChip).
    <span
      className="ports-chip-wrap"
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
      onPointerDown={stop}
      onContextMenu={stop}
      onKeyDown={stop}
    >
      {label && (
        <button
          type="button"
          className="ports-chip nodrag"
          title={remote ? 'Dev servers listening on the server — click to forward and open' : 'Dev servers listening in this session — click to open'}
          aria-label={`Listening ports: ${label}`}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            if (!menu) void scanDevPorts(projectId, remote, 'user')
            setMenu((cur) => (cur ? null : { x: r.left, y: r.bottom + 4 }))
          }}
        >
          {label}
        </button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} zIndex={menuZIndex} scroll items={items} onClose={() => setMenu(null)} />}
      {pending && (
        <ConfirmDialog
          message={pending.message}
          confirmLabel={pending.confirmLabel}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const retry = pending.retry
            setPending(null)
            void forward({ projectId, nodeId, port: pending.port, ...retry })
          }}
        />
      )}
    </span>
  )
})
