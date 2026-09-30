// The project-scoped relay session as a boundary (scoped-guest-policy.ts), plus the host-only
// channels every relay peer is refused (shared/host-control.ts, enforced in relay-host.ts `serve`).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '../../shared/ipc'
import { encodePtyData } from '../../shared/rpc'
import {
  decideScopedAccess,
  filterScopedEvent,
  scopeForTest,
  scopedGuestHooks,
  type ScopedGuestDeps
} from './scoped-guest-policy'
import { connectRelayHost, type PeerAttach } from './relay-host'
import { connectRelayClient } from './relay-client'
import { transportPair } from './transport-pair'
import { genKeyPair, publicKeyToB64 } from './e2ee'
import type { RpcRequest } from '../../shared/rpc'

let tmp: string
let root: string // the shared project's folder
let other: string // another project's folder
let dataDir: string // this app's own data dir, planted INSIDE the shared root
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-guest-')))
  root = path.join(tmp, 'alpha')
  other = path.join(tmp, 'beta')
  dataDir = path.join(root, 'appdata')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(other, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a')
  fs.writeFileSync(path.join(other, 'secret.txt'), 's')
  fs.writeFileSync(path.join(dataDir, 'license.json'), '{}')
  // A symlink planted INSIDE the project that points OUT of it, and a dangling one.
  fs.symlinkSync(path.join(other, 'secret.txt'), path.join(root, 'escape.txt'))
  fs.symlinkSync(path.join(other, 'not-yet.txt'), path.join(root, 'dangling.txt'))
  fs.symlinkSync(other, path.join(root, 'escape-dir'))
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const NODES: Record<string, string[]> = {
  a1: ['alpha'],
  b1: ['beta'],
  both: ['alpha', 'beta'] // an id copied into another project
}
const SESSIONS: Record<string, string> = { sA: 'a1', sB: 'b1' }
const deps = (): ScopedGuestDeps => ({
  projectsOfNode: (id) => NODES[id] ?? [],
  nodeOfSession: (sid) => SESSIONS[sid],
  projectCwd: (p) => (p === 'alpha' ? root : p === 'beta' ? other : undefined),
  hostDataDir: dataDir
})
const decide = (method: string, ...args: unknown[]) => decideScopedAccess('alpha', deps(), method, args)
const allowed = (method: string, ...args: unknown[]) => decide(method, ...args).allow

describe('scoped guest — refused outright', () => {
  it('refuses an unknown or new channel (fail closed)', () => {
    expect(allowed('some:new-channel')).toBe(false)
    expect(allowed('constructor')).toBe(false)
  })
  it('refuses the host settings, license and whole-workspace writes', () => {
    expect(allowed(IPC.settingsSave, {})).toBe(false)
    expect(allowed(IPC.settingsLoad)).toBe(false)
    expect(allowed(IPC.agentDiscoverModels, {})).toBe(false)
    expect(allowed(IPC.licenseDeactivate)).toBe(false)
    expect(allowed(IPC.workspaceSave, {})).toBe(false)
  })
})

describe('scoped guest — terminals', () => {
  it('opens a terminal for an in-project node, cwd defaulted to the project root', () => {
    const d = decide(IPC.ptyCreate, { persistKey: 'a1', cols: 80, rows: 24, shell: '/bin/zsh' })
    expect(d.allow).toBe(true)
    expect(d.allow && d.args?.[0]).toMatchObject({ persistKey: 'a1', cwd: root, shell: '/bin/zsh' })
  })
  it('refuses to attach to another project\'s node, or a node shared with another project', () => {
    expect(allowed(IPC.ptyCreate, { persistKey: 'b1', cols: 80, rows: 24 })).toBe(false)
    expect(allowed(IPC.ptyCreate, { persistKey: 'both', cols: 80, rows: 24 })).toBe(false)
    expect(allowed(IPC.ptyCreate, { persistKey: 'nobody', cols: 80, rows: 24 })).toBe(false)
    expect(allowed(IPC.ptyCreate, { cols: 80, rows: 24 })).toBe(false)
  })
  it('refuses a cwd outside the project (incl. through a symlink) and a foreign owner project', () => {
    expect(allowed(IPC.ptyCreate, { persistKey: 'a1', cwd: other, cols: 1, rows: 1 })).toBe(false)
    expect(allowed(IPC.ptyCreate, { persistKey: 'a1', cwd: path.join(root, 'escape-dir'), cols: 1, rows: 1 })).toBe(false)
    expect(allowed(IPC.ptyCreate, { persistKey: 'a1', cwd: path.join(root, 'src'), cols: 1, rows: 1 })).toBe(true)
    expect(allowed(IPC.ptyCreate, { persistKey: 'a1', ownerProjectId: 'beta', cols: 1, rows: 1 })).toBe(false)
  })
  it('drops an ssh route the guest names', () => {
    const d = decide(IPC.ptyCreate, {
      persistKey: 'a1', cols: 1, rows: 1,
      sshRemote: { controlPath: '/x', conn: { extraArgs: ['-oProxyCommand=touch /tmp/pwned'] }, remoteCwd: '/' }
    })
    expect(d.allow && (d.args?.[0] as Record<string, unknown>).sshRemote).toBeUndefined()
  })
  it('judges session-id and persistKey verbs by the node', () => {
    expect(allowed(IPC.ptyWrite, 'sA', 'ls\r')).toBe(true)
    expect(allowed(IPC.ptyWrite, 'sB', 'ls\r')).toBe(false)
    expect(allowed(IPC.ptyWrite, 'unknown', 'ls\r')).toBe(false)
    expect(allowed(IPC.ptyCapture, 'a1')).toBe(true)
    expect(allowed(IPC.ptyCapture, 'b1')).toBe(false)
    expect(allowed(IPC.ptyDestroy, 'b1')).toBe(false)
    expect(allowed(IPC.ptySendText, 'b1', 'x')).toBe(false)
    expect(allowed(IPC.contextEnsure, 's', root, undefined, 'b1', 'claude')).toBe(false)
    expect(allowed(IPC.contextEnsure, 's', root, undefined, 'a1', 'claude')).toBe(true)
  })
})

describe('scoped guest — files and git', () => {
  it('reads inside the root, refuses outside and through a planted symlink', () => {
    expect(allowed(IPC.fsRead, path.join(root, 'src', 'a.ts'))).toBe(true)
    expect(allowed(IPC.fsList, root)).toBe(true)
    expect(allowed(IPC.fsRead, path.join(other, 'secret.txt'))).toBe(false)
    expect(allowed(IPC.fsRead, path.join(root, '..', 'beta', 'secret.txt'))).toBe(false)
    expect(allowed(IPC.fsRead, path.join(root, 'escape.txt'))).toBe(false)
    expect(allowed(IPC.fsList, path.join(root, 'escape-dir'))).toBe(false)
    expect(allowed(IPC.fsRead, '~/.ssh/id_rsa')).toBe(false)
    expect(allowed(IPC.fsRead, 'relative.txt')).toBe(false)
  })
  it('never reaches the app data dir, even inside the shared root', () => {
    expect(allowed(IPC.fsRead, path.join(dataDir, 'license.json'))).toBe(false)
  })
  it('writes a new file inside the root, refuses through a dangling symlink or an escaping dir', () => {
    expect(allowed(IPC.fsWrite, path.join(root, 'src', 'new', 'b.ts'), 'x')).toBe(true)
    expect(allowed(IPC.fsWrite, path.join(root, 'dangling.txt'), 'x')).toBe(false)
    expect(allowed(IPC.fsWrite, path.join(root, 'escape-dir', 'planted.txt'), 'x')).toBe(false)
    expect(allowed(IPC.fsMkdir, path.join(other, 'x'))).toBe(false)
  })
  it('jails git working directories and its option-shaped arguments', () => {
    expect(allowed(IPC.gitStatus, root)).toBe(true)
    expect(allowed(IPC.gitStatus, other)).toBe(false)
    expect(allowed(IPC.gitShowFile, root, '--output=/tmp/x', 'a.ts')).toBe(false)
    expect(allowed(IPC.gitShowFile, root, 'HEAD', 'a.ts')).toBe(true)
    expect(allowed(IPC.gitDiff, root, path.join(other, 'secret.txt'), false, true)).toBe(false)
    expect(allowed(IPC.gitDiff, root, 'src/a.ts', false, false)).toBe(true)
    expect(allowed(IPC.gitSetActiveRemote, 'beta')).toBe(false)
  })
  it('allows a worktree inside the root or in the default `<root>.worktrees` sibling only', () => {
    expect(allowed(IPC.gitWorktreeAdd, root, path.join(tmp, 'alpha.worktrees', 'feat'), 'feat', 'main', true)).toBe(true)
    expect(allowed(IPC.gitWorktreeAdd, root, path.join(tmp, 'beta', 'feat'), 'feat', 'main', true)).toBe(false)
  })
})

describe('scoped guest — canvas, board and GitHub', () => {
  it('refuses board and issue calls naming another project', () => {
    expect(allowed(IPC.boardLogSubscribe, 'alpha')).toBe(true)
    expect(allowed(IPC.boardLogSubscribe, 'beta')).toBe(false)
    expect(allowed(IPC.githubIssuesQuery, { projectId: 'beta' })).toBe(false)
    expect(allowed(IPC.githubIssuesQuery, { projectId: 'alpha' })).toBe(true)
  })
  it('refuses a canvas mutation into another project, or adopting another project\'s node id', () => {
    const node = (id: string) => ({ op: 'upsert', node: { id, kind: 'terminal', position: { x: 0, y: 0 } } })
    expect(allowed(IPC.canvasMut, 'beta', node('fresh'))).toBe(false)
    expect(allowed(IPC.canvasMut, 'alpha', node('b1'))).toBe(false)
    expect(allowed(IPC.canvasMut, 'alpha', { op: 'remove', id: 'b1' })).toBe(false)
    expect(allowed(IPC.canvasMut, 'alpha', node('a1'))).toBe(true)
  })
  it('a node the guest just created is in scope for its first terminal (before the host saves)', () => {
    const hooks = scopedGuestHooks('alpha', deps())
    const ask = (method: string, ...args: unknown[]) => hooks.access!(null as never, 'req', method, args)
    expect(ask(IPC.ptyCreate, { persistKey: 'fresh', cols: 1, rows: 1 }).allow).toBe(false)
    const upsert = { op: 'upsert', node: { id: 'fresh', kind: 'terminal', position: { x: 0, y: 0 } } }
    expect(ask(IPC.canvasMut, 'alpha', upsert).allow).toBe(true)
    expect(ask(IPC.ptyCreate, { persistKey: 'fresh', cols: 1, rows: 1 }).allow).toBe(true)
  })
})

describe('scoped guest — what it receives', () => {
  const ev = (channel: string, ...args: unknown[]) => JSON.stringify({ t: 'ev', channel, args })
  it('drops other projects\' events and the host log; keeps its own', () => {
    const s = scopeForTest('alpha', deps())
    const owners = new Map<string, string>()
    expect(filterScopedEvent(ev(IPC.canvasMut, 'beta', { op: 'remove', id: 'b1' }), s, owners)).toBe(false)
    expect(filterScopedEvent(ev(IPC.canvasMut, 'alpha', { op: 'remove', id: 'a1' }), s, owners)).toBe(true)
    expect(filterScopedEvent(ev(IPC.agentStatus, { nodeId: 'b1' }), s, owners)).toBe(false)
    expect(filterScopedEvent(ev(IPC.agentStatus, { nodeId: 'a1' }), s, owners)).toBe(true)
    expect(filterScopedEvent(ev(IPC.logBatch, []), s, owners)).toBe(false)
    expect(filterScopedEvent(ev(IPC.githubIssuesChanged('alpha'), [1]), s, owners)).toBe(true)
    expect(filterScopedEvent(ev(IPC.githubIssuesChanged('beta'), [1]), s, owners)).toBe(false)
    expect(filterScopedEvent(ev(IPC.workspaceExternalChange, { id: 'beta' }), s, owners)).toBe(false)
  })
  it('delivers terminal bytes only for the shared project\'s sessions', () => {
    const hooks = scopedGuestHooks('alpha', deps())
    const got: string[] = []
    const sink = hooks.wrapSink!(null as never, {
      sendText: () => {},
      sendBinary: (b) => got.push(Buffer.from(b).toString('hex'))
    })
    sink.sendBinary(encodePtyData('sB', 'secret'))
    sink.sendBinary(encodePtyData('sA', 'ok'))
    expect(got.length).toBe(1)
  })
})

// ── End to end, through the relay host's own serve loop ────────────────────────────────────────

function openHost(hooks?: Parameters<typeof connectRelayHost>[0]['hooks']) {
  const hostKeys = genKeyPair()
  const { hostT, peerT } = transportPair()
  const dispatched: RpcRequest[] = []
  const casts: string[] = []
  const attach: PeerAttach = {
    attach: () => 1,
    detach: () => {},
    dispatch: async (_id, req) => { dispatched.push(req); return { t: 'res', id: req.id, ok: true, result: 'ok' } },
    cast: (_id, method) => { casts.push(method) }
  }
  const opened: string[] = []
  const frames: string[] = []
  connectRelayHost({
    url: 'ws://127.0.0.1/x', token: 't', ourKeys: hostKeys, attach, transport: hostT, autoApprove: () => true,
    sharedProjectId: hooks ? 'alpha' : undefined, hooks,
    onPeerPending: () => {}, onOpen: () => opened.push('host'), onClose: () => {}
  })
  const client = connectRelayClient({
    url: 'ws://127.0.0.1/x', token: 't', hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: genKeyPair(),
    transport: peerT, autoApprove: true, onSas: () => {}, onApproved: () => opened.push('peer'),
    onFrame: (j) => frames.push(j), onPtyData: () => {}, onClose: () => {}
  })
  return { client, dispatched, casts, opened, frames }
}

describe('relay host — scoped session end to end', () => {
  it('refuses out-of-scope requests without dispatching them, and serves in-scope ones', async () => {
    const t = openHost(scopedGuestHooks('alpha', deps()))
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 1, method: IPC.fsRead, args: [path.join(other, 'secret.txt')] }))
    t.client.send(JSON.stringify({ t: 'req', id: 2, method: IPC.ptyCreate, args: [{ persistKey: 'b1', cols: 1, rows: 1 }] }))
    t.client.send(JSON.stringify({ t: 'cast', method: IPC.ptyWrite, args: ['sB', 'rm -rf ~\r'] }))
    t.client.send(JSON.stringify({ t: 'req', id: 3, method: IPC.fsRead, args: [path.join(root, 'src', 'a.ts')] }))
    await vi.waitFor(() => expect(t.dispatched.map((r) => r.id)).toEqual([3]))
    await vi.waitFor(() => expect(t.frames.filter((f) => f.includes('E_ROLE')).length).toBe(2))
    expect(t.casts).toEqual([])
  })
})

describe('relay host — host-only channels refused to every peer', () => {
  it('refuses settings, license and credential channels even with no policy hooks', async () => {
    const t = openHost()
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    const methods = [
      IPC.settingsSave, IPC.settingsLoad, IPC.agentDiscoverModels, IPC.agentGatewayCredentialSave,
      IPC.licenseActivate, IPC.licenseDeactivate, IPC.claudeAccountsAdd, IPC.usageRemote, IPC.relayHostInvite
    ]
    methods.forEach((method, i) => t.client.send(JSON.stringify({ t: 'req', id: 100 + i, method, args: [] })))
    t.client.send(JSON.stringify({ t: 'cast', method: IPC.settingsSave, args: [{}] }))
    t.client.send(JSON.stringify({ t: 'req', id: 999, method: IPC.workspaceLoad, args: [] }))
    await vi.waitFor(() => expect(t.frames.filter((f) => f.includes('E_FORBIDDEN')).length).toBe(methods.length))
    await vi.waitFor(() => expect(t.dispatched.map((r) => r.method)).toEqual([IPC.workspaceLoad]))
    expect(t.casts).toEqual([])
  })
  it('still lets a hosted team\'s own verbs through to their interceptor', async () => {
    const t = openHost()
    await vi.waitFor(() => expect(t.opened.length).toBe(2))
    t.client.send(JSON.stringify({ t: 'req', id: 5, method: IPC.relayHostedSelf, args: [] }))
    await vi.waitFor(() => expect(t.dispatched.map((r) => r.method)).toEqual([IPC.relayHostedSelf]))
  })
})

describe('project documents reach peers without exec fields', () => {
  // `shell` and a held `pendingLaunch` (its command text included) are exec fields
  // stripSharedNodeExec removes.
  const project = (id: string) => ({
    id,
    name: id,
    nodes: [{ id: 'a1', kind: 'terminal', position: { x: 0, y: 0 }, shell: '/usr/bin/evil', pendingLaunch: { after: [], command: 'claude "held prompt text"' } }]
  })
  const ev = (channel: string, ...args: unknown[]) => JSON.stringify({ t: 'ev', channel, args })

  it('scoped guest: workspace:server-change for the shared project arrives stripped; other projects never', () => {
    const hooks = scopedGuestHooks('alpha', deps())
    const got: string[] = []
    const sink = hooks.wrapSink!(null as never, { sendText: (j) => got.push(j), sendBinary: () => {} })
    sink.sendText(ev(IPC.workspaceServerChange, project('beta')))
    sink.sendText(ev(IPC.workspaceServerChange, project('alpha')))
    sink.sendText(ev(IPC.workspaceExternalChange, project('alpha')))
    expect(got).toHaveLength(2)
    for (const j of got) {
      const node = JSON.parse(j).args[0].nodes[0]
      expect(node.id).toBe('a1')
      expect(node.shell).toBeUndefined()
      expect(node.pendingLaunch).toBeUndefined()
      expect(j).not.toContain('held prompt text')
    }
  })

  it('scoped guest: workspace:load response is stripped', () => {
    const hooks = scopedGuestHooks('alpha', deps())
    const out = hooks.narrowResponse!(null as never, IPC.workspaceLoad, { projects: [project('alpha')] }) as {
      projects: Array<{ nodes: Array<{ shell?: string; pendingLaunch?: unknown }> }>
    }
    expect(out.projects[0].nodes[0].shell).toBeUndefined()
    expect(out.projects[0].nodes[0].pendingLaunch).toBeUndefined()
  })
})
