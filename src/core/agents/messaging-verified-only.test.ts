/**
 * The messaging verbs admit ONLY a `verified` caller — proven on the wire, against the real
 * hook server, on both sides of every escape hatch.
 *
 * The load-bearing claim: `settings.hookIdentityStrict: false` releases the latch and the dated
 * cutoff (node-identity-policy.ts, the `override === false` branch), and the foreign-kid escape
 * walks past both (an invented kid is FOREIGN, therefore `legacy`, therefore inside the branch the
 * hatch releases). Neither may release `send`/`reply`. That is why `requiresVerified` is a separate
 * check in hook-server.ts and NOT a controlPolicy row — and why this suite drives the HTTP route
 * rather than the policy table: a policy-table test cannot see the route consulting the policy
 * first.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { hookServer, MESSAGING_CONTROL_REFUSAL, requiresVerified, verifiedRefusalFor } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import { TOLERANT_CONTROL_VERBS } from './node-identity-policy'
import { DESTRUCTIVE_VERBS } from '../../shared/control-verbs'

const SECRET = Buffer.alloc(32, 5)
/** Another instance's secret: a token minted with it is a FOREIGN kid — the invented-kid escape. */
const FOREIGN_SECRET = Buffer.alloc(32, 9)
let dir = ''
let handled: string[] = []

function post(verb: string, nodeId: string, token?: string, accept = 'application/json') {
  const headers: Record<string, string> = {
    'X-Nodeterm-Hook-Token': hookServer.getToken(),
    'content-type': 'application/x-www-form-urlencoded',
    accept
  }
  if (token) headers['X-Nodeterm-Node-Token'] = token
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/control/${verb}`, {
    method: 'POST',
    headers,
    body: `nodeId=${encodeURIComponent(nodeId)}&arg.node=n-target&arg.text=hi`
  })
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-msg-verified-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  // Records what REACHED the handler: the promise of a refusal is that nothing happened, so the
  // suite asserts absence here rather than inferring it from a status code.
  hookServer.setControlHandler(async ({ verb }) => {
    handled.push(verb)
    return { ok: true, message: 'handled' }
  })
})

afterAll(() => {
  hookServer.setIdentityStrictOverride(() => undefined)
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  handled = []
})

describe('send/reply require `verified` — and controlPolicy is NOT the decider', () => {
  it('refuses legacy and foreign-kid callers under every hookIdentityStrict value', async () => {
    // A separate check runs FIRST and is not overridable. settings.hookIdentityStrict: false
    // releases the latch and the cutoff (the `override === false` branch of controlPolicy); it
    // must NOT release these routes.
    for (const strict of [true, false, undefined]) {
      hookServer.setIdentityStrictOverride(() => strict)
      for (const verb of requiresVerified) {
        const legacy = await post(verb, 'n-src')
        expect(legacy.status, `${verb} legacy strict=${String(strict)}`).toBe(403)
        // The refusal is worded for the refused verb ("agent messaging refused" answering a note
        // write would be a diagnosis-delaying lie) but keeps the same one-sentence posture.
        expect(((await legacy.json()) as { error: string }).error).toBe(verifiedRefusalFor(verb))

        // The invented-kid escape: a token minted under ANOTHER secret is a foreign kid, which
        // invariant 3 requires to be `legacy` — it walks past the latch and the window. Not here.
        const foreign = await post(verb, 'n-src', nodeAuthToken(FOREIGN_SECRET, 'n-src'))
        expect(foreign.status, `${verb} foreign-kid strict=${String(strict)}`).toBe(403)

        const own = await post(verb, 'n-src', nodeAuthToken(SECRET, 'n-src'))
        expect(own.status, `${verb} verified strict=${String(strict)}`).not.toBe(403)
      }
    }
    // Only the verified calls reached the handler — one per verb per strict value.
    expect(handled).toEqual([true, false, undefined].flatMap(() => [...requiresVerified]))
  })

  it('tells a text/plain caller the same refusal, without token or restart advice', async () => {
    hookServer.setIdentityStrictOverride(() => undefined)
    const res = await post('send', 'n-src', undefined, 'text/plain')
    expect(res.status).toBe(403)
    const text = (await res.text()).trim()
    expect(text).toBe(MESSAGING_CONTROL_REFUSAL)
    // No diagnosis and no hint: advice here is advice to an attacker and a lie to nobody else.
    for (const hint of ['token', 'Restart', 'restart', 'identity']) {
      expect(text).not.toContain(hint)
    }
    expect(handled).toEqual([])
  })

  it('a caller with NO minted secret at all (identity unavailable) is still refused', async () => {
    // identityGate short-circuits to `legacy`/`allow` with no secret. The verbs are fail-closed
    // from day one — there is no upgrade population to protect.
    hookServer.clearNodeAuthSecretForTests()
    try {
      for (const verb of ['send', 'reply', 'open-project'] as const) {
        const res = await post(verb, 'n-src')
        expect(res.status, verb).toBe(403)
      }
      expect(handled).toEqual([])
    } finally {
      hookServer.setNodeAuthSecret(SECRET)
    }
  })
})

describe('where the verbs sit in the routing tables', () => {
  // `needsLiveCanvas('send'/'reply') === false` is pinned where the function lives —
  // `src/renderer/lib/controlRouting.test.ts` — because this core project cannot import the
  // renderer without breaking tsconfig.node's file list.

  it('send/reply are in neither DESTRUCTIVE_VERBS nor TOLERANT_CONTROL_VERBS', () => {
    for (const verb of ['send', 'reply']) {
      // Not confirm-gated (the per-project switch + verified-only + flow control are the gates),
      // and not tolerated for an unproven legacy caller (the opposite: verified-only).
      expect(DESTRUCTIVE_VERBS.has(verb as never), verb).toBe(false)
      expect(TOLERANT_CONTROL_VERBS.has(verb), verb).toBe(false)
    }
  })

  it('the verified-only set is exactly the messaging verbs plus sticky, open-project, settings and report-issue', () => {
    // Pins that nothing ELSE ever drifts in: adding a SHIPPED verb here would strand its legacy
    // population with no hatch, which is the one thing this set must never be casually grown by.
    // `notify` (folded in from #98, Task 5.2) is a messaging verb like the other two — it writes
    // into another agent's pane — so it takes the same gate. `sticky` (issue #144) is here
    // because its "↻ <agent> · when" stamp replaces the confirm dialog, and a byline any
    // bearer-holder could forge would be worse than no byline; it shipped verified-only from
    // day one, so no legacy population is stranded. `open-project` (issue #338) is here because
    // the grant ledger binds targeting rights to the verified caller identity — a grant minted
    // for a forgeable caller would authorize whoever forged it; new verb, so fail-closed from
    // day one strands nobody. `settings` (@shared/settings-verb) is here because its `--set` dialog
    // names the requesting node and the user's click grants what that node asked for; also new.
    // `report-issue` (@core/github/report-issue-service) is here because it PUBLISHES text from
    // this machine to a repository, with no dialog anywhere on the path — `legacy` means "we
    // cannot judge this caller", and an unjudgeable caller must never be the one that publishes.
    // New verb, so fail-closed from day one strands no legacy population either.
    expect([...requiresVerified].sort()).toEqual([
      'notify',
      'open-project',
      'reply',
      'report-issue',
      'send',
      'settings',
      'sticky'
    ])
  })

  it('the report-issue refusal is its own flat sentence, not the messaging one', () => {
    expect(verifiedRefusalFor('report-issue')).toBe('Issue reporting refused.')
    expect(verifiedRefusalFor('report-issue')).not.toBe(MESSAGING_CONTROL_REFUSAL)
  })

  it('the settings refusal is its own flat sentence', () => {
    expect(verifiedRefusalFor('settings')).toBe('Settings access refused.')
    expect(verifiedRefusalFor('settings')).not.toBe(MESSAGING_CONTROL_REFUSAL)
  })

  it('the open-project refusal is its own flat sentence, not the messaging one', () => {
    // "Agent messaging refused." answering a project open would be a diagnosis-delaying lie —
    // the same argument that gave sticky its own sentence. Same posture: one sentence, no
    // token/restart advice.
    expect(verifiedRefusalFor('open-project')).toBe('Project open refused.')
    expect(verifiedRefusalFor('open-project')).not.toBe(MESSAGING_CONTROL_REFUSAL)
  })
})
