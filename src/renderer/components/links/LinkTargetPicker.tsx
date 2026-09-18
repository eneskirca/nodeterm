import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useDialogStack } from '../dialog-stack'
import { BranchSelect } from '../BranchSelect'
import { useProjects } from '../../state/projects'
import { activeSessionApi } from '../../session/session'
import type { Link, LinkKind, Endpoint } from '@shared/types'
import {
  resolveEndpoint,
  describeEndpoint,
  kindAllowed,
  linkKindEndpointOf,
  newLinkId,
  offCanvasLinkColor,
  type PickerSelection,
  type ProjectLookup
} from '../../lib/link-authoring'

interface LinkTargetPickerProps {
  /** The node the new link originates from (the `source` endpoint). */
  sourceNodeId: string
  /** That node's project — decides node vs xnode classification for a chosen target. */
  sourceProjectId: string
  onConfirm: (link: Link) => void
  onCancel: () => void
}

/** The link kinds the kind dropdown offers. `note` is NOT a persisted kind (a sticky→terminal note
 *  persists as `context`), so only the real `LinkKind`s appear. */
const KIND_OPTIONS: LinkKind[] = ['context', 'lineage', 'dependency']
const KIND_LABELS: Record<LinkKind, string> = {
  context: 'context (read each other / note)',
  lineage: 'lineage (spawned by — display only)',
  dependency: 'dependency (waits on / blocks on)'
}

/**
 * `LinkTargetPicker` (ticket 06): a modal to author ANY-kind link OFF-canvas — the only path for a
 * `dependency`, a cross-project (`xnode`) target, or a cross-repo (`branch`) target. The on-canvas
 * edge-draw (`onConnect`) stays the fast path for same-canvas `context`/note.
 *
 * Two tabs: **Node** lists every open, non-unavailable project's serialized nodes (the active one
 * expanded); picking one auto-classifies `node` vs `xnode` via `resolveEndpoint` (the user never
 * picks that distinction). **Branch** picks a repo branch from the source project's repo root.
 * A kind dropdown is constrained by `kindAllowed` against the source + target endpoints; an optional
 * `purpose` is the only "name" a link gets. Confirm builds a `Link` and hands it to `onConfirm`.
 */
export function LinkTargetPicker({ sourceNodeId, sourceProjectId, onConfirm, onCancel }: LinkTargetPickerProps) {
  const ownsKeyboard = useDialogStack()
  const [tab, setTab] = useState<'node' | 'branch'>('node')
  const [nodeSel, setNodeSel] = useState<PickerSelection | null>(null)
  const [branch, setBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [kind, setKind] = useState<LinkKind>('dependency')
  const [purpose, setPurpose] = useState('')

  // The projects the picker reads from — open + non-unavailable. Node titles/agent ids come from the
  // serialized `nodes`. useShallow: the filter derives a new array each call.
  const projects = useProjects(
    useShallow((s) =>
      s.projects
        .filter((p) => !p.closed && !p.unavailable)
        .map((p) => ({ id: p.id, name: p.name, nodes: p.nodes, ssh: !!p.ssh }) as ProjectLookup & { ssh: boolean })
    )
  )

  const sourceProject = projects.find((p) => p.id === sourceProjectId)
  const sourceNode = sourceProject?.nodes.find((n) => n.id === sourceNodeId)
  const sourceEp = useMemo(() => (sourceNode ? linkKindEndpointOf(sourceNode) : null), [sourceNode])

  // The branch tab's repo root is the SOURCE project's repo root (a branch endpoint is a repo ref,
  // not a node). Fetch branches the same way WorktreeDialog does — fire-and-forget; a failed read
  // just leaves the field free-text (BranchSelect allows custom refs).
  useEffect(() => {
    if (tab !== 'branch') return
    const root = sourceProjectId ? useProjects.getState().getProject(sourceProjectId)?.cwd : null
    if (!root) return
    let alive = true
    void activeSessionApi()
      .git.status(root)
      .then((s) => {
        if (alive) setBranches(s.branches ?? [])
      })
      .catch(() => {
        if (alive) setBranches([])
      })
    return () => {
      alive = false
    }
  }, [tab, sourceProjectId])

  // The resolved target endpoint + its capability descriptor (for the kind constraint).
  const targetEp: Endpoint | null = useMemo(() => {
    if (tab === 'branch') {
      const b = branch.trim()
      return b ? { ref: 'branch', repoPath: repoRootOf(sourceProjectId), branch: b } : null
    }
    return nodeSel ? resolveEndpoint(nodeSel, sourceProjectId) : null
  }, [tab, branch, nodeSel, sourceProjectId])

  const targetDescriptor = useMemo(() => {
    if (!targetEp) return null
    if (targetEp.ref === 'branch') return { kind: 'branch', contextCapable: false }
    // Find the chosen node to derive its capability (a foreign node is still a real node).
    const nodeId = targetEp.nodeId
    const proj =
      targetEp.ref === 'xnode' ? projects.find((p) => p.id === targetEp.projectId) : projects.find((p) => p.nodes.some((n) => n.id === nodeId))
    const node = proj?.nodes.find((n) => n.id === nodeId)
    return node ? linkKindEndpointOf(node) : null
  }, [targetEp, projects])

  const canConfirm =
    !!sourceEp &&
    !!targetEp &&
    !!targetDescriptor &&
    (tab === 'branch' ? !!branch.trim() : !!nodeSel) &&
    kindAllowed(kind, sourceEp, targetDescriptor)

  const submit = () => {
    if (!canConfirm || !targetEp) return
    const link: Link = {
      id: newLinkId(),
      kind,
      source: { ref: 'node', nodeId: sourceNodeId },
      target: targetEp,
      ...(purpose.trim() ? { meta: { purpose: purpose.trim() } } : {})
    }
    onConfirm(link)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!ownsKeyboard()) return
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  const targetDesc = targetEp ? describeEndpoint(targetEp, projects) : null

  return createPortal(
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm link-picker" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <p className="confirm__msg">Link to… — connect this node to another node, a foreign canvas, or a repo branch.</p>

        <div className="link-picker__tabs">
          <button type="button" className={tab === 'node' ? 'link-picker__tab active' : 'link-picker__tab'} onClick={() => setTab('node')}>
            Node
          </button>
          <button type="button" className={tab === 'branch' ? 'link-picker__tab active' : 'link-picker__tab'} onClick={() => setTab('branch')}>
            Branch
          </button>
        </div>

        {tab === 'node' ? (
          <div className="link-picker__list">
            {projects.map((p) => (
              <ProjectNodeSection
                key={p.id}
                project={p}
                sourceProjectId={sourceProjectId}
                sourceNodeId={sourceNodeId}
                selected={nodeSel?.kind === 'node' && nodeSel.projectId === p.id ? nodeSel.nodeId : null}
                onPick={(nodeId) => setNodeSel({ kind: 'node', projectId: p.id, nodeId })}
              />
            ))}
            {projects.length === 0 && <p className="link-picker__empty">No open projects to link to.</p>}
          </div>
        ) : (
          <label className="link-picker__field">
            <span className="link-picker__field-label">Branch</span>
            <BranchSelect
              value={branch}
              onChange={setBranch}
              options={branches}
              placeholder="pick a branch…"
              allowCustom
              customPlaceholder="type a ref (tag / SHA / origin/x)…"
            />
          </label>
        )}

        <label className="link-picker__field">
          <span className="link-picker__field-label">Kind</span>
          <select className="link-picker__select" value={kind} onChange={(e) => setKind(e.target.value as LinkKind)}>
            {KIND_OPTIONS.map((k) => {
              const allowed = sourceEp && targetDescriptor ? kindAllowed(k, sourceEp, targetDescriptor) : false
              return (
                <option key={k} value={k} disabled={!allowed}>
                  {KIND_LABELS[k]}
                  {allowed ? '' : ' — not allowed for this pair'}
                </option>
              )
            })}
          </select>
        </label>

        <label className="link-picker__field">
          <span className="link-picker__field-label">Purpose (optional)</span>
          <input
            className="confirm__input"
            value={purpose}
            placeholder="why this link exists…"
            spellCheck={false}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </label>

        {targetDesc && (
          <p className={`link-picker__target${targetDesc.available ? '' : ' unavailable'}`}>
            → {targetDesc.label}
            {!targetDesc.available && ' (unavailable)'}
          </p>
        )}

        <div className="confirm__actions">
          <button type="button" className="confirm__btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="confirm__btn confirm__btn--primary" disabled={!canConfirm} onClick={submit}>
            Link
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** One project's nodes as a collapsible section in the Node tab. */
function ProjectNodeSection({
  project,
  sourceProjectId,
  sourceNodeId,
  selected,
  onPick
}: {
  project: ProjectLookup
  sourceProjectId: string
  sourceNodeId: string
  selected: string | null
  onPick: (nodeId: string) => void
}) {
  const [open, setOpen] = useState(project.id === sourceProjectId)
  const foreign = project.id !== sourceProjectId
  return (
    <div className="link-picker__project">
      <button type="button" className="link-picker__project-head" onClick={() => setOpen((v) => !v)}>
        <span className="link-picker__chev">{open ? '▾' : '▸'}</span>
        <span className="link-picker__project-name">
          {project.name}
          {foreign && <span className="link-picker__foreign"> · cross-project</span>}
        </span>
      </button>
      {open && (
        <div className="link-picker__nodes">
          {project.nodes.map((n) => {
            const isSource = n.id === sourceNodeId && !foreign
            return (
              <button
                type="button"
                key={n.id}
                className={selected === n.id ? 'link-picker__node selected' : 'link-picker__node'}
                disabled={isSource}
                onClick={() => onPick(n.id)}
                title={isSource ? 'this is the source node' : n.title || n.id}
              >
                <span className="link-picker__node-kind">{nodeKindGlyph(n.kind)}</span>
                <span className="link-picker__node-title">{n.title || n.id}</span>
                {n.agentId && <span className="link-picker__node-agent">{n.agentId}</span>}
                {foreign && <span className="link-picker__node-xnode">xnode</span>}
              </button>
            )
          })}
          {project.nodes.length === 0 && <p className="link-picker__empty">No nodes.</p>}
        </div>
      )}
    </div>
  )
}

/** A one-glyph label for a node kind in the picker list. */
function nodeKindGlyph(kind: string): string {
  switch (kind) {
    case 'terminal':
      return '▣'
    case 'sticky':
      return '🗒'
    case 'group':
      return '▢'
    case 'editor':
      return '📄'
    case 'diff':
      return '⇄'
    case 'web':
    case 'browser':
      return '🌐'
    case 'video':
      return '▶'
    case 'dino':
      return '🦖'
    default:
      return '•'
  }
}

/** Resolve the repo root for the branch endpoint from the projects store. A branch link's
 *  `repoPath` is the repo root (the same root WorktreeDialog / Source Control operate on). */
function repoRootOf(projectId: string): string {
  return useProjects.getState().getProject(projectId)?.cwd ?? ''
}

// Re-export for the inspector's kind chip so the two surfaces share one color rule.
export { offCanvasLinkColor }
