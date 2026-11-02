import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HOOK_MARKER, buildOmpHookPlugin, installOmpHooks, ompHookPath, removeOmpHooks } from './omp'
import { normalizeOpencode } from '../../../shared/agents/normalize'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-hooks-'))
  process.env.HOME = home
  delete process.env.PI_CODING_AGENT_DIR
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  delete process.env.HOME
})

describe('omp hook install', () => {
  it('writes the marker-bearing hook file (idempotent)', () => {
    installOmpHooks()
    installOmpHooks()
    const body = fs.readFileSync(ompHookPath(), 'utf8')
    expect(body.startsWith(HOOK_MARKER)).toBe(true)
    expect(body).toContain('NODETERM_NODE_ID')
    expect(body).toContain('/hook/omp')
    expect(body).toContain('export default function (pi)')
  })

  it('never overwrites a user file without the marker', () => {
    fs.mkdirSync(path.dirname(ompHookPath()), { recursive: true })
    fs.writeFileSync(ompHookPath(), '// my own hook\n')
    installOmpHooks()
    expect(fs.readFileSync(ompHookPath(), 'utf8')).toBe('// my own hook\n')
  })

  it('remove deletes only a marker-bearing file', () => {
    installOmpHooks()
    removeOmpHooks()
    expect(fs.existsSync(ompHookPath())).toBe(false)
    fs.mkdirSync(path.dirname(ompHookPath()), { recursive: true })
    fs.writeFileSync(ompHookPath(), '// mine\n')
    removeOmpHooks()
    expect(fs.readFileSync(ompHookPath(), 'utf8')).toBe('// mine\n')
  })

  it('the generated plugin is env-gated and fail-open', () => {
    const body = buildOmpHookPlugin()
    expect(body).toContain('if (!nodeId) return null') // missing env → no poster
    expect(body).toContain('catch') // posts never throw into omp
  })

  it('PI_CODING_AGENT_DIR relocates the hook dir like omp resolves it', () => {
    process.env.PI_CODING_AGENT_DIR = path.join(home, 'custom-agent')
    installOmpHooks()
    expect(fs.existsSync(path.join(home, 'custom-agent', 'hooks', 'pre', 'nodeterm-status.js'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.omp', 'agent'))).toBe(false)
  })
})

describe('omp posts the opencode dialect', () => {
  const env = (payload: Record<string, unknown>) => ({ nodeId: 'n1', agentId: 'omp', payload })

  it('translates the omp event stream through normalizeOpencode', () => {
    const states = [
      normalizeOpencode(env({ event: 'session.created', sessionID: 's1' })),
      normalizeOpencode(env({ event: 'message.updated', sessionID: 's1', role: 'user' })),
      normalizeOpencode(env({ event: 'tool.execute.before', sessionID: 's1' })),
      normalizeOpencode(env({ event: 'permission.asked', sessionID: 's1' })),
      normalizeOpencode(env({ event: 'permission.replied', sessionID: 's1' })),
      normalizeOpencode(env({ event: 'session.idle', sessionID: 's1' }))
    ].map((n) => n && (n.kind === 'state' ? n.state + (n.newTurn ? '+newTurn' : '') : n.kind))
    expect(states).toEqual(['session', 'working+newTurn', 'working', 'blocked', 'working', 'done'])
  })

})

describe('omp posts a BARE session id', () => {
  it('parses the id out of the session file name — the reader locates by id, never by path', async () => {
    const plug = path.join(home, `plug-${Date.now()}.mjs`)
    fs.writeFileSync(plug, buildOmpHookPlugin())
    // A developer shell can carry a LIVE nodeterm endpoint (socket + file) — the poster would
    // take its http.request branch and the captured-fetch stub would see nothing. Force the
    // plain TCP branch this test drives.
    delete process.env.NODETERM_HOOK_ENDPOINT
    delete process.env.NODETERM_HOOK_SOCK
    process.env.NODETERM_NODE_ID = 'n1'
    process.env.NODETERM_HOOK_TOKEN = 't'
    process.env.NODETERM_HOOK_PORT = '59999'
    const bodies: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(init?.body ?? '')
    }) as typeof fetch
    try {
      // The module under test is a GENERATED plugin file (built at runtime into tmp) — static
      // import cannot reach a file that does not exist at author time.
      const mod = (await import(plug)) as { default: (pi: unknown) => void }
      const handlers: Record<string, (e?: unknown, ctx?: unknown) => Promise<void>> = {}
      mod.default({ on: (n: string, h: (e?: unknown, ctx?: unknown) => Promise<void>) => { handlers[n] = h } })
      await handlers.session_start(undefined, {
        sessionManager: {
          getSessionFile: () =>
            '/Users/oleg/.omp/agent/sessions/-tmp/2026-11-02T17-51-02-100Z_01a19d62-d3d4-736d-b20f-9996a848a75a.jsonl'
        }
      })
    } finally {
      globalThis.fetch = realFetch
      delete process.env.NODETERM_NODE_ID
      delete process.env.NODETERM_HOOK_TOKEN
      delete process.env.NODETERM_HOOK_PORT
    }
    const payload = JSON.parse(decodeURIComponent(new URLSearchParams(bodies[0]).get('payload') ?? '{}'))
    expect(payload.sessionID).toBe('01a19d62-d3d4-736d-b20f-9996a848a75a')
  })
})
