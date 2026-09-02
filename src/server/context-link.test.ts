// The Server Edition's half of context-link: deriving the link map from persisted canvases, and
// registering the read handler core answers with. The reads themselves (authorization, transcript
// parsing, the local/remote split) are core's and are covered by src/core/context-link.handler.test.ts —
// what is tested here is the wiring that was missing server-side.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  promises as fsPromises,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveLinkMap, initServerContextLink } from './context-link'
import { setNodeTranscript } from '../core/context-link-core'
import { hookServer } from '../core/agents/hook-server'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import type { CanvasNodeState } from '../shared/types'
import type { PtyManager } from '../core/pty-manager'

const dir = mkdtempSync(join(tmpdir(), 'srv-ctxlink-'))
// initContextLink installs the skill + instruction blocks under the user's HOME. Point HOME at a
// scratch dir for the duration so a test run never edits the real ~/.claude / ~/.codex / ~/.gemini.
const realHome = process.env.HOME
let home = ''

/** Enough PtyManager for context-link: the tmux binary it stamps into each link document, and
 *  the terminal capture the `terminal` verb goes through. */
function fakePty(): PtyManager {
  return {
    getTmuxBin: () => '/usr/bin/tmux',
    captureSession: async (key: string) => `pane of ${key}`
  } as unknown as PtyManager
}

/** A serialized agent node, the shape `.nodeterm/project.json` stores in `nodes[]`. */
function node(id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState {
  return {
    id,
    kind: 'terminal',
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    title: id,
    color: '#fff',
    group: null,
    ...over
  } as CanvasNodeState
}

const bridge = (source: string, target: string) => ({ id: `bridge-${source}-${target}`, source, target })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'srv-ctxlink-home-'))
  process.env.HOME = home
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
})

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('deriveLinkMap', () => {
  it('maps a bridge between two agent nodes in BOTH directions', () => {
    const map = deriveLinkMap({
      canvases: () => [
        {
          id: 'p1',
          nodes: [node('term-a', { title: 'Alpha' }), node('term-b', { title: 'Beta' })],
          bridges: [bridge('term-a', 'term-b')]
        }
      ]
    })
    expect(map['term-a']).toEqual([{ id: 'term-b', title: 'Beta', cwd: '' }])
    expect(map['term-b']).toEqual([{ id: 'term-a', title: 'Alpha', cwd: '' }])
  })

  it('covers EVERY canvas — headless, no project is the active one', () => {
    const map = deriveLinkMap({
      canvases: () => [
        { id: 'p1', nodes: [node('a'), node('b')], bridges: [bridge('a', 'b')] },
        { id: 'p2', nodes: [node('c'), node('d')], bridges: [bridge('c', 'd')] }
      ]
    })
    // The desktop skips the active project (its renderer supplies that one live). There is no
    // renderer here, so skipping any project would silently sever a running agent's links.
    expect(Object.keys(map).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('drops bridges whose endpoints are no longer on the canvas', () => {
    const map = deriveLinkMap({
      canvases: () => [
        { id: 'p1', nodes: [node('a')], bridges: [bridge('a', 'deleted')] }
      ]
    })
    expect(map).toEqual({})
  })

  it('ignores a canvas with no bridges at all', () => {
    expect(deriveLinkMap({ canvases: () => [{ id: 'p1', nodes: [node('a'), node('b')] }] })).toEqual({})
  })

  it('links a sticky note one way only — a note cannot read', () => {
    const map = deriveLinkMap({
      canvases: () => [
        {
          id: 'p1',
          nodes: [node('sticky-1', { kind: 'sticky', title: 'Spec', text: 'ship it' }), node('term-a')],
          bridges: [bridge('sticky-1', 'term-a')]
        }
      ]
    })
    expect(map['term-a']).toEqual([{ id: 'sticky-1', title: 'Spec', note: 'ship it' }])
    expect(map['sticky-1']).toBeUndefined()
  })

  it('takes agent + session from the hooks when the serialized node predates the launch', () => {
    // A plain terminal the user started an agent CLI in by hand: project.json carries no agentId,
    // but the status mirror learned both from the hook events.
    const map = deriveLinkMap({
      canvases: () => [{ id: 'p1', nodes: [node('a'), node('b')], bridges: [bridge('a', 'b')] }],
      agentSessions: () => [{ nodeId: 'b', agentId: 'codex', sessionId: 'sess-b' }]
    })
    expect(map['a']).toEqual([{ id: 'b', title: 'b', cwd: '', agentId: 'codex', sessionId: 'sess-b' }])
  })
})

describe('initServerContextLink', () => {
  /** Start the wiring and hand back the handler it registered on the hook server — the exact
   *  function the /context-link/ route calls. */
  function start(deps: Parameters<typeof initServerContextLink>[0]) {
    const spy = vi.spyOn(hookServer, 'setContextLinkHandler')
    const link = initServerContextLink(deps)
    const handler = spy.mock.calls.at(-1)?.[0]
    spy.mockRestore()
    return { link, handler: handler!, registered: !!handler }
  }

  it('registers the read handler the route would otherwise refuse for', async () => {
    const { link, handler, registered } = start({
      ptyManager: fakePty(),
      canvases: () => [
        {
          id: 'p1',
          nodes: [node('term-a', { title: 'Alpha' }), node('term-b', { title: 'Beta' })],
          bridges: [bridge('term-a', 'term-b')]
        }
      ],
      installAgentIntegrations: false
    })
    // Without this registration the hook server answers every read with
    // "Context link is unavailable in this session." — the whole desktop-only symptom.
    expect(registered).toBe(true)
    const shimBody = readFileSync(join(dir, 'context-links', 'context.sh'), 'utf8')
    expect(shimBody).toContain('CODEX_THREAD_ID')
    expect(shimBody).toContain(join(dir, 'codex-thread-nodes'))
    await link.refresh()
    const out = await handler({ verb: 'list', nodeId: 'term-a', args: {} })
    expect(out).toContain('Beta')
    expect(out).toContain('term-b')
    await link.stop()
  })

  it('answers a node with no links, rather than pretending the feature is missing', async () => {
    const { link, handler } = start({
      ptyManager: fakePty(),
      canvases: () => [],
      installAgentIntegrations: false
    })
    await link.refresh()
    const out = await handler({ verb: 'list', nodeId: 'term-a', args: {} })
    expect(out).toContain('No linked nodes')
    await link.stop()
  })

  it('respects installHooks false while keeping the read handler available', async () => {
    const { link, registered } = start({
      ptyManager: fakePty(),
      canvases: () => [],
      installAgentIntegrations: false
    })
    expect(registered).toBe(true)
    expect(existsSync(join(home, '.claude', 'skills', 'get-linked-context', 'SKILL.md'))).toBe(false)
    expect(existsSync(join(home, '.codex', 'AGENTS.md'))).toBe(false)
    await link.stop()
  })

  // The other half of the pair. With the flag REQUIRED, every other case in this file says
  // `false`, so without this the install branch would have no coverage at all and "we stopped
  // writing into $HOME" would be indistinguishable from "we can no longer write into $HOME".
  // Safe to assert for real: `home` is a per-test scratch dir this suite points HOME at.
  it('installs the discovery surface into the agent config dirs when asked to', async () => {
    const { link, registered } = start({
      ptyManager: fakePty(),
      canvases: () => [],
      installAgentIntegrations: true
    })
    expect(registered).toBe(true)
    expect(existsSync(join(home, '.claude', 'skills', 'get-linked-context', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8')).toContain(
      'nodeterm:get-linked-context'
    )
    const relativePaths = [
      ['.agents', 'skills', 'get-linked-context', 'SKILL.md'],
      ['.gemini', 'antigravity-cli', 'skills', 'get-linked-context', 'SKILL.md']
    ]
    for (const parts of relativePaths) expect(existsSync(join(home, ...parts)), parts.join('/')).toBe(true)
    await link.stop()
  })

  it('picks up a bridge drawn after boot', async () => {
    let bridges = [] as ReturnType<typeof bridge>[]
    const { link, handler } = start({
      ptyManager: fakePty(),
      canvases: () => [{ id: 'p1', nodes: [node('term-a'), node('term-b', { title: 'Beta' })], bridges }],
      installAgentIntegrations: false
    })
    await link.refresh()
    expect(await handler({ verb: 'list', nodeId: 'term-a', args: {} })).toContain('No linked nodes')
    // What a browser drawing the edge produces: a workspace save, and the onPersist refresh.
    bridges = [bridge('term-a', 'term-b')]
    await link.refresh()
    expect(await handler({ verb: 'list', nodeId: 'term-a', args: {} })).toContain('Beta')
    await link.stop()
  })

  it('rewrites when a linked node\'s transcript arrives, though the canvas never changed', async () => {
    const transcript = join(dir, 'late.jsonl')
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'ship it' } }))
    const canvases = () => [
      {
        id: 'p1',
        nodes: [node('term-a'), node('term-b', { title: 'Beta', agentId: 'claude' as const })],
        bridges: [bridge('term-a', 'term-b')]
      }
    ]
    const { link, handler } = start({
      ptyManager: fakePty(),
      canvases,
      installAgentIntegrations: false
    })
    await link.refresh()
    expect(await handler({ verb: 'summary', nodeId: 'term-a', args: {} })).toContain(
      'no conversation transcript yet'
    )
    // The transcript path is hook-fed, so it lands with no canvas change behind it — the sweep's
    // change signature has to include it or the link document stays permanently empty.
    setNodeTranscript('term-b', 'sess-b', transcript)
    await link.refresh()
    expect(await handler({ verb: 'summary', nodeId: 'term-a', args: {} })).toContain('user: ship it')
    await link.stop()
  })

  it('settles owed writes on stop, and writes nothing afterwards', async () => {
    const { link } = start({
      ptyManager: fakePty(),
      canvases: () => [
        { id: 'p1', nodes: [node('term-a'), node('term-b')], bridges: [bridge('term-a', 'term-b')] }
      ],
      installAgentIntegrations: false
    })
    // Neither the sweep nor onPersist awaits a refresh, so at close there is normally one in
    // flight. A stop that does not drain it lets link files land in a dataDir the caller is
    // already tearing down (a server test caught exactly that, as ENOTEMPTY).
    const owed = link.refresh()
    await link.stop()
    await expect(owed).resolves.toBeUndefined()
    const writes = vi.spyOn(fsPromises, 'writeFile')
    await link.refresh()
    expect(writes).not.toHaveBeenCalled()
    writes.mockRestore()
  })

  it('skips the rewrite when nothing moved', async () => {
    const { link } = start({
      ptyManager: fakePty(),
      canvases: () => [
        { id: 'p1', nodes: [node('term-a'), node('term-b')], bridges: [bridge('term-a', 'term-b')] }
      ],
      installAgentIntegrations: false
    })
    await link.refresh()
    // The sweep runs every 15s for the life of the server: an unconditional rewrite would be a
    // clear-and-rewrite of every link file, forever, on a canvas nobody is touching.
    const writes = vi.spyOn(fsPromises, 'writeFile')
    await link.refresh()
    await link.refresh()
    expect(writes).not.toHaveBeenCalled()
    writes.mockRestore()
    await link.stop()
  })
})
