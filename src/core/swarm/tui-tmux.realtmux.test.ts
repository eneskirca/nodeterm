import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IPC } from '../../shared/ipc'
import { isSwarmRoleId } from '../../shared/swarm/schemas'
import { handleCliLine } from '../../tui/mesa-cli'
import { startSwarmRuntime } from './runtime'
import { startSwarmService } from './swarm-service'
import { startTuiChannel } from './tui-channel'
import { makeTmuxTmpdir } from '../tmux-test-socket'

/** Private socket — never `node-terminal` / `nodeterm-rmt`. */
const SOCKET = `nt-mesa-tui-${process.pid}`
const SESSION = 'nt-mesa'

function findTmux(): string | null {
  for (const c of ['/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/bin/tmux']) {
    if (fs.existsSync(c)) return c
  }
  return null
}

const TMUX = findTmux()
let work = ''
const cleanups: Array<() => Promise<void> | void> = []

function tmuxEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TMUX_TMPDIR: work }
}

function tmux(args: string[]): string {
  return execFileSync(TMUX as string, args, { encoding: 'utf8', env: tmuxEnv() })
}

function freshPane(): void {
  try {
    execFileSync(TMUX as string, ['-L', SOCKET, 'kill-session', '-t', SESSION], {
      stdio: 'ignore',
      env: tmuxEnv()
    })
  } catch {
    /* no session yet */
  }
  tmux([
    '-L',
    SOCKET,
    'new-session',
    '-d',
    '-s',
    SESSION,
    '-x',
    '120',
    '-y',
    '30',
    '-e',
    'HISTFILE=/dev/null',
    '-c',
    work,
    'bash --norc --noprofile -i'
  ])
  const deadline = Date.now() + 10_000
  for (;;) {
    const pane = tmux(['-L', SOCKET, 'capture-pane', '-p', '-t', SESSION]).trim()
    if (pane.length > 0) return
    if (Date.now() > deadline) throw new Error('bash prompt never appeared')
    execFileSync('sleep', ['0.05'])
  }
}

async function waitCapture(pred: (s: string) => boolean, ms = 8000): Promise<string> {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < ms) {
    last = tmux(['-L', SOCKET, 'capture-pane', '-p', '-t', SESSION])
    if (pred(last)) return last
    await new Promise((r) => setTimeout(r, 80))
  }
  throw new Error(last || 'empty pane')
}

const suite = TMUX && process.platform !== 'win32' ? describe : describe.skip

suite('Mesa orchestrator TUI inside tmux', () => {
  beforeAll(() => {
    work = makeTmuxTmpdir('mt-', SOCKET)
  })

  afterAll(async () => {
    for (const stop of cleanups.splice(0).reverse()) await stop()
    if (TMUX) {
      try {
        tmux(['-L', SOCKET, 'kill-server'])
      } catch {
        /* already gone */
      }
    }
    if (work) fs.rmSync(work, { recursive: true, force: true })
  })

  it('launches the generated script in a shell pane and answers /plan', async () => {
    const userData = path.join(work, 'ud')
    fs.mkdirSync(userData, { recursive: true })
    const rt = startSwarmRuntime({ userDataDir: userData })
    const objective =
      'Diseña una API de inventario. Primero presenta el plan. No modifiques archivos ni ejecutes comandos sin aprobación.'
    const mission = await rt.createMission({
      projectId: 'proj-1',
      orchestratorNodeId: 'term-orch',
      objective
    })
    const ch = await startTuiChannel({
      userDataDir: userData,
      onLine: async (id, line) => {
        const mid = id || mission.id
        const out = await handleCliLine(line, {
          load: () => rt.getMission(mid),
          setGoal: (next) => rt.setGoal(mid, next),
          pause: () => rt.pause(mid),
          resume: () => rt.resume(mid),
          cancel: () => rt.cancel(mid),
          approve: (approvalId) => rt.approve(mid, approvalId),
          activate: (roleId) =>
            isSwarmRoleId(roleId) ? rt.activateRole(mid, roleId) : Promise.resolve(null)
        })
        return { reply: out.reply }
      }
    })
    cleanups.push(() => ch.close())

    freshPane()
    const launch = `NODETERM_SWARM_MISSION=${mission.id} ${ch.launchCommand()}`
    tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, '-l', '--', launch])
    tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, 'Enter'])

    const banner = await waitCapture((s) => s.includes('Consola del orquestador') && s.includes('tú ›'))
    expect(banner).toContain('Consola del orquestador')
    expect(ch.launchCommand()).not.toMatch(/NODETERM_SWARM_TOKEN=/)

    tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, '-l', '--', '/plan'])
    tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, 'Enter'])
    const plan = await waitCapture((s) => s.includes('A dormido'))
    expect(plan).toContain('A dormido')
    expect(plan).toContain('C1 dormido')
    expect(plan).toContain('D4 dormido')

    tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, '-l', '--', '/goal'])
    tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, 'Enter'])
    const goal = await waitCapture((s) => s.includes('API de inventario'))
    expect(goal).toContain('API de inventario')
  }, 20_000)

  it('swarm.create types the TUI once — the TableView ensureTui does not paste a second launch', async () => {
    const userData = path.join(work, 'ud-svc')
    fs.mkdirSync(userData, { recursive: true })
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const svc = startSwarmService({
      userDataDir: userData,
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      sendText: async (_id, text) => {
        tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, '-l', '--', text])
        tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, 'Enter'])
        return true
      },
      paneCommand: async () =>
        tmux(['-L', SOCKET, 'display-message', '-p', '-t', SESSION, '#{pane_current_command}']).trim()
    })
    cleanups.push(() => svc.stop())

    freshPane()
    const objective =
      'Diseña una API de inventario. Primero presenta el plan. No modifiques archivos ni ejecutes comandos sin aprobación.'
    const created = (await handlers.get(IPC.swarmCreate)?.({
      projectId: 'proj-1',
      orchestratorNodeId: 'term-orch',
      objective
    })) as { id: string; goal: { objective: string }; budget: { spent: { kind: string } } } | null
    expect(created?.goal.objective).toBe(objective)
    expect(created?.budget.spent.kind).toBe('unavailable')

    const banner = await waitCapture((s) => s.includes('Consola del orquestador') && s.includes('tú ›'))
    expect(banner).toContain('Consola del orquestador')
    expect((banner.match(/Consola del orquestador/g) ?? []).length).toBe(1)

    await handlers.get(IPC.swarmEnsureTui)?.({ missionId: created!.id, nodeId: 'term-orch' })
    const after = tmux(['-L', SOCKET, 'capture-pane', '-p', '-t', SESSION])
    expect((after.match(/Consola del orquestador/g) ?? []).length).toBe(1)

    tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, '-l', '--', '/budget'])
    tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, 'Enter'])
    const budget = await waitCapture((s) => s.includes('No disponible'))
    expect(budget).toContain('No disponible')
    expect(budget).not.toMatch(/\$0/)

    tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, '-l', '--', '/activate A'])
    tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, 'Enter'])
    const activating = await waitCapture((s) => s.includes('Activando A.'))
    expect(activating).toContain('Activando A.')
    expect((activating.match(/Consola del orquestador/g) ?? []).length).toBe(1)

    tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, '-l', '--', '/plan'])
    tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, 'Enter'])
    const afterA = await waitCapture((s) => /A (accepted|ready|running)/.test(s))
    expect(afterA).toMatch(/A (accepted|ready|running)/)
    expect(afterA).not.toMatch(/^  A dormido/m)
    expect(afterA).toContain('C1 dormido')

    const cancelled = (await handlers.get(IPC.swarmCancel)?.({ missionId: created!.id })) as {
      cancelled: boolean
    } | null
    expect(cancelled?.cancelled).toBe(true)
  }, 20_000)

  it('live adapter accepts a worker only after the pane writes jailed JSON — idle is not done', async () => {
    const userData = path.join(work, 'ud-live')
    fs.mkdirSync(userData, { recursive: true })
    const { createCliLaunchAdapter } = await import('./adapters/cli-launch')
    const { jailedResultPath } = await import('./adapters/cli-file')
    const WORKER = `${SESSION}-a`
    try {
      execFileSync(TMUX as string, ['-L', SOCKET, 'kill-session', '-t', WORKER], {
        stdio: 'ignore',
        env: tmuxEnv()
      })
    } catch {
      /* none */
    }
    tmux([
      '-L',
      SOCKET,
      'new-session',
      '-d',
      '-s',
      WORKER,
      '-x',
      '80',
      '-y',
      '20',
      '-e',
      'HISTFILE=/dev/null',
      '-c',
      work,
      'bash --norc --noprofile -i'
    ])
    const workerReady = Date.now() + 10_000
    for (;;) {
      const pane = tmux(['-L', SOCKET, 'capture-pane', '-p', '-t', WORKER]).trim()
      if (pane.length > 0) break
      if (Date.now() > workerReady) throw new Error('worker bash never appeared')
      execFileSync('sleep', ['0.05'])
    }
    const adapter = createCliLaunchAdapter({
      userDataDir: userData,
      paneCommand: async (nodeId) =>
        tmux([
          '-L',
          SOCKET,
          'display-message',
          '-p',
          '-t',
          nodeId === 'term-a' ? WORKER : SESSION,
          '#{pane_current_command}'
        ]).trim(),
      sendText: async (nodeId, text) => {
        const target = nodeId === 'term-a' ? WORKER : SESSION
        tmux(['-L', SOCKET, 'send-keys', '-t', target, '-l', '--', text])
        tmux(['-L', SOCKET, 'send-keys', '-t', target, 'Enter'])
        return true
      },
      resolveLaunch: () => ({
        adapterId: 'cli-launch',
        agentId: 'grok',
        policy: 'auto',
        launchCmdOverride: 'true'
      })
    })
    const rt = startSwarmRuntime({ userDataDir: userData, adapter })
    const mission = await rt.createMission({
      projectId: 'proj-live',
      orchestratorNodeId: 'term-orch',
      objective: 'Diseña una API de inventario. Primero presenta el plan.'
    })
    await rt.tick(mission.id)
    await rt.bindRole(mission.id, 'O', 'term-orch')
    await rt.activateRole(mission.id, 'A')
    await rt.bindRole(mission.id, 'A', 'term-a')
    const running = await rt.tick(mission.id)
    const a = running?.tasks.find((t) => t.roleId === 'A')
    expect(a?.status).toBe('running')
    expect(a?.executionId).toBeTruthy()
    expect(await adapter.collectResult(a!.executionId!)).toBeNull()

    const idle = await rt.tick(mission.id)
    expect(idle?.tasks.find((t) => t.roleId === 'A')?.status).toBe('running')

    const file = jailedResultPath(userData, a!.executionId!)
    expect(file).toBeTruthy()
    tmux(['-L', SOCKET, 'send-keys', '-t', WORKER, '-l', '--', `printf '%s\\n' '{"taskId":"${a!.id}","summary":"plan","evidence":["tui"],"criteriaMet":["A-done"]}' > ${file}`])
    tmux(['-L', SOCKET, 'send-keys', '-t', WORKER, 'Enter'])
    const written = await waitCapture((s) => {
      void s
      return fs.existsSync(file!)
    }, 8000)
    expect(written).toBeTruthy()
    expect(fs.existsSync(file!)).toBe(true)

    const done = await rt.tick(mission.id)
    expect(done?.tasks.find((t) => t.roleId === 'A')?.status).toBe('accepted')
    try {
      execFileSync(TMUX as string, ['-L', SOCKET, 'kill-session', '-t', WORKER], {
        stdio: 'ignore',
        env: tmuxEnv()
      })
    } catch {
      /* gone */
    }
  }, 20_000)
})
