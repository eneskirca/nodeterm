// Relay edges for the pull node's writes: every owner-only channel is also refused to a scoped guest,
// and the refusal holds for an unknown role, a cast, and junk arguments.
import { describe, expect, it } from 'vitest'
import { IPC } from '../../shared/ipc'
import { decideAccess, OWNER_ONLY, type AccessContext } from './access-policy'
import { SCOPED_REFUSED, decideScopedAccess, type ScopedGuestDeps } from './scoped-guest-policy'

const ctx = (role: string): AccessContext => ({
  role: role as AccessContext['role'],
  sharedProjects: new Set(['P']),
  projectsOfNode: () => ['P'],
  nodeOfSession: () => undefined,
  projectCwds: () => [],
  hostDataDir: '/data',
  realpath: (p) => p,
  isFile: () => false
})

describe('pull writes over the relay', () => {
  it('the owner-only set holds the pull writes', () => {
    expect(OWNER_ONLY.has(IPC.githubIssuesPullMerge) && OWNER_ONLY.has(IPC.githubIssuesPullWatchSet)).toBe(true)
  })

  it('every owner-only channel is refused to a scoped guest too', () => {
    for (const m of OWNER_ONLY) expect(SCOPED_REFUSED.has(m), m).toBe(true)
  })

  it('an unknown role, a cast and junk arguments are refused like a viewer', () => {
    for (const m of OWNER_ONLY) {
      expect(decideAccess('req', m, [], ctx('admin')).allow, `${m} admin`).toBe(false)
      expect(decideAccess('req', m, [], ctx('')).allow, `${m} empty role`).toBe(false)
      expect(decideAccess('cast', m, [{ projectId: 'P' }], ctx('editor')).allow, `${m} cast`).toBe(false)
      expect(decideAccess('req', m, [null, 7, '__proto__'], ctx('commenter')).allow, `${m} junk`).toBe(false)
    }
  })

  it('a scoped guest is refused every owner-only channel whatever the arguments name', () => {
    const deps = {} as ScopedGuestDeps
    for (const m of OWNER_ONLY) {
      for (const args of [[], [{ projectId: 'alpha', repository: 'o/r', pullNumber: 1 }], ['alpha', 'o/r', 1]]) {
        expect(decideScopedAccess('alpha', deps, m, args).allow, `${m} ${JSON.stringify(args)}`).toBe(false)
      }
    }
  })
})
