// Files tree edges: an empty PR, files at the root, everything hidden, a filter of spaces, a rename
// found by its old path only, and a 300-file PR.
import { describe, expect, it } from 'vitest'
import type { PullFile } from '@shared/github-pull-detail'
import { openThreadsByPath, pullFileTree } from './pullFileTree'

const file = (path: string, over: Partial<PullFile> = {}): PullFile => ({ path, status: 'modified', additions: 1, deletions: 2, ...over })

describe('pullFileTree edges', () => {
  it('an empty PR is an empty tree', () => {
    expect(pullFileTree([])).toEqual([])
  })

  it('files at the root stay at the root, beside folders, in list order', () => {
    const tree = pullFileTree([file('README.md'), file('src/a.ts'), file('logo.png', { additions: 0, deletions: 0 })])
    expect(tree.map((n) => n.kind === 'file' ? n.name : `${n.name}/`)).toEqual(['README.md', 'src/', 'logo.png'])
  })

  it('hiding every file leaves no empty folder behind', () => {
    expect(pullFileTree([file('src/a.ts'), file('src/b/c.ts')], '', () => true)).toEqual([])
  })

  it('a filter of only spaces filters nothing', () => {
    expect(pullFileTree([file('a.ts'), file('b.ts')], '   ')).toHaveLength(2)
  })

  it('a rename is found by its old path, and placed under its new one', () => {
    const tree = pullFileTree([file('new/x.ts', { status: 'renamed', previousPath: 'old/x.ts' }), file('y.ts')], 'OLD/')
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ kind: 'folder', name: 'new' })
  })

  it('a 300-file PR keeps every file and sums the folder lines', () => {
    const files = Array.from({ length: 300 }, (_, i) => file(`src/f${i}.ts`))
    const [src] = pullFileTree(files)
    expect(src).toMatchObject({ kind: 'folder', additions: 300, deletions: 600 })
    expect(src.kind === 'folder' && src.children).toHaveLength(300)
  })
})

describe('openThreadsByPath edges', () => {
  it('no comments: an empty map when the resolved list is known', () => {
    expect(openThreadsByPath([], [])).toEqual(new Map())
  })
})
