import type { CanvasNode } from '../state/workspace'

const LOCAL_FILE_NODE_TYPES = new Set(['editor', 'video', 'web'])

export interface LocalFileCopyScope {
  /**
   * The active project is a RELAY tab — a live client of another machine's core. Its nodes' paths
   * describe the PEER's disk, but `window.nodeTerminal.clipboard` is this machine's preload, so
   * copying them would hand peer paths to a local `statSync`: usually a miss, but when the same
   * repo is checked out on both machines it silently puts a DIFFERENT file on the pasteboard.
   * A relay tab is marked at the PROJECT level (`Project.remote`) and never on the node, so this
   * fact cannot be read off `nodes` — it has to be passed in. Same hazard the `show-image`
   * control verb documents ("or, worse, open a same-named local file").
   */
  projectIsRelay?: boolean
}

/** Paths represented by the selected local file-backed nodes, in canvas order and without dupes. */
export function selectedLocalFilePaths(
  nodes: CanvasNode[],
  scope: LocalFileCopyScope = {}
): string[] {
  if (scope.projectIsRelay) return []
  const seen = new Set<string>()
  const paths: string[] = []
  for (const node of nodes) {
    const path = node.data.filePath
    if (
      !node.selected ||
      !LOCAL_FILE_NODE_TYPES.has(node.type) ||
      typeof path !== 'string' ||
      !path ||
      node.data.sshFs ||
      node.data.fileMissing ||
      seen.has(path)
    ) {
      continue
    }
    seen.add(path)
    paths.push(path)
  }
  return paths
}
