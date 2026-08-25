import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useProjects } from '../../state/projects'
import { useSession } from '../../session/session'
import type { Link } from '@shared/types'
import {
  linksForNode,
  describeEndpoint,
  offCanvasLinkColor,
  removeDependencyLinkConfig,
  isBranchDependencyLink,
  type ProjectLookup
} from '../../lib/link-authoring'
import { LinkTargetPicker } from './LinkTargetPicker'

interface LinkInspectorPanelProps {
  /** The node whose links this panel lists. */
  nodeId: string
  /** Flyout = a sibling-of-root panel (canvas node header button). Portal = a body portal
   *  (card modal / sidebar). The body is identical; only the mount + scrim differ. */
  mount: 'flyout' | 'portal'
  /** Portal mode only: close handler (the flyout's parent owns its own open state). */
  onClose?: () => void
}

const KIND_LABELS: Record<string, string> = {
  context: 'context',
  lineage: 'lineage',
  dependency: 'dependency'
}

/**
 * `LinkInspectorPanel` (ticket 06): lists every link a node is an endpoint of — outgoing (this node
 * is the source) and incoming (this node is the target) — and deletes them. It is ALSO a full
 * authoring surface: the footer's "Add link" opens `LinkTargetPicker`, so the inspector is the one
 * place to both see and change a node's links (the card-modal requirement).
 *
 * Source of truth is `Project.links` (persisted); for the node's project that already carries the
 * on-canvas `context`/`lineage` links too, so the inspector shows one combined list without needing
 * the canvas's live edge arrays. A just-drawn on-canvas link appears here after the next debounced
 * save (the picker/inspector write through `commitLinks` immediately, so off-canvas mutations are
 * never stale). Unresolvable targets render as a muted "unavailable" row whose `×` is a no-confirm
 * lazy-prune (deleting a link to a gone node is safe and tidies the project).
 *
 * Two mount modes share ONE body (the `.term-copy-pill`/`CardModal` "one component, two surfaces"
 * rule): `flyout` mirrors the comments flyout (sibling-of-root, no scrim); `portal` mirrors
 * `BoardLogPanel` in the card modal (body portal + scrim, Esc closes).
 */
export function LinkInspectorPanel({ nodeId, mount, onClose }: LinkInspectorPanelProps) {
  const { api } = useSession()
  const [adding, setAdding] = useState(false)

  // The projects store, filtered to the fields the inspector reads. useShallow: the map derives a
  // new array each call.
  const projects = useProjects(
    useShallow((s) =>
      s.projects.map((p) => ({ id: p.id, name: p.name, nodes: p.nodes, links: p.links ?? [] }) as ProjectLookup & { links: Link[] })
    )
  )

  // Which project holds this node, and its links. Node ids are globally unique across projects.
  const { projectId, allLinks } = useMemo(() => {
    for (const p of projects) {
      if (p.nodes.some((n) => n.id === nodeId)) {
        return { projectId: p.id, allLinks: p.links }
      }
    }
    return { projectId: null, allLinks: [] as Link[] }
  }, [projects, nodeId])

  const { outgoing, incoming } = useMemo(() => linksForNode(allLinks, nodeId), [allLinks, nodeId])

  const deleteLink = (id: string) => {
    if (!projectId) return
    const removed = allLinks.find((l) => l.id === id)
    const next = allLinks.filter((l) => l.id !== id)
    // Persist via the same funnel the picker uses. Reading the project's stored nodes (not the
    // active canvas's) so a background project isn't clobbered.
    const stored = useProjects.getState().getProject(projectId)
    useProjects
      .getState()
      .commitCanvas(projectId, stored?.nodes ?? [], stored?.viewport ?? { x: 0, y: 0, zoom: 1 }, next.length ? next : undefined)
    // A branch-dependency link OWNS a git-town lineage config entry: dropping the link must also
    // `git config --unset` the parent, or the config drifts from the (now gone) link set. Fire AFTER
    // the link is removed so the UI updates immediately; a failed unset is non-fatal (the lineage is
    // already gone from nodeterm's side — git-town just keeps a stale parent key until re-run).
    if (removed && isBranchDependencyLink(removed)) {
      void removeDependencyLinkConfig(api.git, removed).catch(() => {})
    }
  }

  const body = (
    <div className="link-inspector">
      <div className="link-inspector__head">
        <span className="link-inspector__title">Links</span>
        {mount === 'portal' && (
          <button type="button" className="link-inspector__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        )}
      </div>

      <div className="link-inspector__body">
        {outgoing.length === 0 && incoming.length === 0 && (
          <p className="link-inspector__empty">No links yet. Add one to connect this node to another node, a foreign canvas, or a branch.</p>
        )}
        {outgoing.length > 0 && (
          <div className="link-inspector__group">
            <span className="link-inspector__group-label">Outgoing</span>
            {outgoing.map((l) => (
              <LinkRow key={l.id} link={l} projects={projects} onDelete={() => deleteLink(l.id)} />
            ))}
          </div>
        )}
        {incoming.length > 0 && (
          <div className="link-inspector__group">
            <span className="link-inspector__group-label">Incoming</span>
            {incoming.map((l) => (
              <LinkRow key={l.id} link={l} projects={projects} onDelete={() => deleteLink(l.id)} incoming />
            ))}
          </div>
        )}
      </div>

      <button type="button" className="link-inspector__add" onClick={() => setAdding(true)}>
        + Add link
      </button>

      {adding && projectId && (
        <LinkTargetPicker
          sourceNodeId={nodeId}
          sourceProjectId={projectId}
          onConfirm={(link) => {
            const next = [...allLinks, link]
            const stored = useProjects.getState().getProject(projectId)
            useProjects
              .getState()
              .commitCanvas(projectId, stored?.nodes ?? [], stored?.viewport ?? { x: 0, y: 0, zoom: 1 }, next)
            setAdding(false)
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  )

  if (mount === 'flyout')
    return (
      <div className="term-node__links nodrag nowheel" onMouseDown={(e) => e.stopPropagation()}>
        {body}
      </div>
    )
  return createPortal(
    <div className="confirm-overlay link-inspector-overlay" onClick={onClose}>
      <div className="link-inspector-portal" onClick={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>,
    document.body
  )
}

/** One link row: colored kind chip · the OTHER endpoint's description · optional purpose · ×. */
function LinkRow({
  link,
  projects,
  onDelete,
  incoming
}: {
  link: Link
  projects: readonly ProjectLookup[]
  onDelete: () => void
  incoming?: boolean
}) {
  // The "other" endpoint is the one that is NOT this node. For an outgoing link that's the target;
  // for incoming it's the source. (Both could be non-node — a branch/xnode — which describeEndpoint
  // handles.)
  const other = incoming ? link.source : link.target
  const desc = describeEndpoint(other, projects)
  const color = offCanvasLinkColor(link)
  const purpose = typeof link.meta?.purpose === 'string' ? (link.meta.purpose as string) : ''
  return (
    <div className="link-row">
      <span className="link-row__kind" style={{ color }}>
        {KIND_LABELS[link.kind] ?? link.kind}
      </span>
      <span className="link-row__target">
        <span className={desc.available ? '' : 'unavailable'}>
          {incoming ? '← ' : '→ '}
          {desc.label}
        </span>
        {purpose && <span className="link-row__purpose">{purpose}</span>}
      </span>
      <button type="button" className="link-row__delete" onClick={onDelete} aria-label="Remove link" title="Remove link">
        ×
      </button>
    </div>
  )
}
