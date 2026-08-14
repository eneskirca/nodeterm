// A13 — per-route identity enforcement on `/control/*` and `/context-link/*`.
//
// Real hook server, real POSTs, spies for the handlers: "refused" here means the handler never ran,
// not that the reply looked unhappy. The properties this file exists to pin:
//
//  - trust on first proof: a node that has never presented a token keeps the legacy path; one that
//    HAS is latched, and an unverified request for it afterwards is refused.
//  - a FOREIGN kid never proves a node and is never caught by the latch — that is what keeps the
//    documented cross-instance failover alive.
//  - the latch is in memory only. Persisting it would let one filesystem accident brick a node
//    forever; a restart must re-earn it, which it does within one hook event.
//  - the dated window: an unverified mutation EXECUTES and carries the restart line until
//    2026-10-13, and is refused with the same shape afterwards.
//  - `write`/`close` keep their user confirmation whatever the token says.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import { nodeTokenDir } from './node-token-files'
import { initNodeTokens, refreshNodeTokens, sweepNodeToken } from './node-token-service'
import {
  IDENTITY_REFUSED_NOTE,
  IDENTITY_RESTART_NOTE,
  IDENTITY_UNMINTABLE_NOTE,
  IDENTITY_UNMINTABLE_WARN_NOTE,
  NODE_IDENTITY_STRICT_AFTER,
  TOLERANT_CONTROL_VERBS
} from './node-identity-policy'
import { CONTEXT_LINK_VERBS } from '../context-link-render'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'

const SECRET = Buffer.alloc(32, 11)
// Another instance's secret ⇒ another instance's kid ⇒ the `legacy` failover verdict, NOT `forged`.
const OTHER_SECRET = Buffer.alloc(32, 13)

const IN_WINDOW = new Date('2026-09-01T00:00:00Z')
const PAST_CUTOFF = new Date('2026-11-01T00:00:00Z')

let dir = ''
let controlCalls: { verb: string; nodeId: string }[] = []
let contextCalls: { verb: string; nodeId: string }[] = []

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'X-Nodeterm-Hook-Token': hookServer.getToken(),
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/plain'
  }
  if (token !== undefined) h['X-Nodeterm-Node-Token'] = token
  return h
}

function control(verb: string, nodeId: string, token?: string, accept = 'text/plain'): Promise<Response> {
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/control/${verb}`, {
    method: 'POST',
    headers: { ...headers(token), accept },
    body: `nodeId=${encodeURIComponent(nodeId)}`
  })
}

function contextLink(verb: string, nodeId: string, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/context-link/${verb}`, {
    method: 'POST',
    headers: headers(token),
    body: `nodeId=${encodeURIComponent(nodeId)}`
  })
}

/** A real hook event — the only thing that can put a node in `provenNodes`. */
function hookEvent(nodeId: string, token?: string): Promise<Response> {
  const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi' })
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/claude`, {
    method: 'POST',
    headers: headers(token),
    body: `nodeId=${encodeURIComponent(nodeId)}&payload=${encodeURIComponent(payload)}`
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hooksrv-identity-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  hookServer.setControlHandler(async ({ verb, nodeId }) => {
    controlCalls.push({ verb, nodeId })
    return { ok: true, message: `did ${verb}` }
  })
  hookServer.setContextLinkHandler(async ({ verb, nodeId }) => {
    contextCalls.push({ verb, nodeId })
    return 'the linked transcript'
  })
})

afterAll(() => {
  hookServer.setIdentityClockForTests(() => new Date())
  hookServer.setIdentityStrictOverride(() => undefined)
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  resetPlatformForTests()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  controlCalls = []
  contextCalls = []
  hookServer.setIdentityClockForTests(() => IN_WINDOW)
  hookServer.setIdentityStrictOverride(() => undefined)
})

describe('/control/* during the warning window', () => {
  it('runs an unverified mutation and prefixes the reply with the restart note', async () => {
    const res = await control('open-terminal', 'n-window')
    expect(res.status).toBe(200)
    const body = await res.text()
    // It EXECUTED — that is the promise of the window.
    expect(controlCalls).toEqual([{ verb: 'open-terminal', nodeId: 'n-window' }])
    expect(body.startsWith(IDENTITY_RESTART_NOTE)).toBe(true)
    // …and the reply the agent came for is still there, under the note.
    expect(body).toContain('did open-terminal')
  })

  it('never warns a verified mutation', async () => {
    const res = await control('open-terminal', 'n-verified', nodeAuthToken(SECRET, 'n-verified'))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain(IDENTITY_RESTART_NOTE)
    expect(body.trim()).toBe('did open-terminal')
    expect(controlCalls).toHaveLength(1)
  })

  it('lets a tolerant verb through silently — it leaks canvas shape but changes nothing', async () => {
    const res = await control('list', 'n-list')
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain(IDENTITY_RESTART_NOTE)
    expect(controlCalls).toEqual([{ verb: 'list', nodeId: 'n-list' }])
  })

  it('403s a forged token without a word of advice — nothing legitimate produces one', async () => {
    const forged = nodeAuthToken(SECRET, 'somebody-else')
    const res = await control('open-terminal', 'n-forged', forged)
    expect(res.status).toBe(403)
    expect(controlCalls).toEqual([])
  })
})

describe('/control/* after the cutoff', () => {
  beforeEach(() => {
    hookServer.setIdentityClockForTests(() => PAST_CUTOFF)
  })

  it('refuses an unverified mutation BEFORE the handler runs, with the same sentence', async () => {
    const res = await control('open-terminal', 'n-cutoff')
    expect(res.status).toBe(403)
    expect((await res.text()).trim()).toBe(IDENTITY_REFUSED_NOTE)
    // The point of the feature: nothing happened.
    expect(controlCalls).toEqual([])
  })

  it('answers a JSON caller in JSON, not in text', async () => {
    const res = await control('open-terminal', 'n-cutoff-json', undefined, 'application/json')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: IDENTITY_REFUSED_NOTE })
    expect(controlCalls).toEqual([])
  })

  it('still lets a verified mutation through', async () => {
    const res = await control('open-terminal', 'n-strict-ok', nodeAuthToken(SECRET, 'n-strict-ok'))
    expect(res.status).toBe(200)
    expect(controlCalls).toHaveLength(1)
  })

  it('still lets an unproven node read the canvas shape', async () => {
    const res = await control('list', 'n-strict-list')
    expect(res.status).toBe(200)
    expect(controlCalls).toEqual([{ verb: 'list', nodeId: 'n-strict-list' }])
  })
})

describe('/context-link/* degrades to prose, never to silence', () => {
  it('takes the legacy path for a node that has never proven itself', async () => {
    const res = await contextLink('transcript', 'n-ctx-legacy')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('the linked transcript')
    expect(contextCalls).toEqual([{ verb: 'transcript', nodeId: 'n-ctx-legacy' }])
  })

  it('refuses a latched node with a SENTENCE and a 200 — the agent asked for a read', async () => {
    expect((await hookEvent('n-ctx-proven', nodeAuthToken(SECRET, 'n-ctx-proven'))).status).toBe(204)
    const res = await contextLink('transcript', 'n-ctx-proven')
    // Not a 403: the shim turns any non-200 into "nodeterm unreachable", which would be a lie and
    // tells the agent nothing it can act on.
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe(IDENTITY_REFUSED_NOTE)
    expect(contextCalls).toEqual([])
  })

  it('403s a forged token here too', async () => {
    const res = await contextLink('transcript', 'n-ctx-forged', nodeAuthToken(SECRET, 'other'))
    expect(res.status).toBe(403)
    expect(contextCalls).toEqual([])
  })
})

describe('trust on first proof', () => {
  it('is not proven before the first hook event, and is one event later', async () => {
    expect(hookServer.isNodeProven('n-latch')).toBe(false)
    // Before proof, unverified control mutations run (with the note) — the legacy path.
    expect((await control('open-terminal', 'n-latch')).status).toBe(200)
    expect(controlCalls).toHaveLength(1)

    // ONE hook event with this node's own token is the whole ceremony. That is why a restart
    // re-proves immediately and why the latch never needs to be written down.
    expect((await hookEvent('n-latch', nodeAuthToken(SECRET, 'n-latch'))).status).toBe(204)
    expect(hookServer.isNodeProven('n-latch')).toBe(true)

    // After proof, the same tokenless request is refused — the session demonstrably CAN
    // authenticate, so one that suddenly cannot is a different process or a forgery.
    const res = await control('open-terminal', 'n-latch')
    expect(res.status).toBe(403)
    expect((await res.text()).trim()).toBe(IDENTITY_REFUSED_NOTE)
    expect(controlCalls).toHaveLength(1)
  })

  it('latches `list` too — it is not a mutation, but it is still the wrong caller', async () => {
    expect((await hookEvent('n-latch-list', nodeAuthToken(SECRET, 'n-latch-list'))).status).toBe(204)
    expect((await control('list', 'n-latch-list')).status).toBe(403)
    expect(controlCalls).toEqual([])
  })

  it('is released by hookIdentityStrict = false, without downgrading the app', async () => {
    expect((await hookEvent('n-hatch', nodeAuthToken(SECRET, 'n-hatch'))).status).toBe(204)
    expect((await control('open-terminal', 'n-hatch')).status).toBe(403)
    controlCalls = []
    hookServer.setIdentityStrictOverride(() => false)
    const res = await control('open-terminal', 'n-hatch')
    expect(res.status).toBe(200)
    expect((await res.text()).startsWith(IDENTITY_RESTART_NOTE)).toBe(true)
    expect(controlCalls).toHaveLength(1)
  })

  it('is brought forward by hookIdentityStrict = true, before the cutoff', async () => {
    hookServer.setIdentityStrictOverride(() => true)
    const res = await control('open-terminal', 'n-early-strict')
    expect(res.status).toBe(403)
    expect(controlCalls).toEqual([])
  })
})

describe('a foreign kid', () => {
  const FOREIGN = () => nodeAuthToken(OTHER_SECRET, 'n-foreign')

  it('never proves a node', async () => {
    expect((await hookEvent('n-foreign', FOREIGN())).status).toBe(204)
    expect(hookServer.isNodeProven('n-foreign')).toBe(false)
  })

  it('is never caught by the latch — the cross-instance failover has to keep working', async () => {
    // Prove the node with THIS instance's token first, so the latch is armed…
    expect((await hookEvent('n-foreign2', nodeAuthToken(SECRET, 'n-foreign2'))).status).toBe(204)
    expect(hookServer.isNodeProven('n-foreign2')).toBe(true)
    // A TOKENLESS caller is now refused…
    expect((await control('open-terminal', 'n-foreign2')).status).toBe(403)
    // …but a caller holding ANOTHER instance's token is the documented failover, not an impostor,
    // so it gets the window's behaviour: it runs, and it is told to restart.
    const res = await control('open-terminal', 'n-foreign2', nodeAuthToken(OTHER_SECRET, 'n-foreign2'))
    expect(res.status).toBe(200)
    expect((await res.text()).startsWith(IDENTITY_RESTART_NOTE)).toBe(true)
    expect(controlCalls).toEqual([{ verb: 'open-terminal', nodeId: 'n-foreign2' }])
  })
})

/**
 * THE COUNTER-CLAIM, PINNED. Three places in this series used to describe the latch as the feature's
 * security boundary. It is not one, and the difference matters enough to spend a test on: someone
 * reading `controlPolicy` alone will re-derive the stronger claim, because the table really does say
 * `legacy + latched → refuse`.
 *
 * What that table cannot show is who gets to be `legacy`. `verifyNodeToken` reads a token whose
 * `kid` is not ours as FOREIGN ⇒ `legacy`, and invariant 3 requires a foreign kid to never prove and
 * never latch (or the cross-instance failover dies the day a second instance exists). The attacker
 * chooses the kid. So a token made of arbitrary characters is admitted for a latched victim node,
 * while the honest tokenless caller for that same node is refused.
 *
 * The behaviour below is CORRECT and must not be "fixed" — the only hardening that would change it
 * is `node-tokens/<kid>/<nodeId>` (see `writeNodeTokens`), which removes the reason a foreign kid
 * has to be admitted at all. This test exists so the false claim cannot come back.
 */
describe('an invented kid is admitted — the latch is not an adversary boundary', () => {
  // Eight arbitrary characters, a dot, an arbitrary tail: the wire shape, none of the substance.
  // Nothing derives it, nothing on this machine ever held it.
  const INVENTED = 'AAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

  it('is not a token this instance could ever mint, and is not `forged` either', async () => {
    // Sanity, so the probe below cannot pass for the boring reason that it accidentally IS a token.
    expect(INVENTED).not.toBe(nodeAuthToken(SECRET, 'n-invented'))
    // `forged` would be a 403 on /hook/* — the whole point is that a foreign kid is not judgeable,
    // so it lands on the fail-open verdict instead.
    expect((await hookEvent('n-invented', INVENTED)).status).toBe(204)
    expect(hookServer.isNodeProven('n-invented')).toBe(false)
  })

  for (const [when, clock] of [
    ['during the window', IN_WINDOW],
    ['after the cutoff', PAST_CUTOFF]
  ] as const) {
    it(`walks past the latch into /control/list ${when}, as the victim node`, async () => {
      hookServer.setIdentityClockForTests(() => clock)
      const node = `n-invented-list-${when.replace(/\s/g, '-')}`
      // Arm the latch for real: the victim proves itself with this instance's own token.
      expect((await hookEvent(node, nodeAuthToken(SECRET, node))).status).toBe(204)
      expect(hookServer.isNodeProven(node)).toBe(true)
      // The honest tokenless caller is refused — this is the latch working as designed…
      expect((await control('list', node)).status).toBe(403)
      expect(controlCalls).toEqual([])
      // …and the attacker, who simply made a kid up, is not.
      const res = await control('list', node, INVENTED)
      expect(res.status).toBe(200)
      expect(controlCalls).toEqual([{ verb: 'list', nodeId: node }])
    })

    it(`reads EVERY context-link verb for a latched victim ${when}`, async () => {
      hookServer.setIdentityClockForTests(() => clock)
      const node = `n-invented-ctx-${when.replace(/\s/g, '-')}`
      expect((await hookEvent(node, nodeAuthToken(SECRET, node))).status).toBe(204)
      // Tokenless gets the refusal sentence instead of the transcript.
      expect((await contextLink('transcript', node)).status).toBe(200)
      expect(contextCalls).toEqual([])

      // Every verb the route actually serves, not a hand-picked one: a verb added later must be
      // covered by this claim too, or the doc it pins goes quietly out of date.
      for (const verb of CONTEXT_LINK_VERBS) {
        const res = await contextLink(verb, node, INVENTED)
        expect(res.status, verb).toBe(200)
        // The rendered transcript itself — not the refusal prose. This is the leak.
        expect(await res.text(), verb).toContain('the linked transcript')
      }
      expect(contextCalls).toEqual(CONTEXT_LINK_VERBS.map((verb) => ({ verb, nodeId: node })))
    })
  }

  it('buys nothing extra on a MUTATION after the cutoff — that much the cutoff does hold', async () => {
    // The escape is bounded: `legacy` is still refused for mutations past the date, invented kid or
    // not. What the invented kid defeats is the LATCH, i.e. the tolerant bucket and the window.
    hookServer.setIdentityClockForTests(() => PAST_CUTOFF)
    const res = await control('open-terminal', 'n-invented-mutation', INVENTED)
    expect(res.status).toBe(403)
    expect(controlCalls).toEqual([])
  })
})

describe('the latch is memory, not state', () => {
  it('leaves no trace of a proven node anywhere under the data dir', async () => {
    expect((await hookEvent('n-nopersist', nodeAuthToken(SECRET, 'n-nopersist'))).status).toBe(204)
    expect(hookServer.isNodeProven('n-nopersist')).toBe(true)
    const walk = (root: string): string[] =>
      readdirSync(root).flatMap((entry) => {
        const full = join(root, entry)
        return statSync(full).isDirectory() ? walk(full) : [full]
      })
    for (const file of walk(dir)) {
      // A persisted latch is a node that one filesystem accident can brick forever. Nothing on
      // disk may know which nodes have proven themselves.
      expect(readFileSync(file, 'utf8'), file).not.toContain('n-nopersist')
    }
  })
})

describe('write/close keep the human in the loop, token or no token', () => {
  it('sends a verified destructive verb to the handler that owns the confirmation', async () => {
    const res = await control('write', 'n-write-v', nodeAuthToken(SECRET, 'n-write-v'))
    expect(res.status).toBe(200)
    // Identity never short-circuits INTO the action: it can only refuse before the handler, never
    // stand in for the dialog the handler puts up.
    expect(controlCalls).toEqual([{ verb: 'write', nodeId: 'n-write-v' }])
  })

  it('sends an unverified destructive verb there too, during the window', async () => {
    const res = await control('close', 'n-close-l')
    expect(res.status).toBe(200)
    expect(controlCalls).toEqual([{ verb: 'close', nodeId: 'n-close-l' }])
    expect((await res.text()).startsWith(IDENTITY_RESTART_NOTE)).toBe(true)
  })

  it('never waves them through as tolerant', () => {
    // The confirm-gated pair (src/main/canvas-control-core.ts `isDestructiveVerb`) is untouched by
    // this feature. Tolerance would be the one way identity could weaken it, so it is pinned here;
    // the set itself is covered in canvas-control-core.test.ts.
    expect(TOLERANT_CONTROL_VERBS.has('write')).toBe(false)
    expect(TOLERANT_CONTROL_VERBS.has('close')).toBe(false)
  })
})

describe('an instance with no secret at all', () => {
  it('gates nobody — not even past the cutoff', async () => {
    // safeStorage unavailable on the desktop, an uncreatable key file on the Server Edition. This
    // instance cannot mint a token, so nothing can ever be verified here; warning or refusing
    // `legacy` would hit EVERY caller on the machine with advice that cannot work.
    hookServer.clearNodeAuthSecretForTests()
    hookServer.setIdentityClockForTests(() => PAST_CUTOFF)
    try {
      const res = await control('open-terminal', 'n-nosecret')
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).not.toContain(IDENTITY_RESTART_NOTE)
      expect(body.trim()).toBe('did open-terminal')
      expect(controlCalls).toHaveLength(1)
    } finally {
      hookServer.setNodeAuthSecret(SECRET)
    }
  })
})

describe('both shells wire the escape hatch', () => {
  it('is set from settings.hookIdentityStrict in the desktop AND the Server Edition', () => {
    // This repo has shipped a hook-server change to one shell only three times. An unwired shell
    // has no hatch at all, which is the one thing a stranded user cannot work around.
    const root = resolve(__dirname, '../../..')
    for (const rel of ['src/main/index.ts', 'src/server/index.ts']) {
      const src = readFileSync(join(root, rel), 'utf8')
      expect(src, rel).toContain('setIdentityStrictOverride')
      expect(src, rel).toContain('hookIdentityStrict')
    }
  })
})

/**
 * Sweeping a node's token WITHOUT releasing the latch is the one way this feature can kill a live
 * node outright: the latch refuses an unverified caller immediately, on both sides of the cutoff,
 * so the node gets a hard 403 on every canvas-control call for the rest of the session — advised to
 * restart to pick up an identity there is no longer one to pick up.
 *
 * The collision case is the realistic one, and it is a sequence, not a state: the refusal in
 * `node-token-service.ts` is what keeps a fold-collision from becoming a hijack, but it fires the
 * moment the twin appears, which can be long after the first node materialised AND proved itself.
 */
describe('a swept token must also release the latch', () => {
  it('un-proves a node whose case-folding twin turns up and gets the whole set refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let hostile = false
    // 1. The node is alone on the canvas, so it gets a token file…
    initNodeTokens({
      canvases: () => [
        { nodes: hostile ? [{ id: 'Term-1' }, { id: 'term-1' }] : [{ id: 'Term-1' }] }
      ]
    })
    expect(existsSync(join(nodeTokenDir(), 'Term-1'))).toBe(true)
    // …and its session proves itself with it.
    expect((await hookEvent('Term-1', nodeAuthToken(SECRET, 'Term-1'))).status).toBe(204)
    expect(hookServer.isNodeProven('Term-1')).toBe(true)

    // 2. A shared `project.json` puts the case-variant twin on the canvas. Both are refused tokens
    //    and both files are swept — correctly: on APFS they are one file, and leaving either is the
    //    hijack. Those nodes belong on `legacy`.
    hostile = true
    refreshNodeTokens()
    expect(existsSync(join(nodeTokenDir(), 'Term-1'))).toBe(false)

    // 3. The live session has nothing left to read, so its next call is tokenless. It must land
    //    back in the warning window, not on a permanent 403 — and it must be told the truth about
    //    WHY, because this node cannot mint until `project.json` changes. This assertion used to
    //    read `IDENTITY_RESTART_NOTE`, which is the loop measured in the field.
    expect(hookServer.isNodeProven('Term-1')).toBe(false)
    const res = await control('open-terminal', 'Term-1')
    expect(res.status).toBe(200)
    expect((await res.text()).startsWith(IDENTITY_UNMINTABLE_WARN_NOTE)).toBe(true)
    expect(controlCalls).toEqual([{ verb: 'open-terminal', nodeId: 'Term-1' }])
    warn.mockRestore()
  })

  it('un-proves a node whose token is swept on delete, closing the re-create gap', async () => {
    // Delete/re-create reuses the id: A6 sweeps the file and rewrites it, and a shell reading in
    // that gap is tokenless while the node is still latched from before the delete.
    initNodeTokens({ canvases: () => [{ nodes: [{ id: 'n-recreate' }] }] })
    expect((await hookEvent('n-recreate', nodeAuthToken(SECRET, 'n-recreate'))).status).toBe(204)
    expect(hookServer.isNodeProven('n-recreate')).toBe(true)
    sweepNodeToken('n-recreate')
    expect(hookServer.isNodeProven('n-recreate')).toBe(false)
    expect((await control('open-terminal', 'n-recreate')).status).toBe(200)
  })

  it('re-earns the latch on the very next valid event — releasing it costs nothing', async () => {
    initNodeTokens({ canvases: () => [{ nodes: [{ id: 'n-relatch' }] }] })
    expect((await hookEvent('n-relatch', nodeAuthToken(SECRET, 'n-relatch'))).status).toBe(204)
    sweepNodeToken('n-relatch')
    expect(hookServer.isNodeProven('n-relatch')).toBe(false)
    expect((await hookEvent('n-relatch', nodeAuthToken(SECRET, 'n-relatch'))).status).toBe(204)
    expect(hookServer.isNodeProven('n-relatch')).toBe(true)
    expect((await control('open-terminal', 'n-relatch')).status).toBe(403)
  })
})

/**
 * The refusal that told a node to restart to pick up an identity that cannot exist.
 *
 * Two populations can never hold a token, however many times they are restarted: a case-folding
 * collision group (refused by design — on APFS they would share one file) and a node id outside
 * `isSafeNodeId`, which reaches the canvas because `fileToProject` does not validate ids read out
 * of `project.json`. Before the cutoff they get the warning window; after it every mutation is
 * refused forever, and `IDENTITY_REFUSED_NOTE` sent them round a restart loop while the only real
 * signal was a `console.warn` in the main-process log.
 */
describe('a node that can NEVER have an identity is told so, and not told to restart', () => {
  beforeEach(() => {
    hookServer.setIdentityClockForTests(() => PAST_CUTOFF)
  })

  it('names the cause for a case-folding collision group, on both dialects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initNodeTokens({ canvases: () => [{ nodes: [{ id: 'Dup-1' }, { id: 'dup-1' }] }] })
    try {
      const text = await control('open-terminal', 'Dup-1')
      expect(text.status).toBe(403)
      expect((await text.text()).trim()).toBe(IDENTITY_UNMINTABLE_NOTE)
      // Both members of the set, not just the one that lost the race to the shared file.
      const json = await control('open-terminal', 'dup-1', undefined, 'application/json')
      expect(json.status).toBe(403)
      expect(await json.json()).toEqual({ ok: false, error: IDENTITY_UNMINTABLE_NOTE })
      expect(controlCalls).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('names it for an id `isSafeNodeId` refuses, with nothing registered at all', async () => {
    // No materialiser pass has ever seen this id — the server reads the impossibility off the id.
    for (const nodeId of ['has space', 'a/b', '..', 'x'.repeat(129), '']) {
      const res = await control('open-terminal', nodeId)
      expect(res.status, nodeId).toBe(403)
      expect((await res.text()).trim(), nodeId).toBe(IDENTITY_UNMINTABLE_NOTE)
    }
    expect(controlCalls).toEqual([])
  })

  it('does not say "Restart", because restarting is the thing that cannot work', () => {
    expect(IDENTITY_UNMINTABLE_NOTE).not.toContain('Restart')
    expect(IDENTITY_REFUSED_NOTE).toContain('Restart')
  })

  it('keeps the ordinary sentence for an ordinary node — the one a restart DOES fix', async () => {
    const res = await control('open-terminal', 'n-ordinary-refusal')
    expect(res.status).toBe(403)
    expect((await res.text()).trim()).toBe(IDENTITY_REFUSED_NOTE)
  })

  it('goes back to the ordinary sentence once the twin leaves the canvas', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let twinned = true
    initNodeTokens({
      canvases: () => [{ nodes: twinned ? [{ id: 'Gone-1' }, { id: 'gone-1' }] : [{ id: 'Gone-1' }] }]
    })
    try {
      expect((await (await control('open-terminal', 'Gone-1')).text()).trim()).toBe(
        IDENTITY_UNMINTABLE_NOTE
      )
      // The twin is removed from `project.json`; the next persist re-materialises the survivor.
      twinned = false
      refreshNodeTokens()
      expect(existsSync(join(nodeTokenDir(), 'Gone-1'))).toBe(true)
      // There IS an identity to pick up now, so the advice to restart is true again.
      expect((await (await control('open-terminal', 'Gone-1')).text()).trim()).toBe(
        IDENTITY_REFUSED_NOTE
      )
    } finally {
      warn.mockRestore()
    }
  })
})

/**
 * THE WINDOW IS WHERE THAT SENTENCE WAS NEEDED, AND IT WAS THE ONE PLACE IT COULD NOT REACH.
 *
 * Measured against a real hook server on 2026-08-14: node `Term-X`, a refused case-fold collision
 * member, was handed `IDENTITY_RESTART_NOTE` — "Restart this node… to pick one up" — for a node
 * that has nothing to pick up. `controlPolicy` answers `allow-with-warning` for exactly this
 * population until 2026-10-13, and the warn branch emitted one fixed string, so the unmintable
 * wording only ever appeared AFTER the cutoff (or for a latched node). For the whole warning
 * window — the entire period the note exists to serve — its audience got the restart loop instead.
 */
describe('an unmintable node during the warning window, where the loop actually happens', () => {
  const collide = (a: string, b: string): void => {
    initNodeTokens({ canvases: () => [{ nodes: [{ id: a }, { id: b }] }] })
  }

  it('runs the command AND names the cause instead of advising a restart', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      collide('Warn-1', 'warn-1')
      const res = await control('open-terminal', 'Warn-1')
      // `allow-with-warning`, not a refusal: the window's promise is that the command still runs,
      // and an unmintable node is not a suspect — it is a node whose project.json is wrong.
      expect(res.status).toBe(200)
      expect(controlCalls).toEqual([{ verb: 'open-terminal', nodeId: 'Warn-1' }])
      const body = await res.text()
      expect(body.startsWith(IDENTITY_UNMINTABLE_WARN_NOTE)).toBe(true)
      expect(body).toContain('did open-terminal')
      expect(body).not.toContain(IDENTITY_RESTART_NOTE)
    } finally {
      warn.mockRestore()
    }
  })

  it('says it in the JSON dialect too, in the `warning` field a legacy client parses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      collide('Warn-2', 'warn-2')
      const res = await control('open-terminal', 'Warn-2', undefined, 'application/json')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        ok: true,
        message: 'did open-terminal',
        warning: IDENTITY_UNMINTABLE_WARN_NOTE
      })
      expect(controlCalls).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('says it for an id `isSafeNodeId` refuses, which no materialiser pass has ever seen', async () => {
    // The `project.json` provenance case: `fileToProject` does not validate ids, so a shared repo
    // can put a space (or a slash, or `..`) on the canvas and `nodeAuthToken` returns '' forever.
    for (const nodeId of ['has space', 'a/b', '..']) {
      const res = await control('open-terminal', nodeId)
      expect(res.status, nodeId).toBe(200)
      expect((await res.text()).startsWith(IDENTITY_UNMINTABLE_WARN_NOTE), nodeId).toBe(true)
    }
  })

  it('leaves the ORDINARY unproven node on the restart line — that is the common case', async () => {
    const res = await control('open-terminal', 'n-ordinary-warning')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body.startsWith(IDENTITY_RESTART_NOTE)).toBe(true)
    expect(body).not.toContain(IDENTITY_UNMINTABLE_WARN_NOTE)
  })

  it('never tells anyone to Restart, and still names the deadline', () => {
    // The whole point of the pair: no capitalised imperative, because that action cannot work…
    expect(IDENTITY_UNMINTABLE_WARN_NOTE).not.toContain('Restart')
    // …and the same date as the ordinary note, because the same cutoff ends the same window.
    expect(IDENTITY_UNMINTABLE_WARN_NOTE).toContain('2026-10-13')
    // It ran; a sentence copied from the refusal would say the opposite of what just happened.
    expect(IDENTITY_UNMINTABLE_WARN_NOTE).not.toContain('did not run')
  })
})

describe('the injected clock', () => {
  it('is what the cutoff is read against, so a suite crosses it without touching the machine', async () => {
    hookServer.setIdentityClockForTests(() => new Date(NODE_IDENTITY_STRICT_AFTER.getTime() - 1))
    expect((await control('open-terminal', 'n-edge')).status).toBe(200)
    hookServer.setIdentityClockForTests(() => new Date(NODE_IDENTITY_STRICT_AFTER.getTime()))
    expect((await control('open-terminal', 'n-edge2')).status).toBe(403)
  })
})
