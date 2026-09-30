import { describe, expect, it } from 'vitest'
import type { CanvasNodeState, Project } from '@shared/types'
import { projectMayDialSsh, receivedCanvasMutation, sanitizeRelayMutation, sanitizeRelayNode, sanitizeRelayProject } from './relay-ssh'

const EVIL = { host: 'evil.example', user: 'me', identityFile: '/home/me/.ssh/id_ed25519', extraArgs: '-A' }

const node = (over: Partial<CanvasNodeState>): CanvasNodeState =>
  ({ id: 'n1', kind: 'terminal', title: 'T', color: '#111', position: { x: 0, y: 0 }, ...over }) as CanvasNodeState

describe('relay-ssh', () => {
  it('strips the host project\'s ssh endpoint, keeping display strings only', () => {
    const p = sanitizeRelayProject({
      id: 'p',
      name: 'P',
      color: '#fff',
      viewport: { x: 0, y: 0, zoom: 1 },
      ssh: { server: EVIL, remoteCwd: '/srv' },
      nodes: [node({ ssh: EVIL, sshRemoteTmux: true })]
    } as Project)
    expect(p.ssh).toBeUndefined()
    expect(p.remote).toBe(true)
    expect(p.relaySsh).toEqual({ user: 'me', host: 'evil.example', remoteCwd: '/srv' })
    expect(p.nodes[0].ssh).toBeUndefined()
    expect(p.nodes[0].sshRemoteTmux).toBe(true) // still requireRemote on the host's core
    expect(JSON.stringify(p)).not.toContain('id_ed25519')
  })

  it('sanitizes display strings from the other machine', () => {
    const p = sanitizeRelayProject({
      id: 'p', name: 'P', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
      ssh: { server: { host: 'h\u001b[31m', user: 'u' }, remoteCwd: '/x' }
    } as Project)
    expect(p.relaySsh?.host).toBe('h[31m')
  })

  it('a plain ssh-terminal node (runs ssh on the HOST core) is left alone', () => {
    const n = node({ ssh: EVIL })
    expect(sanitizeRelayNode(n)).toBe(n)
  })

  it('strips upserts arriving on a relay session', () => {
    const m = sanitizeRelayMutation({ op: 'upsert', node: node({ ssh: EVIL, sshRemoteTmux: true }), seq: 3 })
    expect(m.op === 'upsert' && m.node.ssh).toBeFalsy()
    expect(m.op === 'upsert' && m.seq).toBe(3)
    const rm = { op: 'remove' as const, id: 'n1' }
    expect(sanitizeRelayMutation(rm)).toBe(rm)
  })

  it('receivedCanvasMutation: a relay session loses the remote origin and the ssh endpoint; a local one is untouched', () => {
    const m = { op: 'upsert' as const, node: node({ ssh: EVIL, sshRemoteTmux: true }), seq: 3, origin: 'core' as const }
    const relay = receivedCanvasMutation(m, true)
    expect(relay.origin).toBeUndefined()
    expect(relay.op === 'upsert' && relay.node.ssh).toBeFalsy()
    expect(relay.seq).toBe(3)
    expect(receivedCanvasMutation(m, false)).toBe(m)
    // What that means for a held launch is behaviour-tested in state/pending-launch-sync.test.ts.
  })

  it('projectMayDialSsh refuses exactly relay projects', () => {
    expect(projectMayDialSsh({ remote: true })).toBe(false)
    expect(projectMayDialSsh({})).toBe(true)
    expect(projectMayDialSsh(undefined)).toBe(true)
  })
})
