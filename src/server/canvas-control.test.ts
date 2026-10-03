import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _resetForTest as resetAgentStatusMirrorForTests,
  recordAgentEvent
} from '../core/agent-status-mirror'
import { resetMessageFlow } from '../core/agents/agent-message-flow'
import { resetAgentMessageTraceForTests } from '../core/agents/agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from '../core/agents/hooks/managed-script'
import {
  resetNodeTokenFilesForTests,
  writeNodeTokenFile
} from '../core/agents/node-token-files'
import {
  recordFreshSpawnOwner,
  resetPaneOwnershipForTests
} from '../core/agents/pane-ownership'
import { fakePlatform, type FakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import type { PtyManager } from '../core/pty-manager'
import type { WorkspaceStore } from '../core/workspace-store'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS, type Project, type Settings, type Workspace } from '../shared/types'
import { initServerCanvasControl, type ServerCanvasControl } from './canvas-control'

type HeadlessShell = Pick<
  PtyManager,
  'persistentSpawnAvailable' | 'writeHeadless' | 'onOutput' | 'releaseHeadless'
> & { submitted: string[] }

/**
 * The headless taps of a fresh interactive shell, which an immediate open now types its launch
 * into (#925): it prints its prompt once, echoes what it is typed, and records each line Enter
 * submits. The prompt is what ends the launcher's settle after its quiet window; without it every
 * open would wait out the full settle cap.
 */
function headlessShell(): HeadlessShell {
  const taps = new Map<string, Set<(chunk: string) => void>>()
  const lines = new Map<string, string>()
  const prompted = new Set<string>()
  const submitted: string[] = []
  return {
    submitted,
    persistentSpawnAvailable: () => true,
    onOutput: (key, cb) => {
      let set = taps.get(key)
      if (!set) taps.set(key, (set = new Set()))
      set.add(cb)
      if (!prompted.has(key)) {
        prompted.add(key)
        setTimeout(() => {
          if (set!.has(cb)) cb('$ ')
        }, 0)
      }
      return () => {
        set!.delete(cb)
      }
    },
    writeHeadless: (key, data) => {
      if (data === '\r') {
        submitted.push(lines.get(key) ?? '')
        lines.set(key, '')
        return true
      }
      if (data === '\x15' || data === '\x1b') {
        lines.set(key, '')
        return true
      }
      lines.set(key, (lines.get(key) ?? '') + data)
      for (const cb of [...(taps.get(key) ?? [])]) cb(data)
      return true
    },
    releaseHeadless: () => undefined
  }
}

describe('initServerCanvasControl', () => {
  let dataDir = ''
  let runtime: ServerCanvasControl | null = null
  let fake: FakePlatform

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-server-control-'))
    resetPlatformForTests()
    fake = fakePlatform({ userDataDir: dataDir })
    initPlatform(fake)
    resetPaneOwnershipForTests()
    resetMessageFlow()
    resetAgentMessageTraceForTests()
    resetAgentStatusMirrorForTests()
    resetNodeTokenFilesForTests()
  })

  afterEach(() => {
    runtime?.stop()
    runtime = null
    resetPaneOwnershipForTests()
    resetAgentStatusMirrorForTests()
    resetNodeTokenFilesForTests()
    resetPlatformForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('installs only under temp data when integrations are gated, and enforces messaging switch off', async () => {
    const workspace: Workspace = {
      version: 2,
      activeProjectId: 'p1',
      projects: [
        {
          id: 'p1',
          name: 'Project',
          color: '#0a84ff',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            {
              id: 'source',
              kind: 'terminal',
              position: { x: 0, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Source',
              color: '#d97757',
              group: null,
              agentId: 'claude'
            },
            {
              id: 'target',
              kind: 'terminal',
              position: { x: 700, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Target',
              color: '#10a37f',
              group: null,
              agentId: 'codex'
            }
          ]
        }
      ]
    }
    const store = {
      load: vi.fn(async () => workspace),
      // A store keeps what it is handed: the factory edits a private copy of what it loaded.
      save: vi.fn(async (next: Workspace) => {
        Object.assign(workspace, structuredClone(next))
      }),
      persistedCanvases: () => [{ id: 'p1', nodes: workspace.projects[0].nodes }],
      // No strict true flag and no machine-local `kept` ack: capability is off by default.
      capabilityProjectFor: () => ({})
    } as unknown as WorkspaceStore
    const paneOwner = vi.fn(async () => null)
    const sendEnvelope = vi.fn(async () => true)
    const sendText = vi.fn(async (_nodeId: string, _text: string) => true)
    const shell = headlessShell()
    const pty = {
      ...shell,
      createHeadless: vi.fn(async () => ({ sessionId: 'unused', fresh: true })),
      paneCommand: vi.fn(async () => 'bash'),
      sendText,
      destroySession: vi.fn(async () => undefined),
      paneOwner,
      sendEnvelope,
      hasLiveSession: () => true,
      sessionExists: async () => true
    } as unknown as PtyManager
    const settings = (): Settings => ({ ...DEFAULT_SETTINGS })

    runtime = await initServerCanvasControl({
      workspaceStore: store,
      ptyManager: pty,
      settings,
      boardLog: { append: async () => false },
      cliCaps: async () => ({
        version: null,
        autoPermissionMode: false,
        fullscreenTui: false,
        sessionIdFlag: false
      }),
      codexSharedIdentity: async () => true,
      // Pinned, never this machine's codex: the line depends on what the CLI advertises. `true`
      // also proves the Server Edition's opens carry `--no-daemon` (shared/agents/codex-daemon.ts).
      codexCaps: async () => ({ approvalValues: null, noDaemon: true })
    })

    const shim = path.join(dataDir, 'canvas-control', 'nodeterm.sh')
    const shimBody = fs.readFileSync(shim, 'utf8')
    expect(shimBody).toContain('NODETERM_CANVAS_CONTROL')
    expect(shimBody).toContain('CODEX_THREAD_ID')
    expect(shimBody).toContain(path.join(dataDir, 'codex-thread-nodes'))
    expect(fs.statSync(shim).mode & 0o111).not.toBe(0)

    const opened = await runtime.handler({
      verb: 'open-agent',
      nodeId: 'source',
      args: { agent: 'codex', prompt: 'identity proof' },
      verified: true
    })
    expect(opened).toMatchObject({ ok: true })
    const openedId = (opened.result as { id: string }).id
    // The launch is typed into the shell and submitted, never pasted blind (#925).
    expect(shell.submitted).toEqual([
      "nodeterm-codex 'identity proof' --ask-for-approval on-request --no-daemon"
    ])
    expect(sendText).not.toHaveBeenCalled()

    const unowned = await runtime.handler({
      verb: 'send',
      nodeId: 'source',
      args: { node: 'target', text: 'must not land' },
      verified: true
    })
    expect(unowned).toMatchObject({
      ok: false,
      error: expect.stringContaining('caller-not-owner')
    })
    expect(paneOwner).not.toHaveBeenCalled()

    // Prove pane ownership for the caller's own spawn so the next gate reached is specifically the
    // per-project capability switch.
    recordFreshSpawnOwner(openedId, 'p1')
    const reply = await runtime.handler({
      verb: 'send',
      nodeId: 'source',
      args: { node: openedId, text: 'hello' },
      verified: true
    })
    expect(reply).toMatchObject({
      ok: false,
      error: expect.stringContaining('notPermitted (switch-off)')
    })
    expect(paneOwner).not.toHaveBeenCalled()
    expect(sendEnvelope).not.toHaveBeenCalled()
  })

  it('wires permitted delivery through paste-settle-submit on the first fresh pane message', async () => {
    const workspace: Workspace = {
      version: 2,
      activeProjectId: 'p1',
      projects: [
        {
          id: 'p1',
          name: 'Project',
          color: '#0a84ff',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            {
              id: 'source',
              kind: 'terminal',
              position: { x: 0, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Source',
              color: '#d97757',
              group: null,
              agentId: 'claude'
            },
            {
              id: 'target',
              kind: 'terminal',
              position: { x: 700, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Target',
              color: '#d97757',
              group: null,
              agentId: 'claude'
            }
          ]
        }
      ]
    }
    const store = {
      load: vi.fn(async () => workspace),
      // A store keeps what it is handed: the factory edits a private copy of what it loaded.
      save: vi.fn(async (next: Workspace) => {
        Object.assign(workspace, structuredClone(next))
      }),
      persistedCanvases: () => [{ id: 'p1', nodes: workspace.projects[0].nodes }],
      capabilityProjectFor: () => ({
        agentMessaging: true,
        capabilityAck: { agentMessaging: 'kept' }
      })
    } as unknown as WorkspaceStore
    const writes: Array<{ text: string; enter: boolean | undefined }> = []
    let pasted = ''
    const legacySendEnvelope = vi.fn(async () => true)
    const pty = {
      ...headlessShell(),
      createHeadless: vi.fn(async () => ({ sessionId: 'unused', fresh: true })),
      paneCommand: vi.fn(async () => 'bash'),
      captureSession: vi.fn(async () =>
        pasted ? `Claude composer\n${pasted.split('\n').at(-1)}` : 'Claude composer'),
      sendText: vi.fn(async (nodeId: string, text: string, opts?: { enter?: boolean }) => {
        writes.push({ text, enter: opts?.enter })
        if (text) pasted = text
        else queueMicrotask(() => runtime?.onAgentEvent({
          nodeId,
          agentId: 'claude',
          kind: 'state',
          state: 'working',
          newTurn: true,
          verified: true,
          clientRevision: MANAGED_SCRIPT_REVISION
        } as never))
        return true
      }),
      destroySession: vi.fn(async () => undefined),
      paneOwner: vi.fn(async () => ({
        tty: '/dev/pts/9',
        panePid: 100,
        paneId: '%1',
        command: 'claude',
        argv: ['claude'],
        pids: [200]
      })),
      sendEnvelope: legacySendEnvelope,
      hasLiveSession: () => true,
      sessionExists: async () => true
    } as unknown as PtyManager

    runtime = await initServerCanvasControl({
      workspaceStore: store,
      ptyManager: pty,
      settings: () => ({ ...DEFAULT_SETTINGS }),
      boardLog: { append: async () => false }
    })

    const opened = await runtime.handler({
      verb: 'open-agent',
      nodeId: 'source',
      args: { agent: 'claude', prompt: 'owned target' },
      verified: true
    })
    expect(opened).toMatchObject({ ok: true })
    const targetId = (opened.result as { id: string }).id
    writes.length = 0
    pasted = ''
    recordFreshSpawnOwner(targetId, 'p1')
    expect(writeNodeTokenFile(targetId, 'token')).toBe(true)
    recordAgentEvent({
      nodeId: targetId,
      agentId: 'claude',
      kind: 'state',
      state: 'done',
      verified: true,
      clientRevision: MANAGED_SCRIPT_REVISION
    } as never)

    const reply = await runtime.handler({
      verb: 'send',
      nodeId: 'source',
      args: { node: targetId, text: 'hello' },
      verified: true
    })
    expect(reply).toMatchObject({ ok: true, message: expect.stringContaining('delivered') })
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({ enter: false })
    expect(writes[1]).toEqual({ text: '', enter: true })
    expect(legacySendEnvelope).not.toHaveBeenCalled()
  })

  it('publishes its own writes on server-change, never on the outside-edit channel', async () => {
    // The defect this pins: `open-agent` appends a `ctrl-…` rope to `project.ropes`, and while
    // that rode `workspace:external-change` the renderer ran it through `decideExternalChange`,
    // which reads a changed `ropes` array as a CONFLICT whenever the canvas is dirty. The bar it
    // raised suspends autosave, so a burst of spawns latched it on, and "Keep my version" then
    // wrote the browser's edges over the ropes this factory had just persisted.
    const workspace: Workspace = {
      version: 2,
      activeProjectId: 'p1',
      projects: [
        {
          id: 'p1',
          name: 'Project',
          color: '#0a84ff',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            {
              id: 'source',
              kind: 'terminal',
              position: { x: 0, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Source',
              color: '#d97757',
              group: null,
              agentId: 'claude'
            }
          ]
        }
      ]
    }
    const store = {
      load: vi.fn(async () => workspace),
      // A store keeps what it is handed: the factory edits a private copy of what it loaded.
      save: vi.fn(async (next: Workspace) => {
        Object.assign(workspace, structuredClone(next))
      }),
      persistedCanvases: () => [{ id: 'p1', nodes: workspace.projects[0].nodes }],
      capabilityProjectFor: () => ({ agentMessaging: false, capabilityAck: {} })
    } as unknown as WorkspaceStore
    const pty = {
      ...headlessShell(),
      createHeadless: vi.fn(async () => ({ sessionId: 'unused', fresh: true })),
      paneCommand: vi.fn(async () => 'bash'),
      sendText: vi.fn(async () => true),
      destroySession: vi.fn(async () => undefined),
      paneOwner: vi.fn(async () => null),
      sendEnvelope: vi.fn(async () => true),
      hasLiveSession: () => true,
      sessionExists: async () => true
    } as unknown as PtyManager

    runtime = await initServerCanvasControl({
      workspaceStore: store,
      ptyManager: pty,
      settings: () => ({ ...DEFAULT_SETTINGS }),
      boardLog: { append: async () => false }
    })
    fake.sent.length = 0

    const opened = await runtime.handler({
      verb: 'open-agent',
      nodeId: 'source',
      args: { agent: 'claude', prompt: 'spawn me' },
      verified: true
    })
    expect(opened).toMatchObject({ ok: true })
    const openedId = (opened.result as { id: string }).id

    const server = fake.sent.filter((e) => e.channel === IPC.workspaceServerChange)
    expect(server.length).toBeGreaterThan(0)
    const published = server.at(-1)!.args[0] as Project
    expect(published.id).toBe('p1')
    expect(published.nodes.map((n) => n.id)).toContain(openedId)
    // The one that must NOT happen: nothing this factory writes is an "another device" edit.
    expect(fake.sent.filter((e) => e.channel === IPC.workspaceExternalChange)).toEqual([])
  })
})
