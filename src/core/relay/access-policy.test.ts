import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  decideAccess,
  filterOutboundEvent,
  narrowResponseForRole,
  wrapSinkForRole,
  type AccessContext
} from './access-policy'
import { IPC } from '../../shared/ipc'
import { encodePtyData } from '../../shared/rpc'
import type { UiSink } from '../ui-sink-registry'

const ctx = (role: AccessContext['role']): AccessContext => ({
  role,
  sharedProjects: new Set(['P']),
  projectsOfNode: (id) => (id === 'n1' ? ['P'] : id === 'n2' ? ['Q'] : []),
  // Terminal sessions: 's' / 's1' run node n1 (project P, shared), 's2' runs n2 (project Q, not).
  nodeOfSession: (sid) => (sid === 's' || sid === 's1' ? 'n1' : sid === 's2' ? 'n2' : undefined),
  projectCwds: () => ['/srv/app'],
  hostDataDir: '/var/lib/nodeterm-data',
  realpath: (p) => (p.startsWith('/srv/app/link') ? '/etc/passwd' : p),
  // Every mock root is the top of its own repository unless a helper says otherwise.
  isFile: (p) => p.endsWith('/.git/HEAD')
})

describe('access policy', () => {
  it('editors and owners pass everything untouched', () => {
    expect(decideAccess('req', IPC.fsWrite, ['/x', 'y'], ctx('editor'))).toEqual({ allow: true })
    expect(decideAccess('req', IPC.ptyCreate, [{ persistKey: 'n2' }], ctx('owner'))).toEqual({ allow: true })
  })
  it('a viewer may not write, destroy, send text or mutate the canvas', () => {
    for (const m of [IPC.fsWrite, IPC.ptyDestroy, IPC.ptySendText, IPC.gitCommit, IPC.settingsLoad]) {
      expect(decideAccess('req', m, [], ctx('viewer')).allow).toBe(false)
    }
    expect(decideAccess('cast', IPC.ptyWrite, ['s', 'ls\r'], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('cast', IPC.canvasMut, ['P', {}], ctx('viewer')).allow).toBe(false)
  })
  it('viewer pty:create joins only, never votes size, and only in shared projects', () => {
    expect(decideAccess('req', IPC.ptyCreate, [{ persistKey: 'n1', cols: 80, rows: 24 }], ctx('viewer')))
      .toEqual({ allow: true, args: [{ persistKey: 'n1', cols: 80, rows: 24, joinOnly: true, sizeVote: false }] })
    expect(decideAccess('req', IPC.ptyCreate, [{ persistKey: 'n2' }], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.ptyCreate, [{ persistKey: 'unknown' }], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.ptyCreate, [{}], ctx('viewer')).allow).toBe(false)
  })
  it('viewer resize is rewritten to "not looking"', () => {
    expect(decideAccess('cast', IPC.ptyResize, ['s', 40, 10, 'v'], ctx('viewer')))
      .toEqual({ allow: true, args: ['s', null, null, 'v'] })
  })
  it('fs reads are jailed to shared project cwds, symlinks included', () => {
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/README.md'], ctx('viewer')).allow).toBe(true)
    expect(decideAccess('req', IPC.fsRead, ['/root/.ssh/id_rsa'], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/link'], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/../../etc/passwd'], ctx('viewer')).allow).toBe(false)
  })
  it('commenter may chat and append to a shared board, viewer may not', () => {
    expect(decideAccess('cast', IPC.presenceChat, ['hi'], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('cast', IPC.presenceChat, ['hi'], ctx('commenter')).allow).toBe(true)
    const comment = { id: 'c', ts: 1, kind: 'comment', author: { name: 'A', color: '#fff' }, text: 'hi' }
    expect(decideAccess('req', IPC.boardLogAppend, ['P', comment], ctx('commenter')).allow).toBe(true)
    expect(decideAccess('req', IPC.boardLogAppend, ['Q', comment], ctx('commenter')).allow).toBe(false)
  })
  it('M1: a commenter appends COMMENTS only — an activity entry ("moved card to Done") is refused', () => {
    const COMMENTS_ONLY = 'Commenters can only add comments to the board log.'
    const entry = (kind: unknown) => ({ id: 'e1', ts: 1, author: { name: 'Owner', color: '#fff' }, kind, event: { type: 'card-moved' } })
    // Allowed, and reduced to a comment's own fields (the `event` is dropped — security audit F3).
    expect(decideAccess('req', IPC.boardLogAppend, ['P', entry('comment')], ctx('commenter'))).toEqual({
      allow: true,
      args: ['P', { id: 'e1', ts: 1, author: { name: 'Owner', color: '#fff' }, kind: 'comment' }]
    })
    expect(decideAccess('req', IPC.boardLogAppend, ['P', entry('event')], ctx('commenter'))).toEqual({ allow: false, message: COMMENTS_ONLY })
    for (const bad of [undefined, null, 'comment', ['comment'], {}]) {
      expect(decideAccess('req', IPC.boardLogAppend, ['P', bad], ctx('commenter')).allow, String(bad)).toBe(false)
    }
    // Editors write activity entries (the board's own diff funnel runs in their tab).
    expect(decideAccess('req', IPC.boardLogAppend, ['P', entry('event')], ctx('editor'))).toEqual({ allow: true })
  })
  it('outbound: non-shared canvas and agent events are dropped for non-editors only', () => {
    const mutQ = JSON.stringify({ t: 'ev', channel: IPC.canvasMut, args: ['Q', {}] })
    const statusN2 = JSON.stringify({ t: 'ev', channel: IPC.agentStatus, args: [{ nodeId: 'n2' }] })
    const statusN1 = JSON.stringify({ t: 'ev', channel: IPC.agentStatus, args: [{ nodeId: 'n1' }] })
    expect(filterOutboundEvent(mutQ, ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(statusN2, ctx('commenter'))).toBe(false)
    expect(filterOutboundEvent(statusN1, ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(mutQ, ctx('editor'))).toBe(true)
  })
})

describe('access policy: the fs jail', () => {
  const made: string[] = []
  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('a project reached through a symlinked cwd is readable (the cwd is realpathed too)', () => {
    // /work/app is a symlink to /data/app: the file realpaths under /data/app, the cwd must as well.
    const c: AccessContext = {
      ...ctx('viewer'),
      projectCwds: () => ['/work/app'],
      realpath: (p) => (p.startsWith('/work/app') ? '/data/app' + p.slice('/work/app'.length) : p)
    }
    expect(decideAccess('req', IPC.fsRead, ['/work/app/README.md'], c).allow).toBe(true)
    expect(decideAccess('req', IPC.fsList, ['/work/app'], c).allow).toBe(true)
    expect(decideAccess('req', IPC.fsRead, ['/data/app/README.md'], c).allow).toBe(true)
    expect(decideAccess('req', IPC.fsRead, ['/data/other/x'], c).allow).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'a real symlinked project dir on disk (symlink creation needs privileges on Windows)',
    () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'access-')))
      made.push(root)
      fs.mkdirSync(path.join(root, 'real', 'app'), { recursive: true })
      fs.writeFileSync(path.join(root, 'real', 'app', 'README.md'), 'hi')
      fs.writeFileSync(path.join(root, 'secret.txt'), 'nope')
      fs.symlinkSync(path.join(root, 'real', 'app'), path.join(root, 'link'))
      // An escape planted INSIDE the project: a symlink to a file outside it.
      fs.symlinkSync(path.join(root, 'secret.txt'), path.join(root, 'real', 'app', 'escape'))
      const c: AccessContext = {
        role: 'viewer',
        sharedProjects: new Set(['P']),
        projectsOfNode: () => [],
        nodeOfSession: () => undefined,
        hostDataDir: '/nonexistent-nodeterm-data',
        projectCwds: () => [path.join(root, 'link')],
        realpath: (p) => {
          try {
            return fs.realpathSync(p)
          } catch {
            return null
          }
        },
        isFile: (p) => {
          try {
            return fs.statSync(p).isFile()
          } catch {
            return false
          }
        }
      }
      expect(decideAccess('req', IPC.fsRead, [path.join(root, 'link', 'README.md')], c).allow).toBe(true)
      expect(decideAccess('req', IPC.fsRead, [path.join(root, 'real', 'app', 'README.md')], c).allow).toBe(true)
      expect(decideAccess('req', IPC.fsList, [path.join(root, 'link')], c).allow).toBe(true)
      expect(decideAccess('req', IPC.fsRead, [path.join(root, 'link', 'escape')], c).allow).toBe(false)
      expect(decideAccess('req', IPC.fsRead, [path.join(root, 'secret.txt')], c).allow).toBe(false)
      expect(decideAccess('req', IPC.fsRead, [path.join(root, 'link', 'missing')], c).allow).toBe(false)
    }
  )

  it('refuses relative and ~ paths, sibling-prefix dirs, and non-strings', () => {
    const v = ctx('viewer')
    expect(decideAccess('req', IPC.fsRead, ['README.md'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['~/.ssh/id_rsa'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['/srv/app2/secret'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['/srv/ap'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, [42], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, [], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsList, ['/srv/app'], v).allow).toBe(true)
    expect(decideAccess('req', IPC.fsExists, ['/srv/app/x'], v).allow).toBe(true)
    expect(decideAccess('req', IPC.fsReadBinary, ['/srv/app/logo.png'], v).allow).toBe(true)
  })

  // Security audit F4: a share rooted at `/` handed a viewer every file on the machine. It is no
  // longer a root at all (share-root.ts); the other shared roots are unaffected.
  it('a project whose cwd is the filesystem root is not a root: nothing under it is readable', () => {
    const c: AccessContext = { ...ctx('viewer'), projectCwds: () => ['/'] }
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/README.md'], c).allow).toBe(false)
    const both: AccessContext = { ...ctx('viewer'), projectCwds: () => ['/', '/srv/app'] }
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/README.md'], both).allow).toBe(true)
    expect(decideAccess('req', IPC.fsRead, ['/etc/hostname'], both).allow).toBe(false)
  })

  it('a cwd that is not absolute is never a root', () => {
    const c: AccessContext = { ...ctx('viewer'), projectCwds: () => ['', 'srv'] }
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/README.md'], c).allow).toBe(false)
  })

  it('no shared project cwd means nothing is readable', () => {
    const c: AccessContext = { ...ctx('viewer'), projectCwds: () => [] }
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/README.md'], c).allow).toBe(false)
  })
})

describe('access policy: argument checks that "read" alone would not make safe', () => {
  it('viewer pty:create keeps ONLY the join fields — no ssh route, shell, account or env', () => {
    const d = decideAccess(
      'req',
      IPC.ptyCreate,
      [{
        persistKey: 'n1', cols: 80, rows: 24, viewerId: 'modal',
        shell: '/bin/sh', shellArgs: ['-c', 'touch /tmp/x'], cwd: '/', agentId: 'claude', accountId: 'a1',
        ownerProjectId: 'P', clearEnv: true, requireRemote: false, agentModel: 'm',
        sshRemote: { controlPath: '/tmp/cp', remoteCwd: '/', conn: { host: 'h', user: 'u', extraArgs: '-oProxyCommand=touch /tmp/pwn', execTrusted: true } },
        joinOnly: false, sizeVote: true
      }],
      ctx('viewer')
    )
    expect(d).toEqual({
      allow: true,
      args: [{ persistKey: 'n1', cols: 80, rows: 24, viewerId: 'modal', joinOnly: true, sizeVote: false }]
    })
  })

  it('viewer pty:create refuses a non-object or array options argument', () => {
    expect(decideAccess('req', IPC.ptyCreate, [], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.ptyCreate, [null], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.ptyCreate, ['n1'], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('req', IPC.ptyCreate, [['n1']], ctx('viewer')).allow).toBe(false)
  })

  it('viewer pty:create drops a non-numeric size and a non-string viewerId', () => {
    expect(decideAccess('req', IPC.ptyCreate, [{ persistKey: 'n1', cols: '80', rows: null, viewerId: 7 }], ctx('viewer')))
      .toEqual({ allow: true, args: [{ persistKey: 'n1', joinOnly: true, sizeVote: false }] })
  })

  it('a viewer may resume its own flow but never pause the shared pty', () => {
    expect(decideAccess('cast', IPC.ptyFlow, ['s', true], ctx('viewer'))).toEqual({ allow: true })
    expect(decideAccess('cast', IPC.ptyFlow, ['s', true, 'modal'], ctx('viewer'))).toEqual({ allow: true })
    expect(decideAccess('cast', IPC.ptyFlow, ['s', false], ctx('viewer')).allow).toBe(false)
    expect(decideAccess('cast', IPC.ptyFlow, ['s', 0], ctx('commenter')).allow).toBe(false)
    expect(decideAccess('cast', IPC.ptyFlow, ['s', false], ctx('editor')).allow).toBe(true)
    expect(decideAccess('cast', IPC.ptyKill, ['s'], ctx('viewer')).allow).toBe(true)
  })

  it('viewer resize without a viewerId stays three arguments', () => {
    expect(decideAccess('cast', IPC.ptyResize, ['s', 40, 10], ctx('viewer')))
      .toEqual({ allow: true, args: ['s', null, null] })
  })

  it('terminal reads are limited to nodes of shared projects', () => {
    for (const m of [IPC.ptyCapture, IPC.ptyReadScrollback, IPC.ptyPaneCommand]) {
      expect(decideAccess('req', m, ['n1'], ctx('viewer')).allow).toBe(true)
      expect(decideAccess('req', m, ['n2'], ctx('viewer')).allow).toBe(false)
      expect(decideAccess('req', m, ['nope'], ctx('viewer')).allow).toBe(false)
      expect(decideAccess('req', m, [], ctx('viewer')).allow).toBe(false)
    }
    expect(decideAccess('req', IPC.ptyTmuxStatus, [], ctx('viewer')).allow).toBe(true)
  })

  it('git reads are jailed by their cwd', () => {
    for (const m of [IPC.gitStatus, IPC.gitRepoRoot, IPC.gitHistory]) {
      expect(decideAccess('req', m, ['/srv/app'], ctx('viewer')).allow).toBe(true)
      expect(decideAccess('req', m, ['/root'], ctx('viewer')).allow).toBe(false)
    }
  })

  it('git:diff jails the FILE too — an untracked diff is `git diff --no-index`, which reads any path', () => {
    const v = ctx('viewer')
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', 'src/a.ts', false, false], v).allow).toBe(true)
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', 'new.ts', false, true], v).allow).toBe(true)
    // The measured escape: `git diff --no-index -- /dev/null /root/.ssh/id_rsa` prints the key.
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', '/root/.ssh/id_rsa', false, true], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', '../../root/.ssh/id_rsa', false, true], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', 'link', false, true], v).allow).toBe(false)
    // `untracked` is read truthily by the handler, so a truthy non-boolean is the untracked branch.
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', '/root/.ssh/id_rsa', false, 1], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', '../outside', false, false], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', ':(top)x', false, false], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitDiff, ['/srv/app', 42, false, false], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitDiff, ['/root', 'x', false, false], v).allow).toBe(false)
  })

  it('git:show-file refuses a ref that git would parse as an option (`--output=` WRITES a file)', () => {
    const v = ctx('viewer')
    expect(decideAccess('req', IPC.gitShowFile, ['/srv/app', 'HEAD', 'src/a.ts'], v).allow).toBe(true)
    expect(decideAccess('req', IPC.gitShowFile, ['/srv/app', '', 'src/a.ts'], v).allow).toBe(true)
    expect(decideAccess('req', IPC.gitShowFile, ['/srv/app', '--output=/tmp/pwned', 'a'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitShowFile, ['/srv/app', '-p', 'a'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitShowFile, ['/srv/app', { toString: () => '--output=x' }, 'a'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitShowFile, ['/root', 'HEAD', 'a'], v).allow).toBe(false)
  })

  it('board-log reads and subscriptions name a shared project', () => {
    for (const m of [IPC.boardLogRead, IPC.boardLogSubscribe, IPC.boardLogUnsubscribe]) {
      expect(decideAccess('req', m, ['P'], ctx('viewer')).allow).toBe(true)
      expect(decideAccess('req', m, ['Q'], ctx('viewer')).allow).toBe(false)
      expect(decideAccess('req', m, [], ctx('viewer')).allow).toBe(false)
    }
  })

  it('a commenter has every viewer right; an unknown role is treated as the lowest', () => {
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/README.md'], ctx('commenter')).allow).toBe(true)
    expect(decideAccess('req', IPC.fsWrite, ['/srv/app/README.md', 'x'], ctx('commenter')).allow).toBe(false)
    const odd = ctx('admin' as AccessContext['role'])
    expect(decideAccess('cast', IPC.presenceChat, ['hi'], odd).allow).toBe(false)
    expect(decideAccess('req', IPC.fsWrite, ['/srv/app/x', 'y'], odd)).toEqual({
      allow: false,
      message: "Viewers can't do that here. Ask an owner for Editor access."
    })
    expect(decideAccess('req', IPC.fsWrite, ['/srv/app/x', 'y'], ctx('toString' as AccessContext['role']))).toEqual({
      allow: false,
      message: "Viewers can't do that here. Ask an owner for Editor access."
    })
    expect(filterOutboundEvent(JSON.stringify({ t: 'ev', channel: IPC.logBatch, args: [[]] }), odd)).toBe(false)
  })

  it('a method named like an Object.prototype member is not a table entry', () => {
    for (const m of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const d = decideAccess('req', m, [], ctx('commenter'))
      expect(d.allow, m).toBe(false)
      expect(typeof (d as { message?: unknown }).message, m).toBe('string')
    }
    expect(decideAccess('req', 42 as unknown as string, [], ctx('viewer')).allow).toBe(false)
  })

  it('a refusal names the role and never echoes the method', () => {
    expect(decideAccess('req', IPC.gitCommit, ['/srv/app', 'm'], ctx('commenter'))).toEqual({
      allow: false,
      message: "Commenters can't do that here. Ask an owner for Editor access."
    })
  })
})

describe('outbound filter: deny by default for non-editors', () => {
  const ev = (channel: string, ...args: unknown[]) => JSON.stringify({ t: 'ev', channel, args })

  it('host-private broadcasts never reach a viewer, and do reach an editor', () => {
    for (const ch of [IPC.logBatch, IPC.usageUpdate, IPC.licenseChanged, IPC.gitCloneProgress, IPC.workspaceCorruptRecovered]) {
      expect(filterOutboundEvent(ev(ch, { x: 1 }), ctx('viewer')), ch).toBe(false)
      expect(filterOutboundEvent(ev(ch, { x: 1 }), ctx('editor')), ch).toBe(true)
    }
  })

  it('a whole project pushed by the core is delivered only when it is shared', () => {
    for (const ch of [IPC.workspaceExternalChange, IPC.workspaceServerChange]) {
      expect(filterOutboundEvent(ev(ch, { id: 'P', nodes: [] }), ctx('viewer'))).toBe(true)
      expect(filterOutboundEvent(ev(ch, { id: 'Q', nodes: [] }), ctx('viewer'))).toBe(false)
      expect(filterOutboundEvent(ev(ch, null), ctx('viewer'))).toBe(false)
    }
    expect(filterOutboundEvent(ev(IPC.projectTrustChanged, { projectId: 'P' }), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(IPC.projectTrustChanged, { projectId: 'Q' }), ctx('viewer'))).toBe(false)
  })

  it('a viewer receives relay:hosted:shared-changed (its tabs follow it; the payload is the shared set)', () => {
    const shared = JSON.stringify({ t: 'ev', channel: IPC.relayHostedSharedChanged, args: [{ projectIds: ['p1'] }] })
    expect(filterOutboundEvent(shared, ctx('viewer'))).toBe(true)
  })

  it('per-project channels are filtered by the project in their name', () => {
    expect(filterOutboundEvent(ev(IPC.boardLogChanged('P'), 'P'), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(IPC.boardLogChanged('Q'), 'Q'), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(ev(IPC.projectSetupEvent('P'), {}), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(IPC.projectSetupEvent('Q'), {}), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(ev(IPC.githubIssuesChanged('P'), [1]), ctx('viewer'))).toBe(false)
  })

  it('per-session terminal events are delivered', () => {
    for (const ch of [IPC.ptyExit('s'), IPC.ptySize('s'), IPC.ptyClosed('s'), IPC.ptyRecycled('s'), IPC.ptyResync('s')]) {
      expect(filterOutboundEvent(ev(ch, 0), ctx('viewer')), ch).toBe(true)
    }
    expect(filterOutboundEvent(JSON.stringify({ t: 'ev', channel: IPC.ptyRecycled('s'), args: [] }), ctx('viewer'))).toBe(true)
  })

  // Security audit (a)/(d): presence and context:update named every project's work. Presence is only
  // delivered through the per-peer filter (`createPresenceFilter`, tested below); through the
  // stateless table it is dropped. A context update needs a SHARED node behind it.
  it('presence never passes the stateless table; context:update only for a shared node\'s session', () => {
    expect(filterOutboundEvent(ev(IPC.presenceSync, []), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(ev(IPC.presencePeer, {}), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(ev(IPC.presenceSync, []), ctx('editor'))).toBe(true)
    // No node, no way to attribute it: dropped.
    expect(filterOutboundEvent(ev(IPC.contextUpdate, { sessionId: 'x', usedPercent: 3 }), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(ev(IPC.contextUpdate, { nodeId: 'n1', sessionId: 'x' }), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(IPC.contextUpdate, { nodeId: 'n2', sessionId: 'x' }), ctx('viewer'))).toBe(false)
    const withMirror: AccessContext = {
      ...ctx('viewer'),
      nodesOfAgentSession: (sid) => (sid === 'shared-s' ? ['n1'] : sid === 'other-s' ? ['n2'] : sid === 'both-s' ? ['n1', 'n2'] : [])
    }
    expect(filterOutboundEvent(ev(IPC.contextUpdate, { sessionId: 'shared-s' }), withMirror)).toBe(true)
    expect(filterOutboundEvent(ev(IPC.contextUpdate, { sessionId: 'other-s' }), withMirror)).toBe(false)
    expect(filterOutboundEvent(ev(IPC.contextUpdate, { sessionId: 'both-s' }), withMirror)).toBe(false)
    expect(filterOutboundEvent(ev(IPC.contextUpdate, { sessionId: 'nobody' }), withMirror)).toBe(false)
  })

  it('an unread clear names a node', () => {
    expect(filterOutboundEvent(ev(IPC.agentUnreadClear, 'n1'), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(IPC.agentUnreadClear, 'n2'), ctx('viewer'))).toBe(false)
  })

  it('an unattributable message is dropped for a non-editor, never guessed', () => {
    expect(filterOutboundEvent('not json', ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(JSON.stringify({ t: 'ev', args: [] }), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(JSON.stringify({ t: 'ev', channel: IPC.agentStatus }), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent('not json', ctx('owner'))).toBe(true)
  })

  it('subagent live output has no node id: it is delivered only for a subagent a shared node started', () => {
    const owners = new Map<string, string>()
    const v = ctx('viewer')
    const chunk = (toolUseId: string) => ev(IPC.agentSubagentActivity, { toolUseId, chunk: 'secret' })
    // Nothing learned yet: dropped.
    expect(filterOutboundEvent(chunk('t1'), v, owners)).toBe(false)
    expect(filterOutboundEvent(chunk('t1'), v)).toBe(false)
    // A start on a SHARED node teaches t1 → n1; one on a non-shared node teaches t2 → n2.
    expect(filterOutboundEvent(ev(IPC.agentStatus, { nodeId: 'n1', kind: 'subagent-start', toolUseId: 't1' }), v, owners)).toBe(true)
    expect(filterOutboundEvent(ev(IPC.agentStatus, { nodeId: 'n2', kind: 'subagent-start', toolUseId: 't2' }), v, owners)).toBe(false)
    expect(filterOutboundEvent(chunk('t1'), v, owners)).toBe(true)
    expect(filterOutboundEvent(chunk('t2'), v, owners)).toBe(false)
    // The owner is re-checked at delivery: unsharing the project stops the stream.
    expect(filterOutboundEvent(chunk('t1'), { ...v, sharedProjects: new Set() }, owners)).toBe(false)
  })

  it('the subagent owner map is bounded', () => {
    const owners = new Map<string, string>()
    const v = ctx('viewer')
    for (let i = 0; i < 2000; i++) {
      filterOutboundEvent(ev(IPC.agentStatus, { nodeId: 'n1', kind: 'subagent-start', toolUseId: `t${i}` }), v, owners)
    }
    expect(owners.size).toBeLessThanOrEqual(512)
    expect(owners.has('t1999')).toBe(true)
    expect(owners.has('t0')).toBe(false)
  })
})

describe('wrapSinkForRole — project documents lose their exec fields for non-editors', () => {
  const doc = JSON.stringify({
    t: 'ev',
    channel: IPC.workspaceServerChange,
    args: [{ id: 'P', nodes: [{ id: 'n1', kind: 'terminal', position: { x: 0, y: 0 }, shell: '/usr/bin/evil', pendingLaunch: { after: [], command: 'claude "held prompt text"' } }] }]
  })
  const run = (role: AccessContext['role']) => {
    const text: string[] = []
    wrapSinkForRole({ sendText: (j) => text.push(j), sendBinary: () => {} }, () => ctx(role)).sendText(doc)
    return text
  }
  it('a viewer gets the shared project without the exec field; an editor gets it verbatim', () => {
    const v = run('viewer')
    expect(v).toHaveLength(1)
    expect(JSON.parse(v[0]).args[0].nodes[0].shell).toBeUndefined()
    expect(JSON.parse(v[0]).args[0].nodes[0].pendingLaunch).toBeUndefined()
    expect(v[0]).not.toContain('held prompt text')
    expect(run('editor')).toEqual([doc])
  })
  it('a viewer\'s workspace:load is stripped too', () => {
    const out = narrowResponseForRole(IPC.workspaceLoad, { projects: [JSON.parse(doc).args[0]] }, ctx('viewer')) as {
      projects: Array<{ nodes: Array<{ shell?: string; pendingLaunch?: unknown }> }>
    }
    expect(out.projects[0].nodes[0].shell).toBeUndefined()
    expect(out.projects[0].nodes[0].pendingLaunch).toBeUndefined()
  })
})

describe('wrapSinkForRole', () => {
  const sinkWith = (buffered: () => number) => {
    const text: string[] = []
    const bin: Uint8Array[] = []
    const sink: UiSink = { sendText: (j) => text.push(j), sendBinary: (b) => bin.push(b), bufferedAmount: buffered }
    return { sink, text, bin }
  }

  it('keeps reporting the UNDERLYING socket backlog, never a constant', () => {
    let n = 5
    const { sink } = sinkWith(() => n)
    const w = wrapSinkForRole(sink, () => ctx('viewer'))
    expect(w.bufferedAmount?.()).toBe(5)
    n = 9_000_000
    expect(w.bufferedAmount?.()).toBe(9_000_000)
  })

  it('filters text per the CURRENT context and passes terminal bytes through', () => {
    let role: AccessContext['role'] = 'viewer'
    const { sink, text, bin } = sinkWith(() => 0)
    const w = wrapSinkForRole(sink, () => ctx(role))
    const mutQ = JSON.stringify({ t: 'ev', channel: IPC.canvasMut, args: ['Q', {}] })
    w.sendText(mutQ)
    expect(text).toEqual([])
    role = 'editor'
    w.sendText(mutQ)
    expect(text).toEqual([mutQ])
    w.sendBinary(new Uint8Array([1, 2]))
    expect(bin).toHaveLength(1)
  })

  it('carries the subagent owner map across messages', () => {
    const { sink, text } = sinkWith(() => 0)
    const w = wrapSinkForRole(sink, () => ctx('viewer'))
    const start = JSON.stringify({ t: 'ev', channel: IPC.agentStatus, args: [{ nodeId: 'n1', kind: 'subagent-start', toolUseId: 't1' }] })
    const chunk = JSON.stringify({ t: 'ev', channel: IPC.agentSubagentActivity, args: [{ toolUseId: 't1', chunk: 'x' }] })
    w.sendText(start)
    w.sendText(chunk)
    expect(text).toEqual([start, chunk])
  })

  it('a context that cannot be built drops the message instead of throwing into the registry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { sink, text } = sinkWith(() => 0)
      const w = wrapSinkForRole(sink, () => {
        throw new Error('team store unreadable')
      })
      expect(() => w.sendText(JSON.stringify({ t: 'ev', channel: IPC.presencePeer, args: [{ op: 'leave', clientId: 1 }] }))).not.toThrow()
      expect(() => w.sendText(JSON.stringify({ t: 'ev', channel: IPC.agentStatus, args: [{ nodeId: 'n1' }] }))).not.toThrow()
      expect(text).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('presence through wrapSinkForRole (security audit (a))', () => {
  const peer = (clientId: number, projectId: string | null, extra: Record<string, unknown> = {}) => ({
    clientId, name: `p${clientId}`, color: '#5ac8fa', cursor: null, focus: null, chat: null,
    typing: null, projectId, dino: null, kind: 'desktop', ...extra
  })
  const pev = (channel: string, arg: unknown) => JSON.stringify({ t: 'ev', channel, args: [arg] })
  const rig = (role: () => AccessContext['role']) => {
    const got: Array<{ channel: string; arg: unknown }> = []
    const w = wrapSinkForRole(
      { sendText: (j) => { const m = JSON.parse(j); got.push({ channel: m.channel, arg: m.args[0] }) }, sendBinary: () => {} },
      () => ctx(role())
    )
    return { w, got }
  }
  it('a viewer sees only the shared project\'s peers; an editor sees everyone, verbatim', () => {
    const sync = pev(IPC.presenceSync, [peer(1, 'Q', { focus: 'n2', chat: 'private' }), peer(2, 'P', { focus: 'n2', typing: { nodeId: 'n1', at: 1 } })])
    const v = rig(() => 'viewer')
    v.w.sendText(sync)
    expect(v.got).toEqual([{ channel: IPC.presenceSync, arg: [expect.objectContaining({ clientId: 2, focus: null, typing: { nodeId: 'n1', at: 1 } })] }])
    const e = rig(() => 'editor')
    e.w.sendText(sync)
    expect(e.got).toEqual([{ channel: IPC.presenceSync, arg: JSON.parse(sync).args[0] }])
  })
  it('a commenter\'s view follows the peer across projects, and a role change resends the whole picture', () => {
    let role: AccessContext['role'] = 'commenter'
    const r = rig(() => role)
    r.w.sendText(pev(IPC.presenceSync, [peer(1, 'P'), peer(2, 'Q')]))
    r.got.length = 0
    r.w.sendText(pev(IPC.presencePeer, { op: 'update', clientId: 2, patch: { chat: 'Q chat' } }))
    r.w.sendText(pev(IPC.presencePeer, { op: 'update', clientId: 1, patch: { projectId: 'Q' } }))
    expect(r.got).toEqual([{ channel: IPC.presencePeer, arg: { op: 'leave', clientId: 1 } }])
    r.got.length = 0
    role = 'editor'
    r.w.sendText(pev(IPC.presencePeer, { op: 'update', clientId: 2, patch: { chat: 'again' } }))
    expect(r.got).toEqual([{ channel: IPC.presenceSync, arg: [expect.objectContaining({ clientId: 1 }), expect.objectContaining({ clientId: 2, chat: 'again' })] }])
    r.got.length = 0
    role = 'viewer'
    r.w.sendText(pev(IPC.presencePeer, { op: 'update', clientId: 2, patch: { chat: 'x' } }))
    expect(r.got).toEqual([{ channel: IPC.presenceSync, arg: [] }])
  })
  it('an update for a peer it never saw, and anything malformed, is dropped', () => {
    const r = rig(() => 'viewer')
    r.w.sendText(pev(IPC.presenceSync, []))
    r.got.length = 0
    r.w.sendText(pev(IPC.presencePeer, { op: 'update', clientId: 77, patch: { projectId: 'P' } }))
    r.w.sendText(pev(IPC.presencePeer, 'nonsense'))
    r.w.sendText(pev(IPC.presenceSync, 'nonsense'))
    expect(r.got).toEqual([])
  })
})

describe('board comments from a Commenter (security audit F3)', () => {
  const COMMENT = { id: 'c1', ts: 1, kind: 'comment', author: { name: 'Ada', color: '#fff' }, text: 'hi', nodeId: 'n1' }
  it('only the fields a comment has are written; padding is dropped', () => {
    const d = decideAccess('req', IPC.boardLogAppend, ['P', { ...COMMENT, pad: 'A'.repeat(1_000_000), event: { type: 'card-moved' } }], ctx('commenter'))
    expect(d).toEqual({ allow: true, args: ['P', COMMENT] })
  })
  it('a malformed or oversized comment is refused', () => {
    for (const bad of [
      { ...COMMENT, id: '' },
      { ...COMMENT, ts: 'now' },
      { ...COMMENT, author: 'Ada' },
      { ...COMMENT, author: { name: 'x'.repeat(500), color: '#fff' } },
      { ...COMMENT, text: 42 },
      { kind: 'comment' }
    ]) {
      expect(decideAccess('req', IPC.boardLogAppend, ['P', bad], ctx('commenter')).allow, JSON.stringify(bad).slice(0, 60)).toBe(false)
    }
    const long = decideAccess('req', IPC.boardLogAppend, ['P', { ...COMMENT, text: 'y'.repeat(100_000) }], ctx('commenter'))
    expect(long.allow && ((long.args?.[1] as { text: string }).text.length)).toBeLessThan(20_000)
  })
})

describe('a shared folder that is the home directory or the disk root is not a root (security audit F4)', () => {
  it('a viewer reads nothing under it, ~/.ssh included', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authz-home-'))
    try {
      fs.mkdirSync(path.join(home, '.ssh'))
      fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY')
      fs.mkdirSync(path.join(home, 'proj'))
      fs.writeFileSync(path.join(home, 'proj', 'README.md'), 'ok')
      const rp = (p: string): string | null => {
        try {
          return fs.realpathSync(p)
        } catch {
          return null
        }
      }
      const at = (cwd: string): AccessContext => ({
        ...ctx('viewer'), projectCwds: () => [cwd], homeDir: home, hostDataDir: path.join(os.tmpdir(), 'no-data'), realpath: rp
      })
      expect(decideAccess('req', IPC.fsRead, [path.join(home, '.ssh', 'id_ed25519')], at(home)).allow).toBe(false)
      expect(decideAccess('req', IPC.fsRead, [path.join(home, '.ssh', 'id_ed25519')], at(path.dirname(home))).allow).toBe(false)
      expect(decideAccess('req', IPC.fsRead, ['/etc/hostname'], at('/')).allow).toBe(false)
      // A project folder below the home directory is a root as before.
      expect(decideAccess('req', IPC.fsRead, [path.join(home, 'proj', 'README.md')], at(path.join(home, 'proj'))).allow).toBe(true)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('narrowResponseForRole', () => {
  const snapshot = [
    { kind: 'subagent-start', nodeId: 'n1', toolUseId: 't1', taskLabel: 'shared task' },
    { kind: 'subagent-start', nodeId: 'n2', toolUseId: 't2', taskLabel: 'private task' }
  ]
  it('trims the subagent snapshot to shared nodes for a non-editor', () => {
    expect(narrowResponseForRole(IPC.agentSubagentSnapshot, snapshot, ctx('viewer'))).toEqual([snapshot[0]])
    expect(narrowResponseForRole(IPC.agentSubagentSnapshot, 'garbage', ctx('viewer'))).toEqual([])
  })
  it('leaves an editor, and every other method, untouched', () => {
    expect(narrowResponseForRole(IPC.agentSubagentSnapshot, snapshot, ctx('editor'))).toBe(snapshot)
    const r = { anything: 1 }
    expect(narrowResponseForRole(IPC.fsRead, r, ctx('viewer'))).toBe(r)
  })
  // The agent-status snapshot names every node the host's mirror holds, keyed by node, with its
  // session id and account: a non-editor gets the shared nodes' entries only, as with `agent:status`.
  const NODE = 'n1'
  const viewerCtx = ctx('viewer')
  it('narrowResponseForRole trims agent:status-snapshot to shared nodes', () => {
    const out = narrowResponseForRole(IPC.agentStatusSnapshot, [{ nodeId: NODE }, { nodeId: 'other' }], viewerCtx)
    expect(out).toEqual([{ nodeId: NODE }])
    expect(narrowResponseForRole(IPC.agentStatusSnapshot, [{ nodeId: 'n2', state: 'working' }], ctx('commenter'))).toEqual([])
    expect(narrowResponseForRole(IPC.agentStatusSnapshot, 'garbage', viewerCtx)).toEqual([])
    const all = [{ nodeId: NODE }, { nodeId: 'other' }]
    expect(narrowResponseForRole(IPC.agentStatusSnapshot, all, ctx('editor'))).toBe(all)
  })
  it('a viewer and a commenter may call agent:status-snapshot', () => {
    expect(decideAccess('req', IPC.agentStatusSnapshot, [], ctx('viewer'))).toEqual({ allow: true })
    expect(decideAccess('req', IPC.agentStatusSnapshot, [], ctx('commenter'))).toEqual({ allow: true })
  })
})

// C1 / R43. `git show <ref>:<p>` resolves a bare <p> against the REPOSITORY'S TOP LEVEL, not the cwd:
// measured with real git, from repo/shared/ a `git show HEAD:secret/key.txt` prints repo/secret/key.txt,
// and `git status` / `git log` list every changed path and commit of the whole repository. The cwd
// jail cannot stop that, so a non-editor gets git only when the shared root holding the cwd is the
// top of its OWN repository (a `.git` directory, or a worktree's `.git` file).
describe('access policy: git needs a shared root that is its own repository (C1)', () => {
  const NOT_OWN_REPO = 'Git is available to viewers only in a project that is the top folder of its own repository, never in a subfolder of a larger one.'
  const GIT_CALLS: Array<[string, unknown[]]> = [
    [IPC.gitStatus, ['/repo/shared']],
    [IPC.gitRepoRoot, ['/repo/shared']],
    [IPC.gitHistory, ['/repo/shared']],
    [IPC.gitDiff, ['/repo/shared', 'a.txt', false, false]],
    [IPC.gitShowFile, ['/repo/shared', 'HEAD', 'secret/key.txt']]
  ]
  // The shared project is repo/shared; only repo/ holds a `.git`.
  const subfolder = (role: AccessContext['role']): AccessContext => ({
    ...ctx(role),
    projectCwds: () => ['/repo/shared'],
    isFile: (p) => p === '/repo/.git/HEAD'
  })

  it('every git VIEW method is refused, with the reason, when the shared root has no .git of its own', () => {
    for (const [m, args] of GIT_CALLS) {
      expect(decideAccess('req', m, args, subfolder('viewer')), m).toEqual({ allow: false, message: NOT_OWN_REPO })
      expect(decideAccess('req', m, args, subfolder('commenter')), m).toEqual({ allow: false, message: NOT_OWN_REPO })
    }
    // Files are still readable: the jail for fs:* is the folder, and the folder IS shared.
    expect(decideAccess('req', IPC.fsRead, ['/repo/shared/a.txt'], subfolder('viewer')).allow).toBe(true)
  })

  it('editors and owners are unaffected', () => {
    for (const [m, args] of GIT_CALLS) {
      expect(decideAccess('req', m, args, subfolder('editor')), m).toEqual({ allow: true })
      expect(decideAccess('req', m, args, subfolder('owner')), m).toEqual({ allow: true })
    }
  })

  it('a cwd outside every shared root is still the read jail, not the repository reason', () => {
    expect(decideAccess('req', IPC.gitStatus, ['/elsewhere'], subfolder('viewer'))).toEqual({ allow: false, message: READ_JAIL_MSG })
  })

  it('a nested shared root with its own .git allows the cwds under it, and only those', () => {
    // Shared: /mono/a (no .git of its own) and /mono/a/b (its own repository).
    const c: AccessContext = {
      ...ctx('viewer'),
      projectCwds: () => ['/mono/a', '/mono/a/b'],
      isFile: (p) => p === '/mono/a/b/.git/HEAD'
    }
    expect(decideAccess('req', IPC.gitStatus, ['/mono/a/b/src'], c).allow).toBe(true)
    expect(decideAccess('req', IPC.gitStatus, ['/mono/a/x'], c)).toEqual({ allow: false, message: NOT_OWN_REPO })
  })

  it.skipIf(process.platform === 'win32')('on disk: a subfolder is refused, the repo root and a worktree root (a .git FILE) are allowed', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'access-git-')))
    try {
      fs.mkdirSync(path.join(base, 'repo', '.git'), { recursive: true })
      fs.writeFileSync(path.join(base, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
      fs.mkdirSync(path.join(base, 'repo', 'shared'), { recursive: true })
      fs.mkdirSync(path.join(base, 'wt'), { recursive: true })
      fs.writeFileSync(path.join(base, 'wt', '.git'), `gitdir: ${path.join(base, 'repo', '.git', 'worktrees', 'wt')}\n`)
      const onDisk = (root: string): AccessContext => ({
        role: 'viewer',
        sharedProjects: new Set(['P']),
        projectsOfNode: () => [],
        nodeOfSession: () => undefined,
        hostDataDir: '/nonexistent-nodeterm-data',
        projectCwds: () => [root],
        realpath: (p) => {
          try {
            return fs.realpathSync(p)
          } catch {
            return null
          }
        },
        isFile: (p) => {
          try {
            return fs.statSync(p).isFile()
          } catch {
            return false
          }
        }
      })
      const show = (root: string, cwd: string) => decideAccess('req', IPC.gitShowFile, [cwd, 'HEAD', 'secret/key.txt'], onDisk(root))
      const shared = path.join(base, 'repo', 'shared')
      expect(show(shared, shared)).toEqual({ allow: false, message: NOT_OWN_REPO })
      expect(decideAccess('req', IPC.gitStatus, [shared], onDisk(shared))).toEqual({ allow: false, message: NOT_OWN_REPO })
      // The repository root is shared as a whole: its history is the project's own.
      expect(show(path.join(base, 'repo'), shared).allow).toBe(true)
      expect(decideAccess('req', IPC.gitStatus, [path.join(base, 'repo')], onDisk(path.join(base, 'repo'))).allow).toBe(true)
      // A worktree's .git is a file; its root is the top of its own checkout.
      expect(decideAccess('req', IPC.gitStatus, [path.join(base, 'wt')], onDisk(path.join(base, 'wt'))).allow).toBe(true)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  // R46. Git skips a `.git` that is not a repository and keeps searching upward (measured with real
  // git 2.43: an empty `.git` dir and a `.git` symlink to a plain directory both resolve to the
  // ENCLOSING repository). So "the root holds a `.git`" is not enough: it must be a gitfile, which
  // git either follows or stops on, or a directory that holds HEAD.
  it.skipIf(process.platform === 'win32')('on disk: a .git counts only as a gitfile or a directory holding HEAD (symlinks need privileges on Windows)', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'access-gitmark-')))
    try {
      const repo = path.join(base, 'repo')
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
      fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      // An empty `.git` dir at a subfolder root.
      fs.mkdirSync(path.join(repo, 'empty', '.git'), { recursive: true })
      // A `.git` dir holding HEAD: its own repository.
      fs.mkdirSync(path.join(repo, 'headed', '.git'), { recursive: true })
      fs.writeFileSync(path.join(repo, 'headed', '.git', 'HEAD'), 'ref: refs/heads/main\n')
      // A `.git` file (a worktree or submodule gitfile).
      fs.mkdirSync(path.join(repo, 'gitfile'), { recursive: true })
      fs.writeFileSync(path.join(repo, 'gitfile', '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'gitfile')}\n`)
      // A `.git` symlink to a directory that is not a repository.
      fs.mkdirSync(path.join(base, 'plain'), { recursive: true })
      fs.mkdirSync(path.join(repo, 'linked'), { recursive: true })
      fs.symlinkSync(path.join(base, 'plain'), path.join(repo, 'linked', '.git'))
      const onDisk = (root: string): AccessContext => ({
        role: 'viewer',
        sharedProjects: new Set(['P']),
        projectsOfNode: () => [],
        nodeOfSession: () => undefined,
        hostDataDir: '/nonexistent-nodeterm-data',
        projectCwds: () => [root],
        realpath: (p) => {
          try {
            return fs.realpathSync(p)
          } catch {
            return null
          }
        },
        isFile: (p) => {
          try {
            return fs.statSync(p).isFile()
          } catch {
            return false
          }
        }
      })
      const status = (sub: string) => decideAccess('req', IPC.gitStatus, [path.join(repo, sub)], onDisk(path.join(repo, sub)))
      expect(status('empty')).toEqual({ allow: false, message: NOT_OWN_REPO })
      expect(status('linked')).toEqual({ allow: false, message: NOT_OWN_REPO })
      expect(status('headed')).toEqual({ allow: true })
      expect(status('gitfile')).toEqual({ allow: true })
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

const READ_JAIL_MSG = 'Viewers can only read files inside a shared project.'

// I3 / R45. `team unshare` changes only team.json, and a viewer that already joined a terminal of the
// project keeps its subscription: before this, pty bytes, size, exit and repaint frames kept
// streaming to it until it reconnected. The sink now asks, per frame, which node the session runs
// and whether that node is (still) in a shared project.
describe('access policy: a terminal stops streaming to a non-editor once its project is unshared (I3)', () => {
  const ev = (channel: string, ...args: unknown[]) => JSON.stringify({ t: 'ev', channel, args })
  const unshared = (role: AccessContext['role']): AccessContext => ({ ...ctx(role), sharedProjects: new Set() })
  const sinkWith = () => {
    const text: string[] = []
    const bin: Uint8Array[] = []
    const sink: UiSink = { sendText: (j) => text.push(j), sendBinary: (b) => bin.push(b), bufferedAmount: () => 0 }
    return { sink, text, bin }
  }

  it('terminal bytes reach a viewer only for a session whose node is in a shared project NOW', () => {
    let c = ctx('viewer')
    const { sink, bin } = sinkWith()
    const w = wrapSinkForRole(sink, () => c)
    w.sendBinary(encodePtyData('s1', 'shared'))
    w.sendBinary(encodePtyData('s2', 'other project'))
    w.sendBinary(encodePtyData('nope', 'unknown session'))
    w.sendBinary(new Uint8Array([9, 9])) // not a pty frame at all
    expect(bin).toEqual([encodePtyData('s1', 'shared')])
    c = unshared('viewer') // `team unshare P`
    w.sendBinary(encodePtyData('s1', 'after unshare'))
    expect(bin).toHaveLength(1)
  })

  it('an editor receives every frame, and its context is never asked about the session', () => {
    const { sink, bin } = sinkWith()
    const c: AccessContext = {
      ...unshared('editor'),
      nodeOfSession: () => {
        throw new Error('an editor frame must not be judged')
      }
    }
    const w = wrapSinkForRole(sink, () => c)
    w.sendBinary(encodePtyData('s2', 'x'))
    w.sendBinary(new Uint8Array([9]))
    expect(bin).toHaveLength(2)
  })

  it('a context that cannot be built drops terminal bytes instead of throwing into the registry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { sink, bin } = sinkWith()
      const w = wrapSinkForRole(sink, () => {
        throw new Error('team store unreadable')
      })
      expect(() => w.sendBinary(encodePtyData('s1', 'x'))).not.toThrow()
      expect(bin).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('per-session events: a repaint needs a shared session; the others stop once the node is known and unshared', () => {
    // pty:resync carries the screen itself, so it is judged like terminal bytes.
    expect(filterOutboundEvent(ev(IPC.ptyResync('s1'), 'screen'), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(IPC.ptyResync('s1'), 'screen'), unshared('viewer'))).toBe(false)
    expect(filterOutboundEvent(ev(IPC.ptyResync('nope'), 'screen'), ctx('viewer'))).toBe(false)
    for (const ch of [IPC.ptyExit, IPC.ptySize, IPC.ptyClosed, IPC.ptyRecycled]) {
      expect(filterOutboundEvent(ev(ch('s1'), 0), ctx('viewer')), ch('s1')).toBe(true)
      expect(filterOutboundEvent(ev(ch('s1'), 0), unshared('viewer')), ch('s1')).toBe(false)
      expect(filterOutboundEvent(ev(ch('s2'), 0), ctx('commenter')), ch('s2')).toBe(false)
      // A session that is already gone (a recycle is announced after the old session left the
      // manager) still tells its subscribers it ended: nothing but that fact is in it.
      expect(filterOutboundEvent(ev(ch('gone'), 0), ctx('viewer')), ch('gone')).toBe(true)
      expect(filterOutboundEvent(ev(ch('s2'), 0), unshared('editor')), ch('s2')).toBe(true)
    }
  })
})

// M4. Node ids travel in git-shared project files, so one id can sit in a shared project AND an
// unshared one. Resolving it to "the first project that has it" made the verdict depend on index
// order. It is shared only when EVERY project holding it is shared.
describe('access policy: a node id held by more than one project (M4)', () => {
  const holders = (map: Record<string, string[]>) => (id: string) => map[id] ?? []
  const dup = (role: AccessContext['role'], shared: string[]): AccessContext => ({
    ...ctx(role),
    sharedProjects: new Set(shared),
    projectsOfNode: holders({ both: ['P', 'Q'], twoShared: ['P', 'P2'], solo: ['P'] }),
    nodeOfSession: (sid) => (sid === 'sBoth' ? 'both' : undefined)
  })
  const status = (nodeId: string) => JSON.stringify({ t: 'ev', channel: IPC.agentStatus, args: [{ nodeId }] })

  it('an id in a shared and an unshared project is NOT shared, whichever comes first', () => {
    for (const order of [['P', 'Q'], ['Q', 'P']]) {
      const c: AccessContext = { ...dup('viewer', ['P']), projectsOfNode: (id) => (id === 'both' ? order : []) }
      expect(decideAccess('req', IPC.ptyCreate, [{ persistKey: 'both' }], c).allow, order.join()).toBe(false)
      expect(decideAccess('req', IPC.ptyCapture, ['both'], c).allow, order.join()).toBe(false)
      expect(filterOutboundEvent(status('both'), c), order.join()).toBe(false)
    }
  })

  it('an id every one of whose projects is shared is shared; an unknown id is not', () => {
    const c = dup('viewer', ['P', 'P2'])
    expect(decideAccess('req', IPC.ptyCapture, ['twoShared'], c).allow).toBe(true)
    expect(decideAccess('req', IPC.ptyCapture, ['solo'], c).allow).toBe(true)
    expect(decideAccess('req', IPC.ptyCapture, ['nobody'], c).allow).toBe(false)
  })

  it('a terminal session of an ambiguous node does not stream to a viewer', () => {
    const bin: Uint8Array[] = []
    const w = wrapSinkForRole({ sendText: () => {}, sendBinary: (b) => bin.push(b), bufferedAmount: () => 0 }, () => dup('viewer', ['P']))
    w.sendBinary(encodePtyData('sBoth', 'x'))
    expect(bin).toEqual([])
  })

  it('editors are unaffected', () => {
    expect(decideAccess('req', IPC.ptyCapture, ['both'], dup('editor', ['P'])).allow).toBe(true)
  })
})

// M7. A shared project whose folder CONTAINS this server's data directory (a project opened on $HOME,
// say) would let a Viewer read the host key, team.json, the password hash, every project's
// scrollback snapshots and the unshared inline canvases. The data directory is never readable by a
// non-editor, whatever shared root holds it.
describe('access policy: the server data directory is never readable by a non-editor (M7)', () => {
  // A share that CONTAINS the data directory (a share of `$HOME`, which is where it lives by default)
  // used to be served with the data directory jailed out file by file. Since security audit F4 such a
  // folder is not a root at all (share-root.ts): `~/.ssh` sits beside the data directory, not in it.
  const home = (role: AccessContext['role']): AccessContext => ({
    ...ctx(role),
    projectCwds: () => ['/home/u'],
    homeDir: '/somewhere/else',
    hostDataDir: '/home/u/.nodeterm-server',
    realpath: (p) => (p === '/home/u/data-link' ? '/home/u/.nodeterm-server' : p.startsWith('/home/u/data-link/') ? '/home/u/.nodeterm-server' + p.slice('/home/u/data-link'.length) : p)
  })

  it('a share that contains it is not a root: its files, the data dir\'s, and git under it are refused', () => {
    const v = home('viewer')
    for (const m of [IPC.fsRead, IPC.fsReadBinary, IPC.fsExists]) {
      expect(decideAccess('req', m, ['/home/u/.nodeterm-server/relay/host-key.json'], v).allow, m).toBe(false)
    }
    expect(decideAccess('req', IPC.fsList, ['/home/u/.nodeterm-server'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['/home/u/notes.txt'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['/home/u/data-link/team.json'], home('commenter')).allow).toBe(false)
    expect(decideAccess('req', IPC.gitStatus, ['/home/u/.nodeterm-server'], v).allow).toBe(false)
    expect(decideAccess('req', IPC.gitDiff, ['/home/u', '.nodeterm-server/relay/team.json', false, true], v).allow).toBe(false)
  })

  it('the per-file jail still stands behind it: a symlink from a shared root into the data dir is refused', () => {
    const c: AccessContext = {
      ...ctx('viewer'),
      projectCwds: () => ['/srv/app'],
      hostDataDir: '/var/lib/nt-data',
      realpath: (p) => (p.startsWith('/srv/app/data-link') ? '/var/lib/nt-data' + p.slice('/srv/app/data-link'.length) : p)
    }
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/data-link/relay/host-key.json'], c).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['/srv/app/README.md'], c)).toEqual({ allow: true })
  })

  it('a data directory configured through a symlink is compared by its real path', () => {
    const c: AccessContext = {
      ...ctx('viewer'),
      projectCwds: () => ['/data'],
      hostDataDir: '/srv/nt-link',
      realpath: (p) => (p === '/srv/nt-link' ? '/data/nt' : p)
    }
    // `/data` contains the data dir's REAL path, so it is not a root.
    expect(decideAccess('req', IPC.fsRead, ['/data/nt/relay/host-key.json'], c).allow).toBe(false)
    expect(decideAccess('req', IPC.fsRead, ['/data/other.txt'], c).allow).toBe(false)
  })

  it('editors are unaffected', () => {
    expect(decideAccess('req', IPC.fsRead, ['/home/u/.nodeterm-server/relay/host-key.json'], home('editor'))).toEqual({ allow: true })
  })
})
