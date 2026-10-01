// The write half of a structural control verb (`group`, `ungroup`, `move`, `arrange`, `align`) run
// against a project that is NOT on screen.
//
// Those verbs compute a whole new node array through the same pure transforms the live canvas uses
// (`groupSelectedNodes`, `reparentNode`, `arrangeNodes`, …), over the owning project's serialized
// nodes hydrated by `nodeStatesToFlow`. Off screen nothing was ever measured, so the sizes they lay
// out with are the persisted ones — which is what a node is born with and what it keeps until the
// user resizes it, so the layout matches what the user will see closely enough (a node the user
// resized is persisted at that size too).
//
// Writing that array back whole would round-trip every node through the serializers. This turns it
// into the smallest set of ops instead: an existing node keeps EVERY stored field (exec overlay,
// launch, account, …) and only takes the geometry the verb changed; a frame the verb created is
// added whole; a frame the verb dissolved is removed. Nothing else is ever removed.

import type { CanvasMutation, CanvasNodeState } from '@shared/types'
import { flowToNodeStates, type CanvasNode } from '../state/workspace'

/** The fields a structural verb may change on a node that already exists. */
const GEOMETRY = ['position', 'size', 'parentId', 'group'] as const

// null and absent are the same fact here (`group: null` vs no `group`), or an untouched node would
// be rewritten just for its spelling.
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function geometryMutations(
  stored: readonly CanvasNodeState[],
  next: readonly CanvasNode[]
): CanvasMutation[] {
  const byId = new Map(stored.map((n) => [n.id, n]))
  const out: CanvasMutation[] = []
  const kept = new Set<string>()
  for (const n of flowToNodeStates(next as CanvasNode[])) {
    kept.add(n.id)
    const s = byId.get(n.id)
    if (!s) {
      out.push({ op: 'upsert', node: n })
      continue
    }
    const changed = GEOMETRY.filter((k) => !same(s[k], n[k]))
    if (changed.length === 0) continue
    const patched: CanvasNodeState = { ...s }
    for (const k of changed) {
      if (n[k] === undefined) delete (patched as Partial<CanvasNodeState>)[k]
      else (patched as unknown as Record<string, unknown>)[k] = n[k]
    }
    out.push({ op: 'upsert', node: patched })
  }
  // Only a FRAME can be dissolved by these verbs (`ungroup`). A non-frame missing from `next` is one
  // the hydration skipped, and it is not this write's to delete.
  for (const s of stored) if (!kept.has(s.id) && s.kind === 'group') out.push({ op: 'remove', id: s.id })
  return out
}
