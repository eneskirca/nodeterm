import { Suspense, lazy } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'

// EditorNode/DiffNode pull in the whole of monaco-editor (several MB of JS). Importing them
// statically put Monaco in the startup chunk for every launch — including the common canvas
// of terminals with no editor node at all. These wrappers are what goes into `nodeTypes`;
// Monaco's chunk is fetched the first time an editor/diff node actually mounts.
const EditorInner = lazy(() => import('./EditorNode').then((m) => ({ default: m.EditorNode })))
const DiffInner = lazy(() => import('./DiffNode').then((m) => ({ default: m.DiffNode })))
// The pull request node joins this group: its Files tab shows a Monaco diff (ticket 03).
const PullInner = lazy(() => import('./PullNode').then((m) => ({ default: m.PullNode })))
// The issues node shares the pull node's timeline and stylesheet, so it loads on first mount too.
const IssuesInner = lazy(() => import('./IssuesNode').then((m) => ({ default: m.IssuesNode })))

function LoadingBody() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#1e1e1e',
        borderRadius: 10,
        color: 'rgba(255,255,255,0.4)',
        fontSize: 12
      }}
    >
      Loading editor…
    </div>
  )
}

export function LazyEditorNode(props: NodeProps<CanvasNode>) {
  return (
    <Suspense fallback={<LoadingBody />}>
      <EditorInner {...props} />
    </Suspense>
  )
}

export function LazyDiffNode(props: NodeProps<CanvasNode>) {
  return (
    <Suspense fallback={<LoadingBody />}>
      <DiffInner {...props} />
    </Suspense>
  )
}

export function LazyPullNode(props: NodeProps<CanvasNode>) {
  return (
    <Suspense fallback={<LoadingBody />}>
      <PullInner {...props} />
    </Suspense>
  )
}

export function LazyIssuesNode(props: NodeProps<CanvasNode>) {
  return (
    <Suspense fallback={<LoadingBody />}>
      <IssuesInner {...props} />
    </Suspense>
  )
}
