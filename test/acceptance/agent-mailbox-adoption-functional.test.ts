// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PaneAdoptionService, type PaneAdoptionDeps } from '../../src/core/agents/pane-adoption'
import { PaneAdoptionFileStore } from '../../src/core/agents/pane-adoption-store'
import { createLocalPaneEvidence } from '../../src/core/agents/pane-adoption-local'
import { createPrivatePaneScope } from '../../src/core/agents/pane-adoption-scope'
import { registerPaneAdoptionIpc } from '../../src/core/agents/pane-adoption-ipc'
import { freshPaneOwnerProject, paneOwnerProject, resetPaneOwnershipForTests, setHumanPaneAdoptionReader } from '../../src/core/agents/pane-ownership'
import { isAgentPane, binariesFor } from '../../src/shared/agents/pane-owner-predicate'
import type { PaneOwner } from '../../src/shared/agents/pane-owner-predicate'
import type { PaneAdoptionReply, PaneAdoptionRequest, LocalPaneIdentity } from '../../src/shared/agents/pane-adoption'
import type { SessionHostListing } from '../../src/core/session-host-client'
import { PaneAdoptionAction } from '../../src/renderer/components/PaneAdoptionAction'
import { paneAdoptionDialogOptions } from '../../src/main/pane-adoption-dialog'
import { IPC } from '../../src/shared/ipc'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const NODE = 'qa-adopt-node', PROJECT = 'qa-private-project', request = { nodeId: NODE, projectId: PROJECT }
const dirs: string[] = [], services: PaneAdoptionService[] = []
let root: Root | undefined, container: HTMLDivElement | undefined
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => resetPaneOwnershipForTests())
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; container?.remove(); container = undefined
  services.splice(0).forEach(s => s.standDown()); resetPaneOwnershipForTests(); vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })))
})
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-qa-adopt-')); dirs.push(dir)
  const f = {
    dir, platform: 'linux', mainId: 11 as number | undefined, clock: 1000,
    projectPath: '/synthetic/qa-private-folder', projectId: PROJECT, remote: false,
    generation: 'qa-generation-001', provider: 'codex', providerSession: 'qa-provider-session',
    boot: '11111111-1111-4111-8111-111111111111', details: true, approval: true,
    births: new Map([[701, '1001'], [702, '2002'], [703, '3003']]),
    projects: [{ id: PROJECT, nodes: [{ id: NODE, kind: 'terminal' }] }],
    seen: [] as LocalPaneIdentity[],
    decision: undefined as undefined | (() => Promise<boolean>)
  }
  const scope = createPrivatePaneScope({ projects: () => f.projects,
    privateProject: id => id === f.projectId ? { cwd: f.projectPath } : null,
    isSshNode: () => f.remote, realpath: cwd => cwd })
  const listing = vi.fn(async (): Promise<SessionHostListing> => ({ running: true,
    hostPid: 701, names: [`nt-${NODE}`], sessions: f.details ? [{ name: `nt-${NODE}`, pid: 702,
      generation: f.generation, subscribers: 1, createdMs: 1, lastOutputMs: 1 }] : null }))
  const captureDeps = {
    platform: f.platform, scope, provider: () => f.providerSession ? { agentId: f.provider, sessionId: f.providerSession } : null,
    listing, kernel: { bootId: () => f.boot, parent: (pid: number) => pid === 702 ? 701 : null,
      process: (pid: number) => f.births.has(pid) ? { pid, birth: f.births.get(pid)! } : null },
    paneOwner: vi.fn(async (): Promise<PaneOwner> => ({ panePid: 702,
      paneId: `host-linux:${f.generation}:${f.births.get(702)}`, tty: '/dev/pts/qa', command: f.provider,
      argv: [f.provider], pids: [703], processBirths: [f.births.get(703)!] })),
    isAgent: (owner: PaneOwner, agentId: string) => isAgentPane(owner, agentId, binariesFor(agentId)) === 'agent'
  }
  const evidence = createLocalPaneEvidence(captureDeps)
  const confirm = vi.fn(async (identity: LocalPaneIdentity) => {
    f.seen.push(structuredClone(identity)); return f.decision ? f.decision() : f.approval
  })
  const storage = new PaneAdoptionFileStore(dir)
  const deps: PaneAdoptionDeps = { storage, ...evidence, mainWindowId: () => f.mainId,
    confirm, freshOwner: freshPaneOwnerProject, now: () => f.clock, monotonicNow: () => f.clock }
  const make = (store = new PaneAdoptionFileStore(dir)) => { const service = new PaneAdoptionService({ ...deps, storage: store }); services.push(service); return service }
  const service = make(storage), frame = {}
  let listener!: (event: { sender: { id: number; mainFrame?: unknown }; senderFrame?: unknown }, raw: unknown) => Promise<unknown>
  registerPaneAdoptionIpc({ handle: (channel, cb) => { expect(channel).toBe(IPC.paneOwnershipAdopt); listener = cb } }, service)
  const invoke = (raw: unknown = request, sender = 11, top = true) => listener({ sender: { id: sender, mainFrame: frame }, senderFrame: top ? frame : {} }, raw) as Promise<PaneAdoptionReply>
  return Object.assign(f, { evidence, captureDeps, listing, confirm, service, make, deps, invoke,
    recordFile: path.join(dir, 'pane-ownership-adoptions', 'records.json') })
}
async function render(f: Awaited<ReturnType<typeof fixture>>) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const onAdopted = vi.fn(), calls: unknown[] = [], operations: Promise<PaneAdoptionReply>[] = []
  const api = { paneOwnership: { adopt: (raw: PaneAdoptionRequest) => {
    calls.push(structuredClone(raw)); const operation = f.invoke(raw); operations.push(operation); return operation
  } } }
  await act(async () => root!.render(createElement(PaneAdoptionAction, { api, ...request, onAdopted })))
  return { onAdopted, calls, operations, settle: () => act(async () => { await Promise.all(operations) }) }
}
const click = async () => { await act(async () => container!.querySelector('button')!.click()) }

describe('independent ordinary local adoption UI/IPC/restore functions', () => {
  it('renders unsupported old-host evidence visibly, without pretending ownership or starting a host', async () => {
    const f = await fixture(); f.details = false
    const ui = await render(f); await click(); await ui.settle()
    expect(container!.textContent).toContain('unsupported-evidence')
    expect(ui.onAdopted).not.toHaveBeenCalled(); expect(f.confirm).not.toHaveBeenCalled()
    expect(f.service.owner(NODE)).toBeUndefined()
    expect(f.captureDeps.paneOwner).not.toHaveBeenCalled()
  })

  it('runs the actual UI -> IPC -> evidence -> private store chain with a simulated main dialog', async () => {
    const f = await fixture(), dialog = deferred<boolean>(); f.decision = () => dialog.promise
    const ui = await render(f)
    await click()
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledTimes(1))
    expect(container!.textContent).toContain('Awaiting native confirmation')
    expect(ui.calls).toEqual([request]); expect(f.confirm).toHaveBeenCalledTimes(1)
    expect(f.service.owner(NODE)).toBeUndefined(); expect(ui.onAdopted).not.toHaveBeenCalled()
    const opts = paneAdoptionDialogOptions(f.seen[0])
    expect(opts.defaultId).toBe(0); expect(opts.cancelId).toBe(0)
    expect(opts.detail).toContain(f.generation); expect(opts.detail).toContain(f.projectPath)
    await act(async () => { dialog.resolve(true); await Promise.all(ui.operations) })
    expect(ui.onAdopted).toHaveBeenCalledTimes(1)
    expect(container!.textContent).toContain('explicit local human confirmation')
    expect(f.service.owner(NODE)).toBe(PROJECT); expect(freshPaneOwnerProject(NODE)).toBeUndefined()
    setHumanPaneAdoptionReader(node => f.service.owner(node)); expect(paneOwnerProject(NODE)).toBe(PROJECT)
    const disk = JSON.parse(await fs.readFile(f.recordFile, 'utf8'))
    expect(disk.records[0]).toMatchObject({ provenance: 'local-human-adoption', identity: {
      nodeId: NODE, projectId: PROJECT, generation: f.generation, host: { pid: 701, birth: '1001' } } })
    expect(disk.records[0].identity).not.toHaveProperty('argv')
    expect((await fs.stat(f.recordFile)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(path.dirname(f.recordFile))).mode & 0o777).toBe(0o700)
  })

  it('Cancel is visible and creates no grant or success callback', async () => {
    const f = await fixture(); f.approval = false
    const ui = await render(f); await click(); await ui.settle()
    expect(container!.textContent).toContain('cancelled'); expect(ui.onAdopted).not.toHaveBeenCalled()
    expect(f.service.owner(NODE)).toBeUndefined()
    await expect(fs.stat(f.recordFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['foreign-window', 'subframe', 'renderer-approval'])('keeps the local IPC request contract for %s', async kind => {
    const f = await fixture()
    const result = kind === 'foreign-window' ? await f.invoke(request, 99) :
      kind === 'subframe' ? await f.invoke(request, 11, false) : await f.invoke({ ...request, approved: true })
    expect(result).toMatchObject({ ok: false, code: kind === 'renderer-approval' ? 'invalid-request' : 'not-permitted' })
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.listing).not.toHaveBeenCalled()
  })

  it.each(['window', 'timeout', 'generation', 'foreground', 'provider', 'project-folder'])('does not complete a pending dialog after %s changes', async what => {
    const f = await fixture()
    f.decision = async () => {
      if (what === 'window') f.mainId = 99
      if (what === 'timeout') f.clock += 61_000
      if (what === 'generation') f.generation = 'qa-generation-002'
      if (what === 'foreground') f.births.set(703, '3004')
      if (what === 'provider') f.providerSession = 'qa-provider-replacement'
      if (what === 'project-folder') f.projectPath = '/synthetic/qa-other-folder'
      return true
    }
    expect(await f.invoke()).toMatchObject({ ok: false, code: what === 'window' ? 'not-permitted' : what === 'timeout' ? 'expired' : 'identity-changed' })
    expect(f.service.owner(NODE)).toBeUndefined(); await expect(fs.stat(f.recordFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores the same real private record only after new evidence, without another simulated decision or legacy mutation', async () => {
    const f = await fixture(), legacy = path.join(f.dir, 'synthetic-legacy.json'), bytes = '{"held":"SYNTHETIC-QA-UNCHANGED"}'
    await fs.writeFile(legacy, bytes)
    const original = await f.invoke(); expect(original).toMatchObject({ ok: true })
    f.service.standDown()
    const restarted = f.make(); expect(restarted.owner(NODE)).toBeUndefined()
    await restarted.refresh([NODE]); expect(restarted.owner(NODE)).toBe(PROJECT)
    expect(f.confirm).toHaveBeenCalledTimes(1); expect(freshPaneOwnerProject(NODE)).toBeUndefined()
    expect(await fs.readFile(legacy, 'utf8')).toBe(bytes)
    expect(await restarted.request(11, request)).toMatchObject({ ok: true, result: { status: 'already-approved', provenance: 'local-human-adoption' } })
    expect(f.confirm).toHaveBeenCalledTimes(1)
  })

  it.each(['generation', 'host-birth', 'pane-birth', 'foreground-birth', 'boot', 'provider', 'project'])('does not restore the previous grant after %s changed', async what => {
    const f = await fixture(); expect(await f.invoke()).toMatchObject({ ok: true }); f.service.standDown()
    if (what === 'generation') f.generation = 'qa-generation-next'
    if (what === 'host-birth') f.births.set(701, '1002')
    if (what === 'pane-birth') f.births.set(702, '2003')
    if (what === 'foreground-birth') f.births.set(703, '3004')
    if (what === 'boot') f.boot = '22222222-2222-4222-8222-222222222222'
    if (what === 'provider') f.providerSession = 'qa-new-provider-session'
    if (what === 'project') f.projectId = 'qa-other-private-project'
    const restarted = f.make(); await restarted.refresh([NODE])
    expect(restarted.owner(NODE)).toBeUndefined(); expect(f.confirm).toHaveBeenCalledTimes(1)
  })

  it.each(['remote', 'missing-birth', 'missing-provider', 'duplicate-scope'])('reports unavailable evidence for %s without a native decision', async what => {
    const f = await fixture()
    if (what === 'remote') f.remote = true
    if (what === 'missing-birth') f.births.delete(703)
    if (what === 'missing-provider') f.providerSession = ''
    if (what === 'duplicate-scope') f.projects.push({ id: 'qa-other', nodes: [{ id: NODE, kind: 'terminal' }] })
    expect(await f.invoke()).toMatchObject({ ok: false, code: 'unsupported-evidence' })
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.service.owner(NODE)).toBeUndefined()
  })

  it('preserves corrupt provenance and refuses success instead of replacing it', async () => {
    const f = await fixture(); f.service.standDown()
    await fs.mkdir(path.dirname(f.recordFile), { mode: 0o700 })
    const bad = '{"kind":"local-human-pane-adoptions","version":999,"records":[]}'
    await fs.writeFile(f.recordFile, bad, { mode: 0o600 })
    const restarted = f.make()
    expect(await restarted.request(11, request)).toMatchObject({ ok: false, code: 'store-unavailable' })
    expect(await fs.readFile(f.recordFile, 'utf8')).toBe(bad)
  })

  it('shows a failed private file transaction without publishing owner authority', async () => {
    const f = await fixture(), open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[1] === 'wx' && String(args[0]).includes('pane-ownership-adoptions')) {
        throw Object.assign(new Error('SYNTHETIC-QA disk full'), { code: 'ENOSPC' })
      }
      return open(...args)
    })
    const ui = await render(f); await click(); await ui.settle()
    expect(container!.textContent).toContain('store-unavailable')
    expect(ui.onAdopted).not.toHaveBeenCalled(); expect(f.service.owner(NODE)).toBeUndefined()
    expect(freshPaneOwnerProject(NODE)).toBeUndefined()
    await expect(fs.stat(f.recordFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
