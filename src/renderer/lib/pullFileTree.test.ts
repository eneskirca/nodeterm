import { describe, expect, it } from 'vitest'
import type { PullFile } from '@shared/github-pull-detail'
import type { PullLineComment } from '@shared/github-pull-detail'
import { openThreadsByPath, pullFileTree, type PullTreeNode } from './pullFileTree'

const file = (path: string, additions = 1, deletions = 0, over: Partial<PullFile> = {}): PullFile =>
  ({ path, status: 'modified', additions, deletions, ...over })

/** The tree as indented lines: a folder with its sums, a file by its name. */
const lines = (nodes: readonly PullTreeNode[], depth = 0): string[] => nodes.flatMap((node) => node.kind === 'file'
  ? [`${'  '.repeat(depth)}${node.name}`]
  : [`${'  '.repeat(depth)}${node.name}/ +${node.additions} -${node.deletions}`, ...lines(node.children, depth + 1)])

describe('pullFileTree', () => {
  it('nests files under their folders in list order, with +/- summed per folder', () => {
    expect(lines(pullFileTree([
      file('src/a.ts', 3, 1), file('README.md', 2), file('src/lib/b.ts', 4, 2), file('src/c.ts', 1, 1)
    ]))).toEqual([
      'src/ +8 -4',
      '  a.ts',
      '  lib/ +4 -2',
      '    b.ts',
      '  c.ts',
      'README.md'
    ])
  })

  it('joins a chain of single folders into one row', () => {
    expect(lines(pullFileTree([file('src/renderer/nodes/a.ts'), file('src/renderer/nodes/b.ts')]))).toEqual([
      'src/renderer/nodes/ +2 -0', '  a.ts', '  b.ts'
    ])
  })

  it('keeps only the files whose path (or old path) holds the filter, ignoring case', () => {
    const files = [file('src/Pull.tsx'), file('src/b.ts', 1, 0, { previousPath: 'old/pull.ts', status: 'renamed' }), file('c.md')]
    expect(lines(pullFileTree(files, 'PULL'))).toEqual(['src/ +2 -0', '  Pull.tsx', '  b.ts'])
    expect(pullFileTree(files, 'nothing')).toEqual([])
    expect(lines(pullFileTree(files, '  '))).toHaveLength(4)
  })

  it('leaves out the files `hide` names, and their lines from the folder sums', () => {
    const files = [file('src/a.ts', 3, 1), file('src/b.ts', 2, 2), file('c.md')]
    expect(lines(pullFileTree(files, '', (f) => f.path === 'src/b.ts'))).toEqual(['src/ +3 -1', '  a.ts', 'c.md'])
    expect(pullFileTree(files, '', () => true)).toEqual([])
  })
})

describe('openThreadsByPath', () => {
  const at = (n: number) => `2026-10-01T09:0${n}:00Z`
  const c = (id: number, path: string, over: Partial<PullLineComment> = {}): PullLineComment => ({
    id, reviewId: 1, body: '', at: at(id), url: '', path, side: 'RIGHT', line: 2, outdated: false, ...over
  } as PullLineComment)

  it('counts the unresolved threads of each file, a reply in its thread', () => {
    const counts = openThreadsByPath([c(1, 'a.ts'), c(2, 'a.ts', { inReplyTo: 1 }), c(3, 'a.ts', { line: 9 }), c(4, 'b.ts'), c(5, 'd.ts')], [3, 5])
    expect(counts).toEqual(new Map([['a.ts', 1], ['b.ts', 1]]))
  })

  it('knows nothing when the read did not say which threads are resolved', () => {
    expect(openThreadsByPath([c(1, 'a.ts')], undefined)).toBeUndefined()
  })
})
