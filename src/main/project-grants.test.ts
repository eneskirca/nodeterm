/**
 * The session-scoped project-grant ledger + targeting gate (issue #338 PR 1, spec P2/P3 + §3/§5).
 *
 * The properties pinned here are the security spine of project targeting:
 *  - a grant is PER-CALLER (P2): caller B presenting an id granted to caller A is refused;
 *  - a grant is SESSION-SCOPED (P3): cleared per-caller on teardown, never persisted — the module
 *    is pure in-memory state with no fs and no electron import (asserted structurally below);
 *  - the gate FAILS CLOSED: unverified, unknown target, SSH target, ungranted target all refuse
 *    with a named error;
 *  - cwd validation resolves ONCE and stats ONCE (P7, CodeQL single-fd posture).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  GRANT_CAP,
  grant,
  isGranted,
  atCap,
  clearCaller,
  clearAll,
  gateProjectTarget,
  gateOpenProject,
  recordOpenProjectGrant,
  validateOpenProjectCwd,
  PROJECT_TARGETABLE_VERBS,
  PROJECT_TARGETING_REFUSAL,
  PROJECT_TARGET_REFUSED,
  PROJECT_TARGET_SSH_UNSUPPORTED,
  OPEN_PROJECT_CWD_INVALID,
  OPEN_PROJECT_LOCAL_ONLY,
  OPEN_PROJECT_CALLER_UNRESOLVED,
  OPEN_PROJECT_GRANT_CAP
} from '../core/project-grants'

beforeEach(() => clearAll())

describe('the grant ledger is per-caller (P2)', () => {
  it('a grant authorizes the granted caller and nobody else', () => {
    expect(grant('caller-a', 'proj-1')).toBe('ok')
    expect(isGranted('caller-a', 'proj-1')).toBe(true)
    // THE pin: caller B using an id granted to caller A is refused. A globally-keyed ledger
    // passes every single-caller test and fails exactly this one.
    expect(isGranted('caller-b', 'proj-1')).toBe(false)
    expect(isGranted('caller-a', 'proj-2')).toBe(false)
  })

  it('granting the same id twice is idempotent and costs one cap slot', () => {
    expect(grant('caller-a', 'proj-1')).toBe('ok')
    expect(grant('caller-a', 'proj-1')).toBe('ok')
    for (let i = 1; i < GRANT_CAP; i++) expect(grant('caller-a', `proj-extra-${i}`)).toBe('ok')
    // proj-1 counted once, so exactly GRANT_CAP distinct ids fit.
    expect(atCap('caller-a')).toBe(true)
  })
})

describe('the grant ledger is session-scoped (P3)', () => {
  it('clearCaller revokes that caller and only that caller', () => {
    grant('caller-a', 'proj-1')
    grant('caller-b', 'proj-2')
    clearCaller('caller-a')
    expect(isGranted('caller-a', 'proj-1')).toBe(false)
    expect(isGranted('caller-b', 'proj-2')).toBe(true)
  })

  it('clearAll empties the ledger (the app-restart lifetime, exercised by beforeEach)', () => {
    grant('caller-a', 'proj-1')
    clearAll()
    expect(isGranted('caller-a', 'proj-1')).toBe(false)
  })

  it('the module is pure: no fs, no electron, no persistence path to write through', () => {
    // Structural, in the no-electron.test.ts style: the P3 claim "never persisted" is a property
    // of the SOURCE — an in-memory Map with no import that could reach a disk or the shell.
    const src = fs.readFileSync(path.join(__dirname, '../core/project-grants.ts'), 'utf8')
    expect(src).not.toMatch(/from ['"]electron(\/[^'"]*)?['"]|require\(['"]electron/)
    expect(src).not.toMatch(/from ['"](node:)?fs['"]|require\(['"](node:)?fs['"]\)/)
    expect(src).not.toMatch(/from ['"](node:)?child_process['"]/)
  })
})

describe('the per-caller cap (open-project-grant-cap)', () => {
  it('admits exactly GRANT_CAP grants and refuses the 65th', () => {
    for (let i = 0; i < GRANT_CAP; i++) {
      expect(grant('caller-a', `proj-${i}`)).toBe('ok')
      expect(atCap('caller-a')).toBe(i === GRANT_CAP - 1)
    }
    expect(grant('caller-a', 'proj-one-too-many')).toBe('cap')
    // Refused means refused: the over-cap id was NOT recorded (no silent eviction either — the
    // first 64 all survive).
    expect(isGranted('caller-a', 'proj-one-too-many')).toBe(false)
    expect(isGranted('caller-a', 'proj-0')).toBe(true)
    expect(isGranted('caller-a', `proj-${GRANT_CAP - 1}`)).toBe(true)
    // The cap is per caller, not global.
    expect(atCap('caller-b')).toBe(false)
    expect(grant('caller-b', 'proj-0')).toBe('ok')
  })
})

describe('gateProjectTarget (spec §3/§5) — every branch, fail closed', () => {
  const base = {
    verified: true,
    verb: 'open-claude',
    targetProjectId: 'proj-t' as string | undefined,
    callerProjectId: 'proj-own' as string | undefined,
    targetIsSsh: false as boolean | undefined,
    granted: false
  }

  it('is a no-op for a verb that is not a project-targetable open', () => {
    expect(PROJECT_TARGETABLE_VERBS.has('open-claude')).toBe(true)
    expect(PROJECT_TARGETABLE_VERBS.has('open-terminal')).toBe(true)
    expect(PROJECT_TARGETABLE_VERBS.has('open-agent')).toBe(true)
    // #925: `run` reaches a node in another project only through this gate. Dropping it from the
    // set would make `gateProjectTarget` answer 'allow' for any --project, ungating the verb.
    expect(PROJECT_TARGETABLE_VERBS.has('run')).toBe(true)
    expect(PROJECT_TARGETABLE_VERBS.has('show-image')).toBe(false)
    expect(gateProjectTarget({ ...base, verb: 'list' })).toBe('allow')
  })

  it('refuses `run --project <foreign, ungranted>` like any stranger id (#925)', () => {
    expect(gateProjectTarget({ ...base, verb: 'run', targetProjectId: 'proj-foreign' })).toEqual({
      refuse: PROJECT_TARGET_REFUSED
    })
  })

  it('is a no-op when no --project is present', () => {
    expect(gateProjectTarget({ ...base, targetProjectId: undefined })).toBe('allow')
  })

  it('refuses an unverified caller with the flat sentence, before anything else', () => {
    // Even the caller's OWN project: --project requires verified === true (P1's arg half), and
    // the sentence carries no token/restart advice (a designed refusal, not an outage).
    const r = gateProjectTarget({ ...base, verified: false, targetProjectId: 'proj-own' })
    expect(r).toEqual({ refuse: PROJECT_TARGETING_REFUSAL })
    for (const hint of ['token', 'restart', 'identity']) {
      expect(PROJECT_TARGETING_REFUSAL.toLowerCase()).not.toContain(hint)
    }
  })

  it('refuses an unknown/deleted target id — fail closed, same sentence as ungranted', () => {
    // targetIsSsh === undefined is "main's own store does not know this project". The refusal
    // reuses PROJECT_TARGET_REFUSED so a probing caller cannot distinguish "does not exist"
    // from "exists but not granted" (no project-existence oracle).
    const r = gateProjectTarget({ ...base, targetIsSsh: undefined, granted: true })
    expect(r).toEqual({ refuse: PROJECT_TARGET_REFUSED })
  })

  it('allows the caller its own project, SSH-own included (the legacy live path)', () => {
    expect(gateProjectTarget({ ...base, targetProjectId: 'proj-own' })).toBe('allow')
    expect(
      gateProjectTarget({ ...base, targetProjectId: 'proj-own', targetIsSsh: true })
    ).toBe('allow')
  })

  it('allows OWN even when the meta lookup misses — own-before-unknown (review M2)', () => {
    // callerProjectId and the target meta derive from the same index scan, but if a rename
    // mid-debounce ever staggered the two read paths, a legitimate `--project <own-id>` must not
    // be spuriously refused as unknown. Still fail-closed: the id IS the caller's own project by
    // main's own caller resolution.
    expect(
      gateProjectTarget({ ...base, targetProjectId: 'proj-own', targetIsSsh: undefined })
    ).toBe('allow')
  })

  it('refuses every stranger id with byte-identical text — no existence OR kind oracle (review I3)', () => {
    // unknown, real-local-ungranted and real-SSH-ungranted must be indistinguishable to a caller
    // with no relationship to the id. Byte-for-byte, not toEqual: the property is that the WIRE
    // BYTES leak nothing.
    const refuseOf = (r: ReturnType<typeof gateProjectTarget>): string =>
      r === 'allow' ? '' : r.refuse
    const unknown = refuseOf(gateProjectTarget({ ...base, targetIsSsh: undefined }))
    const localUngranted = refuseOf(gateProjectTarget({ ...base, targetIsSsh: false }))
    const sshUngranted = refuseOf(gateProjectTarget({ ...base, targetIsSsh: true }))
    expect(unknown).toBe(PROJECT_TARGET_REFUSED)
    expect(Buffer.from(localUngranted).equals(Buffer.from(unknown))).toBe(true)
    expect(Buffer.from(sshUngranted).equals(Buffer.from(unknown))).toBe(true)
  })

  it('the SSH belt refuses a granted SSH id — and only a grant holder ever sees that wording', () => {
    // Grants are only ever minted by local open-project, so a granted SSH id cannot exist; if
    // that invariant ever breaks, the target is refused, not opened. The kind-naming wording is
    // harmless here — a grant holder was handed the id by open-project — and is reachable ONLY
    // through the granted branch (the stranger case above gets PROJECT_TARGET_REFUSED).
    const r = gateProjectTarget({ ...base, targetIsSsh: true, granted: true })
    expect(r).toEqual({ refuse: PROJECT_TARGET_SSH_UNSUPPORTED })
    // A granted id whose project has since vanished still fails closed as a stranger.
    expect(gateProjectTarget({ ...base, targetIsSsh: undefined, granted: true })).toEqual({
      refuse: PROJECT_TARGET_REFUSED
    })
  })

  it('allows a granted target and refuses an ungranted one with the named sentence', () => {
    expect(gateProjectTarget({ ...base, granted: true })).toBe('allow')
    expect(gateProjectTarget({ ...base, granted: false })).toEqual({
      refuse: PROJECT_TARGET_REFUSED
    })
    expect(PROJECT_TARGET_REFUSED).toBe(
      'project-target-refused: you may only target your own project or a project id ' +
        'open-project returned to you in this session'
    )
  })

  it('composes with the real ledger: granted for A, still refused for B (P2 end-to-end)', () => {
    grant('caller-a', 'proj-t')
    const forCaller = (caller: string) =>
      gateProjectTarget({ ...base, granted: isGranted(caller, 'proj-t') })
    expect(forCaller('caller-a')).toBe('allow')
    expect(forCaller('caller-b')).toEqual({ refuse: PROJECT_TARGET_REFUSED })
  })
})

describe('validateOpenProjectCwd (P7) — resolved once, statted once, fails closed', () => {
  const dirStat = { isDirectory: () => true }
  const fileStat = { isDirectory: () => false }

  it('refuses a relative path before touching the filesystem at all', () => {
    let stats = 0
    const r = validateOpenProjectCwd('repo/sub', () => ((stats++, dirStat)))
    expect(r).toEqual({ error: OPEN_PROJECT_CWD_INVALID })
    expect(stats).toBe(0)
    expect(validateOpenProjectCwd('', () => dirStat)).toEqual({ error: OPEN_PROJECT_CWD_INVALID })
    expect(validateOpenProjectCwd('./x', () => dirStat)).toEqual({
      error: OPEN_PROJECT_CWD_INVALID
    })
  })

  it('resolves traversal and stats the RESOLVED path, exactly once', () => {
    const statted: string[] = []
    const r = validateOpenProjectCwd('/tmp/a/../b/./c/', (p) => {
      statted.push(p)
      return dirStat
    })
    // The resolved form — never the raw argument — is what every later step (dedupe, the PR 2
    // dialog, storage) sees.
    expect(r).toEqual({ resolved: path.resolve('/tmp/a/../b/./c/') })
    expect(statted).toEqual([path.resolve('/tmp/a/../b/./c/')])
  })

  it('refuses a nonexistent path (stat throws) and a non-directory, with the named error', () => {
    expect(
      validateOpenProjectCwd('/no/such/dir', () => {
        throw new Error('ENOENT')
      })
    ).toEqual({ error: OPEN_PROJECT_CWD_INVALID })
    expect(validateOpenProjectCwd('/tmp/some.file', () => fileStat)).toEqual({
      error: OPEN_PROJECT_CWD_INVALID
    })
  })
})

describe('gateOpenProject — every pre-forward branch, behaviorally red-capable (review I1/I2)', () => {
  const dirStat = { isDirectory: () => true }
  const base = {
    callerProjectId: 'proj-own' as string | undefined,
    callerIsSsh: false as boolean | undefined,
    atCap: false,
    rawCwd: '/tmp/repo',
    statFn: () => dirStat
  }

  it('refuses an unresolvable caller with the transient named error, before anything else', () => {
    // A node inside the save debounce is not in any persisted project yet: fail closed (GC 10),
    // worded transient because it genuinely is. No stat runs — the request goes nowhere.
    let stats = 0
    const r = gateOpenProject({
      ...base,
      callerProjectId: undefined,
      // Even a hostile combination (SSH + cap) must not change which refusal fires first.
      callerIsSsh: true,
      atCap: true,
      statFn: () => ((stats++, dirStat))
    })
    expect(r).toEqual({ refuse: OPEN_PROJECT_CALLER_UNRESOLVED })
    expect(stats).toBe(0)
  })

  it('refuses an SSH-project caller with open-project-local-only (B5)', () => {
    expect(gateOpenProject({ ...base, callerIsSsh: true })).toEqual({
      refuse: OPEN_PROJECT_LOCAL_ONLY
    })
  })

  it('refuses at the grant cap BEFORE the cwd is ever touched (no consent could follow)', () => {
    let stats = 0
    const r = gateOpenProject({ ...base, atCap: true, statFn: () => ((stats++, dirStat)) })
    expect(r).toEqual({ refuse: OPEN_PROJECT_GRANT_CAP })
    expect(stats).toBe(0)
  })

  it('composes with the real ledger cap and the real cwd rules', () => {
    for (let i = 0; i < GRANT_CAP; i++) grant('caller-a', `proj-${i}`)
    expect(gateOpenProject({ ...base, atCap: atCap('caller-a') })).toEqual({
      refuse: OPEN_PROJECT_GRANT_CAP
    })
    expect(gateOpenProject({ ...base, atCap: atCap('caller-b'), rawCwd: 'not/absolute' })).toEqual(
      { refuse: OPEN_PROJECT_CWD_INVALID }
    )
  })

  it('passes a clean request through with the RESOLVED cwd (P7)', () => {
    const statted: string[] = []
    const r = gateOpenProject({
      ...base,
      rawCwd: '/tmp/a/../repo/',
      statFn: (p) => ((statted.push(p), dirStat))
    })
    expect(r).toEqual({ resolvedCwd: path.resolve('/tmp/a/../repo/') })
    expect(statted).toEqual([path.resolve('/tmp/a/../repo/')])
  })
})

describe('recordOpenProjectGrant — the record decision, behaviorally (P2 record-side + review M1)', () => {
  const okReply = { ok: true, result: { projectId: 'proj-new' } }

  it('records ONLY under verified && ok && non-empty string projectId — the open-browser pattern', () => {
    // The four fail-closed legs first: none of these may mint anything.
    expect(recordOpenProjectGrant('caller-a', okReply, false)).toBe('not-applicable')
    expect(recordOpenProjectGrant('caller-a', { ok: false, result: { projectId: 'proj-new' } }, true)).toBe('not-applicable')
    expect(recordOpenProjectGrant('caller-a', { ok: true, result: {} }, true)).toBe('not-applicable')
    expect(recordOpenProjectGrant('caller-a', { ok: true, result: { projectId: '' } }, true)).toBe('not-applicable')
    expect(recordOpenProjectGrant('caller-a', { ok: true, result: { projectId: 42 } }, true)).toBe('not-applicable')
    expect(isGranted('caller-a', 'proj-new')).toBe(false)
    // The one leg that mints — and only for THIS caller.
    expect(recordOpenProjectGrant('caller-a', okReply, true)).toBe('recorded')
    expect(isGranted('caller-a', 'proj-new')).toBe(true)
    expect(isGranted('caller-b', 'proj-new')).toBe(false)
  })

  it("answers 'cap' when a concurrent open-project filled the last slot — nothing recorded", () => {
    // The M1 race: both requests passed the pre-forward atCap() check; the loser's grant() call
    // is the first place the collision is visible, and the wrapper turns 'cap' into the named
    // refusal instead of relaying ok (a caller must never hear ok while holding no right).
    for (let i = 0; i < GRANT_CAP; i++) grant('caller-a', `proj-${i}`)
    expect(recordOpenProjectGrant('caller-a', okReply, true)).toBe('cap')
    expect(isGranted('caller-a', 'proj-new')).toBe(false)
    // An id already granted re-records fine at the cap (idempotent, no new slot).
    expect(
      recordOpenProjectGrant('caller-a', { ok: true, result: { projectId: 'proj-0' } }, true)
    ).toBe('recorded')
  })
})

describe('main wiring (structural) — the wrapper records, consumes and clears correctly', () => {
  // Structural in the control-destructive.test.ts sense and for the same reason: the wiring lives
  // inside index.ts's setControlHandler wrapper and whenReady closure, which have no unit seam,
  // and the property pinned — WHEN a grant is recorded and WHEN it dies — is a property of the
  // source. The behavioural halves (the ledger, the gate, the cwd rules) are proven above against
  // the real functions.
  const src = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')

  it('the record path is the pure recordOpenProjectGrant, called once, with the cap race surfaced', () => {
    // The record RULES (verified && ok && string projectId; per-caller; 'cap' on the race) are
    // proven behaviorally above against the real function. Here: the wrapper routes the reply
    // through that function exactly once, with main's own verdict, and a 'cap' answer replaces
    // the success reply with the named refusal (review M1 — no ok without a recorded right).
    expect(src.match(/recordOpenProjectGrant\(/g)?.length).toBe(1)
    // It sits in `finishAnswer`, the step main runs on every renderer answer — on time or late
    // (src/main/control-forward.ts) — so the reply it guards is `answer`, not the awaited result.
    expect(src).toMatch(
      /if \(recordOpenProjectGrant\(nodeId, answer, verified\) === 'cap'\) \{/
    )
    const at = src.indexOf("recordOpenProjectGrant(nodeId, answer, verified) === 'cap'")
    const block = src.slice(at, src.indexOf('return answer', at))
    expect(block).toContain('error: OPEN_PROJECT_GRANT_CAP')
    // No raw grant() call sneaks around the pure decision anywhere in main's entry.
    expect(src).not.toMatch(/\bgrantProjectTo\(|[^A-Za-z]grant\(nodeId/)
  })

  it('every open-project is routed through the pure gateOpenProject before forwarding (I1/I2)', () => {
    // The branches themselves (caller-unresolved, SSH caller, cap, cwd) are proven behaviorally
    // above; this pins that the wrapper cannot bypass them — the gate call sits inside the
    // open-project arm, its refusal returns unforwarded, and its resolved cwd is what forwards.
    const arm = src.indexOf("if (verb === 'open-project') {")
    expect(arm).toBeGreaterThan(-1)
    const block = src.slice(arm, src.indexOf('} else if (PROJECT_TARGETABLE_VERBS', arm))
    expect(block).toContain('gateOpenProject({')
    expect(block).toContain("if ('refuse' in gate) return refuse(gate.refuse)")
    expect(block).toContain('args = { ...args, cwd: gate.resolvedCwd }')
    // Its inputs come from main's own stores, never the request.
    expect(block).toMatch(/callerProjectId: projectIdOfNode\(nodeId\)|callerProjectId,/)
    expect(block).toContain('workspaceStore.projectMetaFor(callerProjectId)?.ssh')
    expect(block).toContain('atCap: projectGrantsAtCap(nodeId)')
  })

  it('consumes the ledger per-CALLER and gates before forwarding to the renderer', () => {
    // The gate reads isGranted(nodeId, …) — the verified caller of THIS request — never a global
    // or target-derived key, and it runs inside the wrapper before webContents.send.
    expect(src).toMatch(/granted: projectGrantedTo\(nodeId, args\.project\)/)
    const gateAt = src.indexOf('gateProjectTarget({')
    const forwardAt = src.indexOf('target.webContents.send(IPC.agentControl', gateAt)
    expect(gateAt).toBeGreaterThan(-1)
    expect(forwardAt).toBeGreaterThan(gateAt)
    // The target's SSH/existence meta comes from main's own store, never the request.
    expect(src).toMatch(/workspaceStore\.projectMetaFor\(args\.project\)/)
  })

  it('clears a caller on BOTH pty teardown paths (destroy + recycle) — spec P3', () => {
    expect(src).toMatch(
      /corePlatform\.on\(IPC\.ptyDestroy, \(nodeId: string\) => clearProjectGrants\(nodeId\)\)/
    )
    expect(src).toMatch(
      /corePlatform\.on\(IPC\.ptyRecycle, \(nodeId: string\) => clearProjectGrants\(nodeId\)\)/
    )
  })

  it('open-project resolves + replaces the cwd in MAIN before forwarding (P7)', () => {
    // The resolution itself lives in gateOpenProject → validateOpenProjectCwd (proven above);
    // here: the raw caller cwd enters the gate and only the gate's resolved form is forwarded.
    const at = src.indexOf('rawCwd: args.cwd')
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at, at + 400)).toContain('args = { ...args, cwd: gate.resolvedCwd }')
  })
})
