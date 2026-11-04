import type { PullFile, PullLineComment } from '@shared/github-pull-detail'
import { pullLineThreads } from './pullLineThreads'

export type PullTreeNode =
  | { kind: 'folder'; name: string; path: string; additions: number; deletions: number; children: PullTreeNode[] }
  | { kind: 'file'; name: string; file: PullFile }

type Folder = Extract<PullTreeNode, { kind: 'folder' }>

/** The Files tab's tree: each file under its folders, in list order, with +/- summed per folder and
 *  a chain of single folders joined into one row (`src/renderer/nodes`). `filter` keeps the files
 *  whose path or old path holds it, ignoring case. `hide` leaves a file out (Hide viewed files). */
export function pullFileTree(files: readonly PullFile[], filter = '', hide?: (file: PullFile) => boolean): PullTreeNode[] {
  const needle = filter.trim().toLowerCase()
  const root: Folder = { kind: 'folder', name: '', path: '', additions: 0, deletions: 0, children: [] }
  for (const file of files) {
    if (needle && !`${file.path}\n${file.previousPath ?? ''}`.toLowerCase().includes(needle)) continue
    if (hide?.(file)) continue
    const parts = file.path.split('/')
    let folder = root
    folder.additions += file.additions
    folder.deletions += file.deletions
    for (const name of parts.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${name}` : name
      let next = folder.children.find((child): child is Folder => child.kind === 'folder' && child.path === path)
      if (!next) {
        next = { kind: 'folder', name, path, additions: 0, deletions: 0, children: [] }
        folder.children.push(next)
      }
      folder = next
      folder.additions += file.additions
      folder.deletions += file.deletions
    }
    folder.children.push({ kind: 'file', name: parts[parts.length - 1], file })
  }
  return root.children.map(joinChain)
}

function joinChain(node: PullTreeNode): PullTreeNode {
  if (node.kind === 'file') return node
  let folder = node
  while (folder.children.length === 1 && folder.children[0].kind === 'folder') {
    const only: Folder = folder.children[0]
    folder = { ...only, name: `${folder.name}/${only.name}` }
  }
  return { ...folder, children: folder.children.map(joinChain) }
}

/** Unresolved review threads per file path (files with none are absent); undefined when the read
 *  did not say which threads are resolved. */
export function openThreadsByPath(
  comments: readonly PullLineComment[], resolved: readonly number[] | undefined
): Map<string, number> | undefined {
  if (!resolved) return undefined
  const counts = new Map<string, number>()
  for (const path of new Set(comments.map((c) => c.path))) {
    const open = pullLineThreads(comments, path).filter((thread) => !resolved.includes(thread.id)).length
    if (open) counts.set(path, open)
  }
  return counts
}
