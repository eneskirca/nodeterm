import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildFilesApi, buildRealApi, buildSessionMemoryApi } from './ws-bridge'
import { IPC } from '../../shared/ipc'

function fakeClient() {
  const calls: Array<{ kind: string; method: string; args: unknown[] }> = []
  return {
    calls,
    request: (method: string, ...args: unknown[]) => {
      calls.push({ kind: 'request', method, args })
      return Promise.resolve('R')
    },
    cast: (method: string, ...args: unknown[]) => calls.push({ kind: 'cast', method, args }),
    subscribe: (channel: string, _fn: (...a: unknown[]) => void) => {
      calls.push({ kind: 'subscribe', method: channel, args: [] })
      return () => {}
    }
  }
}

describe('buildFilesApi', () => {
  it('fs/git/files members are request-shaped with the right channels', async () => {
    const c = fakeClient()
    const api = buildFilesApi(c as never)
    await api.fs.read('/x')
    await api.git.status('/repo')
    await api.git.showFile('/repo', 'HEAD', 'a.txt')
    await api.files.quickOpen('/repo')
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.fsRead, args: ['/x'] },
      { kind: 'request', method: IPC.gitStatus, args: ['/repo'] },
      { kind: 'request', method: IPC.gitShowFile, args: ['/repo', 'HEAD', 'a.txt'] },
      { kind: 'request', method: IPC.filesQuickOpen, args: ['/repo'] }
    ])
  })
  it('context.ensure is a cast; context.onUpdate/git.onCloneProgress subscribe', () => {
    const c = fakeClient()
    const api = buildFilesApi(c as never)
    api.context.ensure('sid', '/cwd', undefined)
    const un = api.context.onUpdate(() => {})
    const un2 = api.git.onCloneProgress(() => {})
    expect(c.calls[0]).toEqual({ kind: 'cast', method: IPC.contextEnsure, args: ['sid', '/cwd', undefined] })
    expect(c.calls[1]).toEqual({ kind: 'subscribe', method: IPC.contextUpdate, args: [] })
    expect(c.calls[2]).toEqual({ kind: 'subscribe', method: IPC.gitCloneProgress, args: [] })
    expect(typeof un).toBe('function')
    expect(typeof un2).toBe('function')
  })
})

describe('buildRealApi: workspace', () => {
  // The server DOES serve workspace:probe-folder (WorkspaceStore.registerIpc, src/core). Stubbing
  // it to `null` in the browser told "Open folder…" that a repo carrying a committed
  // .nodeterm/project.json had no project in it — so addProjectFromFolder created an empty one and
  // the next writeDisk() overwrote the team's shared canvas. It must hit the real channel.
  it('probeFolder requests the real server channel (never a null stub)', async () => {
    const c = fakeClient()
    const api = buildRealApi(c as never)
    await api.workspace.probeFolder('/repo')
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.workspaceProbeFolder, args: ['/repo'] }
    ])
  })

  it('onMigrated subscribes to the channel core actually broadcasts', () => {
    const c = fakeClient()
    const api = buildRealApi(c as never)
    const un = api.workspace.onMigrated(() => {})
    expect(c.calls[0]).toEqual({ kind: 'subscribe', method: IPC.workspaceMigrated, args: [] })
    expect(typeof un).toBe('function')
  })

  it('onCorruptRecovered subscribes to the channel core actually broadcasts', () => {
    const c = fakeClient()
    const api = buildRealApi(c as never)
    const un = api.workspace.onCorruptRecovered(() => {})
    expect(c.calls[0]).toEqual({ kind: 'subscribe', method: IPC.workspaceCorruptRecovered, args: [] })
    expect(typeof un).toBe('function')
  })
})

describe('buildRealApi: sessionMemory', () => {
  // A real WS namespace, not a stub: the same core service (`startSessionMemoryService`) registers
  // both channels in the server shell, so the browser gets a genuine per-session breakdown of the
  // machine it is served from.
  it('read/host hit the real channels', async () => {
    const c = fakeClient()
    const api = buildSessionMemoryApi(c as never)
    await api.sessionMemory.read()
    await api.sessionMemory.host()
    expect(c.calls.map((x) => ({ kind: x.kind, method: x.method }))).toEqual([
      { kind: 'request', method: IPC.sessionMemory },
      { kind: 'request', method: IPC.sessionMemoryHost }
    ])
  })

  // The query is the ONLY thing that decides which machine answers: `projectId` names the scope and
  // `remote` is the renderer's own "this scope is an SSH host" claim, which the service ORs with its
  // own `isRemoteProject`. A layer that drops or rewrites either one turns a remote query into a
  // LOCAL sweep, and the panel publishes this machine's sessions under the host's name. So the
  // query must arrive at the RPC call byte-identical, on BOTH channels.
  it('passes projectId and the remote flag through unmodified', async () => {
    const c = fakeClient()
    const api = buildSessionMemoryApi(c as never)
    const q = { projectId: 'p1', remote: true }
    await api.sessionMemory.read(q)
    await api.sessionMemory.host(q)
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.sessionMemory, args: [{ projectId: 'p1', remote: true }] },
      { kind: 'request', method: IPC.sessionMemoryHost, args: [{ projectId: 'p1', remote: true }] }
    ])
  })

  // `remote: false` is a claim too ("the renderer says this is NOT an SSH scope"), and it must not
  // be normalized away into `undefined` — the shell's own predicate still gets to say otherwise,
  // but the renderer's answer has to reach it as written.
  it('keeps an explicit remote:false', async () => {
    const c = fakeClient()
    const api = buildSessionMemoryApi(c as never)
    await api.sessionMemory.read({ projectId: 'p2', remote: false })
    expect(c.calls[0].args).toEqual([{ projectId: 'p2', remote: false }])
  })

  // The builder above is dead code unless it is actually spread into the assembled api. It cannot
  // be caught by the compiler: `buildStubApi()` already supplies a `sessionMemory`, so dropping the
  // spread leaves `NodeTerminalApi` satisfied and the STUB silently wins in every live browser
  // session. installWsBridge needs a socket + DOM to run, so the wiring is pinned by source text.
  it('is spread into the assembled window.nodeTerminal', () => {
    const src = readFileSync(join(__dirname, 'ws-bridge.ts'), 'utf8')
    const install = src.slice(src.indexOf('export async function installWsBridge'))
    expect(install).toContain('...buildSessionMemoryApi(client)')
  })
})
