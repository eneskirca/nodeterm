import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Link } from '@shared/types'
import { commitLinksThroughCanvas, setLinkCommitHandler } from './link-commit'

const links: Link[] = [{
  id: 'l1',
  kind: 'context',
  source: { ref: 'node', nodeId: 'a' },
  target: { ref: 'node', nodeId: 'b' }
}]

afterEach(() => setLinkCommitHandler(null))

describe('link commit bridge', () => {
  it('routes every inspector mutation through Canvas while mounted', () => {
    const commit = vi.fn()
    setLinkCommitHandler(commit)
    expect(commitLinksThroughCanvas('p1', links)).toBe(true)
    expect(commit).toHaveBeenCalledWith('p1', links)
  })

  it('reports an unavailable funnel instead of pretending a write landed', () => {
    expect(commitLinksThroughCanvas('p1', links)).toBe(false)
  })
})
