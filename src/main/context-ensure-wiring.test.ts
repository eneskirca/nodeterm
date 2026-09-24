// Exercise the router main actually injects into the core registrar; no source-text assertions.
import { describe, expect, it, vi } from 'vitest'
import { createRemoteContextEnsure } from '../core/remote-context-ensure'
import type { ContextEnsureQuery } from '../core/context-ensure'

const q: ContextEnsureQuery = { sessionId: 'session-1', nodeId: 'n', agentId: 'claude', accountId: 'a', cwd: '/r' }
function harness() {
  const claude = { pathFor: vi.fn<(sid: string) => string | undefined>(() => undefined), replay: vi.fn(), track: vi.fn() }
  const codex = vi.fn(async () => 'unresolved' as const)
  const isRemoteNode = vi.fn(() => true)
  const locateClaude = vi.fn<() => Promise<{ path: string } | undefined>>(async () => undefined)
  return { claude, codex, isRemoteNode, locateClaude,
    ensure: createRemoteContextEnsure({ claude, codex, isRemoteNode, locateClaude }) }
}
describe('desktop remote context routing', () => {
  it('only returns local fallback for a node not owned by an SSH project', async () => {
    const h = harness()
    expect(await h.ensure(q)).toBe('unresolved')
    h.isRemoteNode.mockReturnValue(false)
    expect(await h.ensure(q)).toBeNull()
    h.isRemoteNode.mockReturnValue(true)
    expect(await h.ensure({ ...q, nodeId: undefined })).toBeNull()
  })
  it('Codex goes only to its own host/account resolver, including failures; Gemini remains unsupported', async () => {
    const h = harness()
    expect(await h.ensure({ ...q, agentId: 'codex' })).toBe('unresolved')
    expect(h.codex).toHaveBeenCalledWith({ ...q, agentId: 'codex' })
    expect(await h.ensure({ ...q, agentId: 'gemini' })).toBe('unresolved')
    expect(h.locateClaude).not.toHaveBeenCalled()
    expect(h.claude.pathFor).not.toHaveBeenCalled()
  })
  it('Claude retries unresolved discovery and tracks only the jailed resolver result', async () => {
    const h = harness(), ref = { path: '/remote/.claude/projects/r/session-1.jsonl' }
    expect(await h.ensure(q)).toBe('unresolved')
    expect(h.claude.track).not.toHaveBeenCalled()
    h.locateClaude.mockResolvedValue(ref)
    expect(await h.ensure(q)).toBe('tracked')
    expect(h.locateClaude).toHaveBeenLastCalledWith(q)
    expect(h.claude.track).toHaveBeenCalledWith(q.sessionId, ref)
  })
  it('replays a tracked Claude session without another locator request, including the legacy agent shape', async () => {
    const h = harness()
    h.claude.pathFor.mockReturnValue('/tracked')
    expect(await h.ensure({ ...q, agentId: undefined })).toBe('tracked')
    expect(h.claude.replay).toHaveBeenCalledWith(q.sessionId)
    expect(h.locateClaude).not.toHaveBeenCalled()
  })
})
