import { spawn } from 'child_process'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { IPC } from '../../shared/ipc'
import { startSwarmService } from './swarm-service'
import {
  isShellPane,
  MESA_ORCHESTRATOR_SCRIPT,
  startTuiChannel,
  TUI_ENDPOINT_NAME,
  tuiLaunchDecision
} from './tui-channel'

const dirs: string[] = []

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-tui-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function post(
  url: string,
  pathname: string,
  body: unknown,
  token?: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url + pathname)
    const data = JSON.stringify(body)
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          ...(token ? { authorization: `Bearer ${token}` } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: Record<string, unknown> = {}
          try {
            json = JSON.parse(text) as Record<string, unknown>
          } catch {
            json = { raw: text }
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

describe('tui channel', () => {
  it('accepts an authenticated line and refuses a missing bearer', async () => {
    const dir = tmp()
    const ch = await startTuiChannel({
      userDataDir: dir,
      onLine: async (_id, line) => ({ reply: `mesa › ${line}` })
    })
    const env = fs.readFileSync(ch.endpointPath, 'utf8')
    const token = env.match(/^NODETERM_SWARM_TOKEN=(.*)$/m)?.[1]?.trim()
    expect(token).toBeTruthy()
    const ok = await post(ch.url, '/tui', { missionId: 'm1', line: '/help' }, token)
    expect(ok.status).toBe(200)
    expect(String(ok.json.reply)).toContain('mesa ›')
    const denied = await post(ch.url, '/tui', { missionId: 'm1', line: '/help' })
    expect(denied.status).toBe(403)
    const replay = await post(ch.url, '/sync', { missionId: 'm1', lastSeq: 0 }, token)
    expect((replay.json.backlog as string[]).some((l) => l.includes('mesa ›'))).toBe(true)
    const launch = ch.launchCommand()
    expect(launch).toContain('mesa-orchestrator.mjs')
    expect(launch).not.toContain(token)
    expect(launch).toMatch(/^NODETERM_SWARM_ENDPOINT_FILE=/)
    expect(launch.indexOf('NODETERM_SWARM_ENDPOINT_FILE=')).toBeLessThan(launch.indexOf(' exec '))
    expect(launch).not.toMatch(/^exec /)
    expect(MESA_ORCHESTRATOR_SCRIPT).not.toContain(token)
    expect(MESA_ORCHESTRATOR_SCRIPT).toContain('Consola desconectada')
    expect(MESA_ORCHESTRATOR_SCRIPT.indexOf("rl.on('line'")).toBeLessThan(
      MESA_ORCHESTRATOR_SCRIPT.indexOf('await replay()')
    )
    expect(MESA_ORCHESTRATOR_SCRIPT).toContain("setInterval(() => { void replay() }, 2000)")
    await ch.close()
  })

  it('the generated TUI process posts /tui from stdin', async () => {
    const dir = tmp()
    let seen = ''
    const ch = await startTuiChannel({
      userDataDir: dir,
      onLine: async (_id, line) => {
        seen = line
        return { reply: `echo:${line}` }
      }
    })
    const child = spawn(process.execPath, [ch.scriptPath], {
      env: {
        ...process.env,
        NODETERM_SWARM_ENDPOINT_FILE: ch.endpointPath,
        NODETERM_SWARM_MISSION: 'm1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out: string[] = []
    child.stdout?.on('data', (c: Buffer) => out.push(c.toString('utf8')))
    child.stderr?.on('data', (c: Buffer) => out.push(c.toString('utf8')))
    const waitFor = (pred: () => boolean, ms: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(out.join('') || 'tui-timeout')), ms)
        const i = setInterval(() => {
          if (!pred()) return
          clearInterval(i)
          clearTimeout(t)
          resolve()
        }, 40)
      })
    await waitFor(() => out.join('').includes('Consola del orquestador'), 4000)
    child.stdin?.write('/help\n')
    await waitFor(() => seen === '/help' || out.join('').includes('echo:/help'), 4000)
    child.kill()
    await ch.close()
    expect(seen).toBe('/help')
    expect(out.join('')).toContain('echo:/help')
  }, 12_000)

  it('ensureTui types the launch line only when the pane is a shell', async () => {
    const dir = tmp()
    const sent: string[] = []
    let pane: string | null = 'zsh'
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const svc = startSwarmService({
      userDataDir: dir,
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      },
      paneCommand: async () => pane
    })
    const created = (await handlers.get(IPC.swarmCreate)?.({
      projectId: 'proj-1',
      orchestratorNodeId: 'orch-1',
      objective: 'Diseña una API de inventario. Primero presenta el plan.'
    })) as { id: string } | null
    const ensure = handlers.get(IPC.swarmEnsureTui)
    expect(ensure).toBeTruthy()
    const refused = (await ensure?.({ missionId: created!.id, nodeId: 'worker-a' })) as {
      ok: boolean
    }
    expect(refused.ok).toBe(false)
    expect(sent).toEqual([])
    const launched = (await ensure?.({ missionId: created!.id, nodeId: 'orch-1' })) as {
      ok: boolean
      running: boolean
    }
    expect(launched.ok).toBe(true)
    expect(launched.running).toBe(false)
    expect(sent[0]).toContain('mesa-orchestrator.mjs')
    expect(sent[0]).toContain('NODETERM_SWARM_ENDPOINT_FILE=')
    expect(sent[0]).not.toMatch(/NODETERM_SWARM_TOKEN=/)
    expect(sent[0]).toMatch(/^NODETERM_SWARM_MISSION=/)
    expect(sent[0]!.indexOf('NODETERM_SWARM_ENDPOINT_FILE=')).toBeLessThan(sent[0]!.indexOf(' exec '))
    expect(sent[0]).not.toMatch(/\bexec NODETERM_/)

    sent.length = 0
    const [a, b] = await Promise.all([
      ensure?.({ missionId: created!.id, nodeId: 'orch-1' }),
      ensure?.({ missionId: created!.id, nodeId: 'orch-1' })
    ])
    expect((a as { ok: boolean }).ok).toBe(true)
    expect((b as { ok: boolean }).ok).toBe(true)
    expect(sent).toEqual([])

    pane = 'node'
    sent.length = 0
    const already = (await ensure?.({ missionId: created!.id, nodeId: 'orch-1' })) as {
      ok: boolean
      running: boolean
    }
    expect(already.running).toBe(true)
    expect(sent).toEqual([])

    pane = null
    const waiting = (await ensure?.({ missionId: created!.id, nodeId: 'orch-1' })) as {
      ok: boolean
      running: boolean
    }
    expect(waiting.ok).toBe(false)
    svc.stop()
  }, 16_000)

  it('ensureTui waits for a pane that appears after create, and retries a refused paste', async () => {
    const dir = tmp()
    const sent: string[] = []
    let reads = 0
    let refuseOnce = true
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const svc = startSwarmService({
      userDataDir: dir,
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      sendText: async (_id, text) => {
        if (refuseOnce) {
          refuseOnce = false
          return false
        }
        sent.push(text)
        return true
      },
      paneCommand: async () => {
        reads += 1
        return reads >= 3 ? 'zsh' : null
      }
    })
    const created = (await handlers.get(IPC.swarmCreate)?.({
      projectId: 'proj-1',
      orchestratorNodeId: 'orch-late',
      objective: 'Diseña una API de inventario. Primero presenta el plan.'
    })) as { id: string } | null
    const started = Date.now()
    while (sent.length === 0 && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(created?.id).toBeTruthy()
    expect(sent[0]).toContain('mesa-orchestrator.mjs')
    expect(sent).toHaveLength(1)
    svc.stop()
  }, 12_000)

  it('TUI /activate A ticks the host so mock research does not wait for the 2s interval', async () => {
    const dir = tmp()
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const svc = startSwarmService({
      userDataDir: dir,
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      sendText: async () => true,
      paneCommand: async () => 'zsh'
    })
    const created = (await handlers.get(IPC.swarmCreate)?.({
      projectId: 'proj-1',
      orchestratorNodeId: 'orch-1',
      objective: 'Diseña una API de inventario. Primero presenta el plan.'
    })) as { id: string } | null
    await handlers.get(IPC.swarmTick)?.({ missionId: created!.id })
    await handlers.get(IPC.swarmEnsureTui)?.({ missionId: created!.id, nodeId: 'orch-1' })
    const env = fs.readFileSync(path.join(dir, 'swarm', TUI_ENDPOINT_NAME), 'utf8')
    const token = env.match(/^NODETERM_SWARM_TOKEN=(.*)$/m)?.[1]?.trim()
    const url = env.match(/^NODETERM_SWARM_URL=(.*)$/m)?.[1]?.trim()
    expect(token && url).toBeTruthy()
    const r = await post(url!, '/tui', { missionId: created!.id, line: '/activate A' }, token)
    expect(r.status).toBe(200)
    expect(String(r.json.reply)).toContain('Activando A')
    const after = (await handlers.get(IPC.swarmGet)?.({ missionId: created!.id })) as {
      tasks: Array<{ roleId: string; status: string }>
    }
    expect(after.tasks.find((t) => t.roleId === 'O')?.status).toBe('accepted')
    expect(after.tasks.find((t) => t.roleId === 'A')?.status).toBe('accepted')
    svc.stop()
  }, 12_000)

  it('does not treat a null pane read as a shell', () => {
    expect(isShellPane(null)).toBeNull()
    expect(isShellPane('zsh')).toBe(true)
    expect(isShellPane('node')).toBe(false)
    expect(tuiLaunchDecision(null)).toBe('wait')
    expect(tuiLaunchDecision('zsh')).toBe('launch')
    expect(tuiLaunchDecision('node')).toBe('running')
  })
})
