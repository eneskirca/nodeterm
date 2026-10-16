import { describe, expect, it } from 'vitest'
import type { LinkProjectEntry, OpenLinkPrompt } from '../shared/open-link'
import { OPEN_LINKS_OFF_NOTICE, OPEN_LINK_PENDING_TTL_MS, createOpenLinkService, type OpenLinkDeps, type PathKind } from './open-link'

interface Harness {
  deps: OpenLinkDeps
  sent: { channel: string; payload: unknown }[]
  raised: number
  files: Map<string, { kind: PathKind; text?: string }>
  stored: string[]
  clock: { t: number }
  projects: LinkProjectEntry[]
  installed: boolean | undefined
  enabled: boolean
}

function harness(): Harness {
  const h: Harness = {
    sent: [],
    raised: 0,
    files: new Map([
      ['/dev/api', { kind: 'dir' }],
      ['/dev/api/sub', { kind: 'dir' }],
      ['/tmp/new', { kind: 'dir' }],
      ['/tmp/brief.md', { kind: 'file', text: '# Review\n\nPlease look.' }],
      ['/tmp/dir.md', { kind: 'dir' }]
    ]),
    stored: [],
    clock: { t: 1_000_000 },
    projects: [
      { id: 'api', name: 'asilo-api', cwd: '/dev/api' },
      { id: 'remote', name: 'remote', cwd: '/srv', ssh: true }
    ],
    installed: true,
    enabled: true,
    deps: undefined as unknown as OpenLinkDeps
  }
  let seq = 0
  h.deps = {
    statPath: async (p) => {
      const f = h.files.get(p)
      if (!f) return { kind: 'missing', size: 0 }
      return { kind: f.kind, size: f.text ? Buffer.byteLength(f.text) : 0 }
    },
    readText: async (p) => {
      const f = h.files.get(p)
      if (!f) return { kind: 'missing' }
      if (f.kind !== 'file') return { kind: 'not-file' }
      return f.text === undefined ? { kind: 'error' } : { kind: 'ok', text: f.text }
    },
    storePrompt: async (text) => {
      h.stored.push(text)
      return `/userdata/launch-prompts/${h.stored.length}.md`
    },
    projects: async () => h.projects,
    agentInstalled: async () => h.installed,
    send: (channel, payload) => h.sent.push({ channel, payload }),
    raise: () => {
      h.raised++
    },
    enabled: () => h.enabled,
    homeDir: () => '/Users/me',
    newId: () => `id${++seq}`,
    now: () => h.clock.t
  }
  return h
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const requests = (h: Harness) => h.sent.filter((s) => s.channel === 'request').map((s) => s.payload as OpenLinkPrompt)
const notices = (h: Harness) => h.sent.filter((s) => s.channel === 'notice').map((s) => (s.payload as { text: string }).text)

describe('open-link service: feature flag', () => {
  it('opens nothing while links are off, and says where to turn them on', async () => {
    const h = harness()
    h.enabled = false
    const svc = createOpenLinkService(h.deps)
    svc.ready()
    svc.receive('nodeterm://open?agent=claude&cwd=/dev/api')
    svc.receive('nodeterm://pair?code=abc')
    await flush()
    expect(requests(h)).toEqual([])
    expect(h.sent.filter((s) => s.channel === 'pair')).toEqual([])
    expect(notices(h)).toEqual([OPEN_LINKS_OFF_NOTICE, OPEN_LINKS_OFF_NOTICE])
    expect(h.raised).toBe(2)
  })

  it('refuses an accept after links were switched off with the sheet up', async () => {
    const h = harness()
    const svc = createOpenLinkService(h.deps)
    svc.ready()
    svc.receive('nodeterm://open?agent=claude&cwd=/dev/api')
    await flush()
    const [req] = requests(h)
    h.enabled = false
    const r = await svc.accept(req.id, { projectId: 'api' })
    expect(r.ok).toBe(false)
    expect(svc.pendingIds()).toEqual([])
  })
})

describe('open-link service: delivery', () => {
  it('holds a link that arrives before the renderer is ready, then delivers it', async () => {
    const h = harness()
    const svc = createOpenLinkService(h.deps)
    svc.receive('nodeterm://open?agent=claude&cwd=/dev/api')
    await flush()
    expect(h.sent).toEqual([])
    svc.ready()
    await flush()
    expect(requests(h)).toHaveLength(1)
    expect(h.raised).toBe(1)
  })

  it('holds again after the renderer goes away', async () => {
    const h = harness()
    const svc = createOpenLinkService(h.deps)
    svc.ready()
    svc.notReady()
    svc.receive('nodeterm://open?agent=claude')
    await flush()
    expect(h.sent).toEqual([])
    svc.ready()
    await flush()
    expect(requests(h)).toHaveLength(1)
  })

  it('drops links past 5 a minute, then accepts again', async () => {
    const h = harness()
    const svc = createOpenLinkService(h.deps)
    svc.ready()
    for (let i = 0; i < 7; i++) svc.receive('nodeterm://open?agent=claude')
    await flush()
    expect(requests(h)).toHaveLength(5)
    expect(notices(h).filter((t) => t.includes('Too many'))).toHaveLength(2)
    h.clock.t += 60_000
    svc.receive('nodeterm://open?agent=claude')
    await flush()
    expect(requests(h)).toHaveLength(6)
  })

  it('routes pair/join to the renderer and toasts a refusal', async () => {
    const h = harness()
    const svc = createOpenLinkService(h.deps)
    svc.ready()
    svc.receive('nodeterm://join?code=abc')
    svc.receive('nodeterm://open?agent=claude&count=9')
    await flush()
    expect(h.sent[0]).toEqual({ channel: 'pair', payload: { kind: 'join', url: 'nodeterm://join?code=abc' } })
    expect(notices(h)[0]).toContain('unknown parameter "count"')
  })
})

describe('open-link service: validation', () => {
  it('refuses a cwd that is missing or a file', async () => {
    const h = harness()
    const svc = createOpenLinkService(h.deps)
    svc.ready()
    svc.receive('nodeterm://open?agent=claude&cwd=/nope')
    svc.receive('nodeterm://open?agent=claude&cwd=/tmp/brief.md')
    await flush()
    expect(requests(h)).toHaveLength(0)
    expect(notices(h)).toHaveLength(2)
  })

  it('refuses a prompt file that is missing, not regular, too big or empty', async () => {
    const h = harness()
    h.files.set('/tmp/big.md', { kind: 'file', text: 'x'.repeat(64 * 1024 + 1) })
    h.files.set('/tmp/empty.md', { kind: 'file', text: '   ' })
    const svc = createOpenLinkService(h.deps)
    svc.ready()
    for (const f of ['/tmp/missing.md', '/tmp/dir.md', '/tmp/big.md', '/tmp/empty.md']) {
      svc.receive(`nodeterm://open?agent=claude&prompt-file=${f}`)
    }
    await flush()
    expect(requests(h)).toHaveLength(0)
    expect(notices(h).join('|')).toMatch(/does not exist.*not a regular file.*64 KB.*empty/)
  })

  it('shows the prompt file text and warns when the agent is missing', async () => {
    const h = harness()
    h.installed = false
    const svc = createOpenLinkService(h.deps)
    svc.ready()
    svc.receive('nodeterm://open?agent=codex&prompt-file=/tmp/brief.md&source=my-tool')
    await flush()
    const [r] = requests(h)
    expect(r).toMatchObject({ agent: 'codex', promptFileText: '# Review\n\nPlease look.', agentMissing: true, source: 'my-tool' })
  })

  it('refuses a prompt file with text the sheet would not show', async () => {
    const h = harness()
    h.files.set('/tmp/tags.md', { kind: 'file', text: `fix the bug${String.fromCodePoint(0xe0041, 0xe0042)}` })
    h.files.set('/tmp/rlo.md', { kind: 'file', text: 'safe \u202e text' })
    h.files.set('/tmp/c1.md', { kind: 'file', text: 'x\u0085y' })
    h.files.set('/tmp/emoji.md', { kind: 'file', text: 'ship it 👨\u200d💻' })
    const svc = createOpenLinkService(h.deps)
    svc.ready()
    for (const f of ['/tmp/tags.md', '/tmp/rlo.md', '/tmp/c1.md', '/tmp/emoji.md']) {
      svc.receive(`nodeterm://open?agent=claude&prompt-file=${f}`)
    }
    await flush()
    expect(notices(h).filter((t) => t.includes('invisible'))).toHaveLength(3)
    expect(requests(h).map((r) => r.promptFile)).toEqual(['/tmp/emoji.md'])
  })

  it('never offers /, the home folder or its ancestors as a new project', async () => {
    const h = harness()
    h.files.set('/', { kind: 'dir' })
    h.files.set('/Users', { kind: 'dir' })
    h.files.set('/Users/me', { kind: 'dir' })
    h.files.set('/Users/me/repo', { kind: 'dir' })
    const svc = createOpenLinkService(h.deps)
    svc.ready()
    for (const f of ['/', '/Users', '/Users/me', '/Users/me/repo']) svc.receive(`nodeterm://open?agent=claude&project-cwd=${f}`)
    await flush()
    expect(requests(h).map((r) => r.resolution.newProjectCwd)).toEqual([undefined, undefined, undefined, '/Users/me/repo'])
  })

  it('does not offer a new project for a folder that does not exist', async () => {
    const h = harness()
    const svc = createOpenLinkService(h.deps)
    svc.ready()
    svc.receive('nodeterm://open?agent=claude&project-cwd=/gone')
    await flush()
    expect(requests(h)[0].resolution.newProjectCwd).toBeUndefined()
  })
})

describe('open-link service: accept re-check', () => {
  async function asked(url: string) {
    const h = harness()
    const svc = createOpenLinkService(h.deps)
    svc.ready()
    svc.receive(url)
    await flush()
    return { h, svc, req: requests(h)[0] }
  }

  it('answers with main\'s cwd and prompt, never the renderer\'s', async () => {
    const { svc, req } = await asked('nodeterm://open?agent=claude&cwd=/dev/api/sub&prompt=hi')
    const res = await svc.accept(req.id, { projectId: 'api', title: 'T', cwd: '/etc', prompt: 'rm -rf' })
    expect(res).toEqual({ ok: true, open: { agent: 'claude', projectId: 'api', cwd: '/dev/api/sub', prompt: 'hi', title: 'T' } })
  })

  it('defaults the cwd to the chosen project\'s', async () => {
    const { svc, req } = await asked('nodeterm://open?agent=claude')
    const res = await svc.accept(req.id, { projectId: 'api' })
    expect(res).toMatchObject({ ok: true, open: { cwd: '/dev/api' } })
  })

  it('refuses a project that was not offered (incl. SSH)', async () => {
    const { svc, req } = await asked('nodeterm://open?agent=claude')
    expect(await svc.accept(req.id, { projectId: 'remote' })).toMatchObject({ ok: false })
    // single use: the id is gone after the first answer
    expect(await svc.accept(req.id, { projectId: 'api' })).toMatchObject({ ok: false })
  })

  it('refuses a new project that was not offered', async () => {
    const { svc, req } = await asked('nodeterm://open?agent=claude&cwd=/dev/api')
    expect(await svc.accept(req.id, { newProject: true })).toMatchObject({ ok: false })
  })

  it('accepts the offered new project', async () => {
    const { svc, req } = await asked('nodeterm://open?agent=claude&cwd=/tmp/new')
    expect(await svc.accept(req.id, { newProject: true })).toEqual({
      ok: true,
      open: { agent: 'claude', newProjectCwd: '/tmp/new', cwd: '/tmp/new' }
    })
  })

  it('refuses a project removed or turned SSH since', async () => {
    const { h, svc, req } = await asked('nodeterm://open?agent=claude')
    h.projects = []
    expect(await svc.accept(req.id, { projectId: 'api' })).toMatchObject({ ok: false })
  })

  it("refuses when the project's folder changed after the sheet was shown", async () => {
    const { h, svc, req } = await asked('nodeterm://open?agent=claude')
    h.projects = [{ id: 'api', name: 'asilo-api', cwd: '/dev/elsewhere' }]
    expect(await svc.accept(req.id, { projectId: 'api' })).toMatchObject({ ok: false, reason: expect.stringContaining('folder changed') })
  })

  it('refuses a bad title and an unknown id', async () => {
    const { svc, req } = await asked('nodeterm://open?agent=claude')
    expect(await svc.accept('nope', { projectId: 'api' })).toMatchObject({ ok: false })
    expect(await svc.accept(req.id, { projectId: 'api', title: 'a\nb' })).toMatchObject({ ok: false })
  })

  it('re-reads the prompt file, copies it, and refuses if it changed', async () => {
    const { h, svc, req } = await asked('nodeterm://open?agent=claude&prompt-file=/tmp/brief.md')
    const res = await svc.accept(req.id, { projectId: 'api' })
    expect(res).toMatchObject({ ok: true, open: { promptFile: '/userdata/launch-prompts/1.md' } })
    expect(h.stored).toEqual(['# Review\n\nPlease look.'])

    h.sent.length = 0
    svc.receive('nodeterm://open?agent=claude&prompt-file=/tmp/brief.md')
    await flush()
    const second = requests(h)[0]
    h.files.set('/tmp/brief.md', { kind: 'file', text: 'something else' })
    expect(await svc.accept(second.id, { projectId: 'api' })).toMatchObject({ ok: false, reason: expect.stringContaining('changed') })
  })

  it('forgets an unanswered request after the TTL, and on cancel', async () => {
    const { h, svc, req } = await asked('nodeterm://open?agent=claude')
    h.clock.t += OPEN_LINK_PENDING_TTL_MS + 1
    expect(await svc.accept(req.id, { projectId: 'api' })).toMatchObject({ ok: false, reason: expect.stringContaining('expired') })
    svc.receive('nodeterm://open?agent=claude')
    await flush()
    const next = requests(h).at(-1) as OpenLinkPrompt
    svc.cancel(next.id)
    expect(svc.pendingIds()).toEqual([])
  })
})
