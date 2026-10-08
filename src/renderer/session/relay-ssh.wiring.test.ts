import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * SECURITY (source-level): the guest-side SSH dial sites each refuse a relay tab on their own, in
 * addition to the adopt boundary stripping `ssh` (relay-ssh.ts). These sites close over the
 * Electron preload and live React state, so their wiring is pinned here; the decisions themselves
 * are behaviour-tested in sshAttachments.test.ts and relay-ssh.test.ts.
 */
const read = (rel: string): string =>
  readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('relay tabs never reach a guest-side ssh dial', () => {
  const canvas = read('canvas/Canvas.tsx')
  const node = read('nodes/TerminalNode.tsx')

  it('the active-project effect dials only what planActiveProjectDials returns', () => {
    expect(canvas).toContain('const dials = planActiveProjectDials(project)')
    expect(canvas).toContain('if (dials.own) {')
    expect(canvas).toContain('for (const attachment of dials.attachments) {')
    expect(canvas).not.toMatch(/if \(project\.ssh\) \{\n\s+const ssh = project\.ssh\n\s+\/\/ SSH remote projects are free/)
  })

  it('the reconnect coordinator refuses a relay project', () => {
    expect(canvas).toContain('if (!project?.ssh || !projectMayDialSsh(project)) return false')
  })

  it('relay canvas-sync mutations are stripped', () => {
    // The decision itself is behaviour-tested in relay-ssh.test.ts (`receivedCanvasMutation`).
    expect(canvas).toContain('const mutation = receivedCanvasMutation(received, relay)')
  })

  it('a relay terminal never resolves a guest-local ControlMaster', () => {
    expect(node).toContain("const dialsSsh = sshRemoteTmux && session.source !== 'relay'")
    expect(node).toMatch(/dialsSsh && ssh\n\s+\? await resolveSshRemote\(/)
    expect(node).not.toMatch(/sshRemoteTmux && ssh\n\s+\? await resolveSshRemote\(/)
    expect(node).toContain('if (!projectMayDialSsh(useProjects.getState().getProject(ownerProjectId))) return undefined')
    expect(node).toContain('const projectId = sshConnectionScope(conn, ownerProjectId)')
  })
})
