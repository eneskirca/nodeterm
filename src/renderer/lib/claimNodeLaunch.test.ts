import { afterEach, describe, expect, it } from 'vitest'
import { claimNodeLaunch, nodeLaunchClaimed, releaseNodeLaunch } from './claimNodeLaunch'

afterEach(() => {
  releaseNodeLaunch('a')
  releaseNodeLaunch('b')
})

describe('claimNodeLaunch', () => {
  it('the first caller wins; a second is refused', () => {
    expect(claimNodeLaunch('a')).toBe(true)
    expect(claimNodeLaunch('a')).toBe(false)
    expect(nodeLaunchClaimed('a')).toBe(true)
  })

  it('does not leak across node ids', () => {
    expect(claimNodeLaunch('a')).toBe(true)
    expect(claimNodeLaunch('b')).toBe(true)
  })

  it('a released claim can be taken again (viewer remounted before delivery started)', () => {
    expect(claimNodeLaunch('a')).toBe(true)
    releaseNodeLaunch('a')
    expect(claimNodeLaunch('a')).toBe(true)
  })

  it('refuses an empty id rather than claiming a poison key', () => {
    expect(claimNodeLaunch('')).toBe(false)
  })
})
