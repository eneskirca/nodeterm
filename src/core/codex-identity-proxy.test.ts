import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  accountScope,
  bindCodexThreadIdentity,
  codexLauncherDir,
  codexLauncherPathDir,
  codexThreadIdentityHasLiveConflict,
  forgetCodexThreadIdentitiesForNode,
  codexThreadIdentityRoot,
  identityCandidates,
  installCodexLauncher,
  isSafeThreadId,
  readCodexThreadIdentity,
  readIdentityCandidate,
  resetCodexThreadIdentityAuthSecret,
  resolveCodexThreadNodeIdentity,
  setCodexThreadIdentityAuthSecret,
  SYSTEM_ACCOUNT_SCOPE,
  writeCodexThreadIdentity
} from './codex-identity-proxy'
import { createHmac } from 'node:crypto'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

let dir = ''
/**
 * The record store this file operates on, named EXPLICITLY rather than resolved through
 * `platform()`. Every function under test takes the root as a parameter, and passing it has two
 * benefits: each test says which store it is touching, and no file here is created at a path
 * derived from `fakePlatform`'s hardcoded `/tmp/nodeterm-test` default — a predictable temp path,
 * which is symlink-attackable on a shared machine and which CodeQL's `js/insecure-temporary-file`
 * correctly flags. The mkdtemp directory below is the only source of paths in this file.
 */
let recordsRoot = ''
const live = (ids: string[]) => (id: string) => ids.includes(id)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-identity-'))
  recordsRoot = path.join(dir, 'codex-thread-nodes')
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  setCodexThreadIdentityAuthSecret(randomBytes(32))
})

afterEach(() => {
  resetCodexThreadIdentityAuthSecret()
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

// A thread id is a PATH SEGMENT under `codexThreadIdentityRoot()` and a field inside the record
// signature. The charset alone never made it safe: `.` and `..` both match `[A-Za-z0-9._-]+`, and
// `..` as a path segment resolves to the record dir's PARENT. This is the same hole `isSafeNodeId`
// closed for node ids; these rows are the trap.
const UNSAFE_THREAD_IDS = ['.', '..', '../x', 'a/b', '', 'x'.repeat(129)]

describe('isSafeThreadId', () => {
  it('refuses every id that could leave the record directory, be empty, or be unbounded', () => {
    for (const id of UNSAFE_THREAD_IDS) expect(isSafeThreadId(id), JSON.stringify(id)).toBe(false)
  })

  it('accepts the ids the app-server actually mints', () => {
    for (const id of ['thread-1', '0199b4b7-8d4e-7a4e-9a2f-3c9d0f1a2b3c', 'x'.repeat(128)]) {
      expect(isSafeThreadId(id), id).toBe(true)
    }
  })
})

describe('path-unsafe thread ids never reach a path or a hash', () => {
  it('refuses to write a record under one, and creates nothing', () => {
    for (const id of UNSAFE_THREAD_IDS) {
      expect(() =>
        writeCodexThreadIdentity(id, 'node-1', '/data/e', recordsRoot)
      ).toThrow()
    }
    // Not one stray file, and — the row that matters — no record dropped in the PARENT of the
    // store by a `..` segment.
    expect(fs.existsSync(recordsRoot)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('refuses to bind one, and creates nothing', () => {
    for (const id of UNSAFE_THREAD_IDS) {
      expect(() =>
        bindCodexThreadIdentity(id, 'node-1', '/data/e', live([]), recordsRoot)
      ).toThrow()
    }
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('reads nothing back for one', () => {
    for (const id of UNSAFE_THREAD_IDS) {
      expect(readCodexThreadIdentity(id, recordsRoot), JSON.stringify(id)).toBeUndefined()
      expect(resolveCodexThreadNodeIdentity(id, recordsRoot), JSON.stringify(id)).toBeUndefined()
    }
  })
})

describe('codex thread identity store', () => {
  it('lives under the platform data dir, not $HOME', () => {
    // The wrong seam is why the Server Edition had no story at all: `homedir()` is not where a
    // server keeps its state, and nothing behind CorePlatform can be swapped for it.
    expect(codexThreadIdentityRoot()).toBe(path.join(dir, 'codex-thread-nodes'))
    expect(codexLauncherDir()).toBe(path.join(dir, 'codex-bin'))
  })

  it('puts the launcher dir on a session PATH everywhere but Windows (gated off there, phase 1)', () => {
    expect(codexLauncherPathDir('darwin')).toBe(path.join(dir, 'codex-bin'))
    expect(codexLauncherPathDir('linux')).toBe(path.join(dir, 'codex-bin'))
    expect(codexLauncherPathDir('win32')).toBeNull()
  })

  it('pty-manager gates BOTH launcher sites (the per-create rewrite and the PATH prepend) on it', () => {
    // Source-level pin: a create() is too heavy to drive here, and the docs promise "no launcher
    // write" on Windows — the per-spawn installCodexLauncher() call used to skip the gate.
    const src = fs.readFileSync(path.join(__dirname, 'pty-manager.ts'), 'utf8')
    const calls = [...src.matchAll(/installCodexLauncher\(\)/g)]
    expect(calls.length).toBe(1)
    const before = src.slice(Math.max(0, calls[0].index! - 400), calls[0].index!)
    expect(before).toContain('codexLauncherPathDir() !== null')
    expect(src).toMatch(/\?\s*codexLauncherPathDir\(\)\s*:\s*null/)
  })

  it('round-trips a record and resolves its owning node', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/hook-endpoint.env', recordsRoot)
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot)).toBe('node-1')
  })

  it('ignores a record whose node id was rewritten (the signature no longer matches)', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/hook-endpoint.env', recordsRoot)
    const file = path.join(recordsRoot, 'thread-1')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('node-1', 'node-evil'))
    // Not repaired, not trusted: the prelude re-exports both fields into an agent's environment,
    // so an attacker-writable record is an attacker-chosen hook target.
    expect(readCodexThreadIdentity('thread-1', recordsRoot)).toBeUndefined()
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot)).toBeUndefined()
  })

  it('ignores an unsigned record', () => {
    fs.mkdirSync(recordsRoot, { recursive: true })
    fs.writeFileSync(
      path.join(recordsRoot, 'thread-1'),
      'nodeId=node-1\nendpoint=/data/hook-endpoint.env\n'
    )
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot)).toBeUndefined()
  })

  it('refuses ids and endpoints that are not shaped like ids and endpoints', () => {
    expect(() => writeCodexThreadIdentity('../escape', 'node-1', '/data/e', recordsRoot)).toThrow()
    expect(() => writeCodexThreadIdentity('thread-1', 'node 1; rm -rf /', '/data/e', recordsRoot)).toThrow()
    expect(() => writeCodexThreadIdentity('thread-1', 'node-1', 'relative/e', recordsRoot)).toThrow()
  })

  it('writes nothing at all without the auth secret', () => {
    resetCodexThreadIdentityAuthSecret()
    expect(() => writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot)).toThrow()
    expect(fs.existsSync(path.join(recordsRoot, 'thread-1'))).toBe(false)
  })
})

describe('binding a thread to a node', () => {
  it('refuses to take a thread away from a node that is still live', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot)
    expect(() =>
      bindCodexThreadIdentity('thread-1', 'node-2', '/data/e', live(['node-1']), recordsRoot)
    ).toThrow()
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot)).toBe('node-1')
  })

  it('re-claims a thread whose owner is gone', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot)
    bindCodexThreadIdentity('thread-1', 'node-2', '/data/e', live([]), recordsRoot)
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot)).toBe('node-2')
  })

  it('is idempotent for the node that already owns it (a restart re-binds its own thread)', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot)
    bindCodexThreadIdentity('thread-1', 'node-1', '/data/e', live(['node-1']), recordsRoot)
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot)).toBe('node-1')
  })
})

describe('installCodexLauncher', () => {
  it('writes an executable launcher and answers with its path', () => {
    const file = installCodexLauncher()
    expect(file).toBe(path.join(codexLauncherDir(), 'nodeterm-codex'))
    expect(fs.statSync(file as string).mode & 0o777).toBe(0o700)
  })

  it('answers null instead of throwing when it cannot be written', () => {
    // A read-only data dir is a real failure mode, and null is what makes the caps probe say "no
    // shared identity" — which keeps every launch line on the bare `codex` instead of naming a
    // launcher that is not there.
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: path.join(dir, 'file-not-a-dir') }))
    fs.writeFileSync(path.join(dir, 'file-not-a-dir'), 'x')
    expect(installCodexLauncher()).toBeNull()
  })
})

describe('forgetting a permanently deleted node', () => {
  it('removes every record naming it, and leaves the others alone', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot)
    writeCodexThreadIdentity('thread-2', 'node-1', '/data/e', recordsRoot)
    writeCodexThreadIdentity('thread-3', 'node-2', '/data/e', recordsRoot)
    forgetCodexThreadIdentitiesForNode('node-1', recordsRoot)
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot)).toBeUndefined()
    expect(resolveCodexThreadNodeIdentity('thread-2', recordsRoot)).toBeUndefined()
    // Without this the directory grows a file per thread forever, AND a dead node's record keeps
    // re-exporting its node id into any tool shell still carrying that thread id.
    expect(resolveCodexThreadNodeIdentity('thread-3', recordsRoot)).toBe('node-2')
  })

  it('never deletes a record it does not trust, and never throws', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot)
    const file = path.join(recordsRoot, 'thread-1')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('node-1', 'node-2'))
    forgetCodexThreadIdentitiesForNode('node-2', recordsRoot)
    expect(fs.existsSync(file)).toBe(true)
    // A node deletion must never fail on this: no directory at all is simply nothing to forget.
    fs.rmSync(recordsRoot, { recursive: true, force: true })
    expect(() => forgetCodexThreadIdentitiesForNode('node-1', recordsRoot)).not.toThrow()
  })

  it('forgets a node across managed account scopes, not just the bare system root', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot) // system
    writeCodexThreadIdentity('thread-2', 'node-1', '/data/e', recordsRoot, 'acct-A')
    writeCodexThreadIdentity('thread-3', 'node-2', '/data/e', recordsRoot, 'acct-A')
    forgetCodexThreadIdentitiesForNode('node-1', recordsRoot)
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot)).toBeUndefined()
    expect(readCodexThreadIdentity('thread-2', recordsRoot, 'acct-A')).toBeUndefined()
    // Another node's managed record in the same scope is left alone.
    expect(readCodexThreadIdentity('thread-3', recordsRoot, 'acct-A')?.nodeId).toBe('node-2')
  })
})

// ── S6 PR 2: the account-scoped ownership spine (Properties 3, 7, 8) ──────────────────────────
//
// A FIXED secret is used here rather than the per-test random one, so the tests can forge both a
// legacy 3-tuple record (Constraint 12 back-compat) and a hand-signed managed record.
const FIXED_SECRET = Buffer.alloc(32, 7)
const b64url = (b: Buffer): string => b.toString('base64url')
const sign4 = (threadId: string, scope: string, nodeId: string, endpoint: string): string =>
  b64url(createHmac('sha256', FIXED_SECRET).update(`${threadId}\0${scope}\0${nodeId}\0${endpoint}`).digest())
const sign3 = (threadId: string, nodeId: string, endpoint: string): string =>
  b64url(createHmac('sha256', FIXED_SECRET).update(`${threadId}\0${nodeId}\0${endpoint}`).digest())

describe('account-scoped ownership', () => {
  beforeEach(() => setCodexThreadIdentityAuthSecret(FIXED_SECRET))

  it('accountScope normalises the system account and refuses an id that escapes the directory', () => {
    // Property 8: the account id is a directory scope, so `..`/`a/b`/absolute/`system` are refused.
    expect(accountScope(undefined)).toBe(SYSTEM_ACCOUNT_SCOPE)
    expect(accountScope('')).toBe(SYSTEM_ACCOUNT_SCOPE)
    expect(accountScope('acct-A')).toBe('acct-A')
    for (const bad of ['..', '../x', 'a/b', '/abs', '.', 'system', ' sp']) {
      expect(() => accountScope(bad), bad).toThrow()
    }
  })

  it('refuses to write a record under an account scope that could escape the mapping directory', () => {
    // Property 8: `..` as a scope resolves to the record dir's PARENT. Refused, and nothing written.
    expect(() => writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot, '..')).toThrow()
    expect(() => writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot, 'a/b')).toThrow()
    expect(fs.existsSync(recordsRoot)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('round-trips a managed record under its scope directory, isolated from the system record', () => {
    writeCodexThreadIdentity('thread-1', 'node-sys', '/data/e', recordsRoot) // system, bare root
    writeCodexThreadIdentity('thread-1', 'node-mgd', '/data/e', recordsRoot, 'acct-A')
    expect(fs.existsSync(path.join(recordsRoot, 'thread-1'))).toBe(true)
    expect(fs.existsSync(path.join(recordsRoot, 'acct-A', 'thread-1'))).toBe(true)
    expect(readCodexThreadIdentity('thread-1', recordsRoot)?.nodeId).toBe('node-sys')
    expect(readCodexThreadIdentity('thread-1', recordsRoot, 'acct-A')?.nodeId).toBe('node-mgd')
  })

  it('fails closed for the same thread id owned by different accounts (Property 3)', () => {
    // Two accounts each own thread-1, naming DIFFERENT nodes. An unscoped resolve (the shared tool
    // shell that only knows the bare thread id) must return NOTHING — ambiguity is refusal.
    writeCodexThreadIdentity('thread-1', 'node-A', '/data/e', recordsRoot, 'acct-A')
    writeCodexThreadIdentity('thread-1', 'node-B', '/data/e', recordsRoot, 'acct-B')
    expect(identityCandidates('thread-1', recordsRoot)).toHaveLength(2)
    // MUTATION TARGET: return the first owner instead of requiring owners.size === 1 ⇒ this reddens.
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot)).toBeUndefined()
    // But a resolve SCOPED to one account still answers unambiguously.
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot, 'acct-A')).toBe('node-A')
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot, 'acct-B')).toBe('node-B')
  })

  it('resolves the single owner when the same thread id names the SAME node in two scopes', () => {
    // Same owner in two places is not a conflict — owners.size === 1.
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot)
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot, 'acct-A')
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot)).toBe('node-1')
  })

  it('reports a live conflict only when two DIFFERENT live nodes own the thread', () => {
    writeCodexThreadIdentity('thread-1', 'node-A', '/data/e', recordsRoot, 'acct-A')
    writeCodexThreadIdentity('thread-1', 'node-B', '/data/e', recordsRoot, 'acct-B')
    expect(codexThreadIdentityHasLiveConflict('thread-1', live(['node-A', 'node-B']), recordsRoot)).toBe(true)
    // Only one of them live ⇒ no conflict; the other is a stale record free to be reclaimed.
    expect(codexThreadIdentityHasLiveConflict('thread-1', live(['node-A']), recordsRoot)).toBe(false)
  })

  it('rejects a managed record whose owner was edited without the signing key (Property 7)', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot, 'acct-A')
    const file = path.join(recordsRoot, 'acct-A', 'thread-1')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('node-1', 'node-evil'))
    // MUTATION TARGET: skip recordSignatureValid ⇒ this returns node-evil and reddens.
    expect(readCodexThreadIdentity('thread-1', recordsRoot, 'acct-A')).toBeUndefined()
  })

  it('rejects a record whose accountId line disagrees with its directory scope (Property 7)', () => {
    // A perfectly valid record for acct-A, physically moved into acct-B's directory. Its account
    // line still says acct-A, so it must not be honoured as acct-B's — nor re-verify under acct-B.
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot, 'acct-A')
    fs.mkdirSync(path.join(recordsRoot, 'acct-B'), { recursive: true })
    fs.copyFileSync(
      path.join(recordsRoot, 'acct-A', 'thread-1'),
      path.join(recordsRoot, 'acct-B', 'thread-1')
    )
    expect(readCodexThreadIdentity('thread-1', recordsRoot, 'acct-A')?.nodeId).toBe('node-1')
    // The scope-bound HMAC is what actually carries this: the record was signed under scope
    // `acct-A`, so recomputing the expected signature under scope `acct-B` mismatches and the record
    // is rejected regardless. The explicit accountId-line-vs-directory agreement check is
    // defence-in-depth layered on top (a clearer refusal, and belt-and-braces if the preimage ever
    // changed). So this asserts the OUTCOME — acct-B never honours acct-A's record — not that the
    // line check alone is load-bearing (carried PR-2 minor: the earlier comment overstated that).
    expect(readCodexThreadIdentity('thread-1', recordsRoot, 'acct-B')).toBeUndefined()
  })

  it('hand-forged managed record with a correct 4-tuple signature is honoured', () => {
    // Proves the 4-tuple preimage is exactly (threadId ␀ scope ␀ nodeId ␀ endpoint) — the mutation
    // check for the ambiguity/HMAC tests rests on being able to mint a genuinely valid record.
    fs.mkdirSync(path.join(recordsRoot, 'acct-A'), { recursive: true })
    fs.writeFileSync(
      path.join(recordsRoot, 'acct-A', 'thread-9'),
      `accountId=acct-A\nnodeId=node-9\nendpoint=/data/e\nsignature=${sign4('thread-9', 'acct-A', 'node-9', '/data/e')}\n`
    )
    expect(readIdentityCandidate('thread-9', 'acct-A', recordsRoot)?.nodeId).toBe('node-9')
    // The same bytes with a scope-mismatched signature (signed as system) do NOT verify at acct-A.
    fs.writeFileSync(
      path.join(recordsRoot, 'acct-A', 'thread-9'),
      `accountId=acct-A\nnodeId=node-9\nendpoint=/data/e\nsignature=${sign4('thread-9', 'system', 'node-9', '/data/e')}\n`
    )
    expect(readIdentityCandidate('thread-9', 'acct-A', recordsRoot)).toBeUndefined()
  })

  it('keeps resolving a legacy 3-tuple system record with no accountId line (Constraint 12)', () => {
    // A record written by pre-S6 S4 code: bare root, no accountId line, 3-tuple signature. A
    // system-only user must keep resolving after the account scoping lands.
    fs.mkdirSync(recordsRoot, { recursive: true })
    fs.writeFileSync(
      path.join(recordsRoot, 'legacy-thread'),
      `nodeId=node-legacy\nendpoint=/data/e\nsignature=${sign3('legacy-thread', 'node-legacy', '/data/e')}\n`
    )
    expect(readCodexThreadIdentity('legacy-thread', recordsRoot)?.nodeId).toBe('node-legacy')
    expect(resolveCodexThreadNodeIdentity('legacy-thread', recordsRoot)).toBe('node-legacy')
  })

  it('never accepts the legacy 3-tuple fallback for a managed scope', () => {
    // The back-compat door is system-only: a 3-tuple signature under a managed subdir is refused,
    // so the account dimension cannot be stripped by omitting the account line in acct-A's dir.
    fs.mkdirSync(path.join(recordsRoot, 'acct-A'), { recursive: true })
    fs.writeFileSync(
      path.join(recordsRoot, 'acct-A', 'thread-1'),
      `nodeId=node-1\nendpoint=/data/e\nsignature=${sign3('thread-1', 'node-1', '/data/e')}\n`
    )
    expect(readIdentityCandidate('thread-1', 'acct-A', recordsRoot)).toBeUndefined()
  })

  it('bind refuses to steal a managed thread from a live node in the SAME scope', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot, 'acct-A')
    expect(() =>
      bindCodexThreadIdentity('thread-1', 'node-2', '/data/e', live(['node-1']), recordsRoot, 'acct-A')
    ).toThrow()
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot, 'acct-A')).toBe('node-1')
    // A different account's identically-named thread is a different owner, freely bindable.
    bindCodexThreadIdentity('thread-1', 'node-2', '/data/e', live(['node-1']), recordsRoot, 'acct-B')
    expect(resolveCodexThreadNodeIdentity('thread-1', recordsRoot, 'acct-B')).toBe('node-2')
  })
})

// ── The agent dimension: the record names the agent, and the prelude stops guessing ───────────
//
// `NODETERM_AGENT_ID` and `NODETERM_CANVAS_CONTROL` used to be constants in the sh prelude
// (`codex`, granted). Both are `buildPtyEnv`'s answers about the PANE, so the constants mislabelled
// every custom agent inheriting the codex harness and asserted a grant the pane might not hold.
// Now they ride the record, inside the signature.
//
// The invariant these tests exist for is that the three preimage generations are SELECTED by the
// record's shape and never tried in turn: a record that names an agent must not be verifiable under
// a preimage that ignores the agent, or the field could be stripped or rewritten at will.
const sign6 = (
  threadId: string,
  scope: string,
  nodeId: string,
  endpoint: string,
  agentId: string,
  grant: boolean
): string =>
  b64url(
    createHmac('sha256', FIXED_SECRET)
      .update(`${threadId}\0${scope}\0${nodeId}\0${endpoint}\0${agentId}\0${grant ? '1' : '0'}`)
      .digest()
  )

const recordFile = (threadId: string): string => path.join(recordsRoot, threadId)

describe('agent identity in the ownership record', () => {
  beforeEach(() => setCodexThreadIdentityAuthSecret(FIXED_SECRET))

  it('round-trips the agent id and the grant', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot, undefined, {
      agentId: 'custom:abc',
      canvasControl: false
    })
    const got = readCodexThreadIdentity('thread-1', recordsRoot)
    expect(got?.agentId).toBe('custom:abc')
    expect(got?.canvasControl).toBe(false)
    expect(got?.agentDeclared).toBe(true)
  })

  it('reads a PRE-AGENT record as codex with the grant, and says the id was not declared', () => {
    // The back-compat contract, and the reason it is safe: every record written before these fields
    // existed came from this same Codex spine, and codex is unconditionally canvas-control-capable,
    // so the implied pair reproduces exactly what the prelude used to hardcode.
    fs.mkdirSync(recordsRoot, { recursive: true })
    fs.writeFileSync(
      recordFile('legacy-1'),
      `accountId=\nnodeId=node-1\nendpoint=/data/e\nsignature=${sign4('legacy-1', 'system', 'node-1', '/data/e')}\n`
    )
    const got = readCodexThreadIdentity('legacy-1', recordsRoot)
    expect(got?.nodeId).toBe('node-1')
    expect(got?.agentId).toBe('codex')
    expect(got?.canvasControl).toBe(true)
    // The distinguishing bit: `codex` here is an IMPLICATION, not a claim, and callers that rewrite
    // the record need to know the difference (see the no-downgrade test below).
    expect(got?.agentDeclared).toBe(false)
  })

  it('refuses a record whose agent id was edited after signing', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot, undefined, {
      agentId: 'codex',
      canvasControl: true
    })
    const raw = fs.readFileSync(recordFile('thread-1'), 'utf8')
    fs.writeFileSync(recordFile('thread-1'), raw.replace('agentId=codex', 'agentId=custom:evil'))
    expect(readCodexThreadIdentity('thread-1', recordsRoot)).toBeUndefined()
  })

  it('refuses a record whose GRANT was edited after signing', () => {
    // The whole reason the grant is inside the signature: it is a capability the prelude exports
    // into an agent's shell, so an unsigned copy would be a grant anyone who can write the file
    // could add.
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot, undefined, {
      agentId: 'custom:abc',
      canvasControl: false
    })
    const raw = fs.readFileSync(recordFile('thread-1'), 'utf8')
    fs.writeFileSync(recordFile('thread-1'), raw.replace('canvasControl=0', 'canvasControl=1'))
    expect(readCodexThreadIdentity('thread-1', recordsRoot)).toBeUndefined()
  })

  it('never verifies an agent-carrying record under the pre-agent preimage', () => {
    // THE SELECTION RULE. This record is signed with the valid 4-tuple for its node+endpoint, so a
    // verifier that fell through generations would accept it and then read `custom:evil` — the door
    // through which the agent id becomes forgeable. Selecting by shape closes it.
    fs.mkdirSync(recordsRoot, { recursive: true })
    fs.writeFileSync(
      recordFile('thread-1'),
      `accountId=\nnodeId=node-1\nendpoint=/data/e\nagentId=custom:evil\ncanvasControl=1\n` +
        `signature=${sign4('thread-1', 'system', 'node-1', '/data/e')}\n`
    )
    expect(readCodexThreadIdentity('thread-1', recordsRoot)).toBeUndefined()
  })

  it('accepts a hand-signed 6-tuple record, so the preimage is the documented one', () => {
    fs.mkdirSync(recordsRoot, { recursive: true })
    fs.writeFileSync(
      recordFile('thread-1'),
      `accountId=\nnodeId=node-1\nendpoint=/data/e\nagentId=custom:abc\ncanvasControl=0\n` +
        `signature=${sign6('thread-1', 'system', 'node-1', '/data/e', 'custom:abc', false)}\n`
    )
    expect(readCodexThreadIdentity('thread-1', recordsRoot)?.agentId).toBe('custom:abc')
  })

  it('binds the agent id under a managed account scope too', () => {
    bindCodexThreadIdentity('thread-1', 'node-1', '/data/e', live([]), recordsRoot, 'acct-A', {
      agentId: 'custom:abc',
      canvasControl: true
    })
    expect(readCodexThreadIdentity('thread-1', recordsRoot, 'acct-A')?.agentId).toBe('custom:abc')
    // Scope binding is unchanged: the managed record is still invisible at the system scope.
    expect(readCodexThreadIdentity('thread-1', recordsRoot)).toBeUndefined()
  })

  it('a rebind WITHOUT an agent id keeps the one already recorded', () => {
    // A pane whose NODETERM_AGENT_ID did not survive, or an older launcher, must not strip the line
    // and send the prelude back to guessing `codex` — for a custom codex-based node that guess is
    // the exact mislabel this slice removes.
    bindCodexThreadIdentity('thread-1', 'node-1', '/data/e', live([]), recordsRoot, undefined, {
      agentId: 'custom:abc',
      canvasControl: false
    })
    bindCodexThreadIdentity('thread-1', 'node-1', '/data/e2', live([]), recordsRoot)
    const got = readCodexThreadIdentity('thread-1', recordsRoot)
    expect(got?.hookEndpoint).toBe('/data/e2')
    expect(got?.agentId).toBe('custom:abc')
    expect(got?.canvasControl).toBe(false)
  })

  it('a rebind of a PRE-AGENT record does not write the implied codex as a claim', () => {
    // The other half of the rule. `codex` was an implication of an old record's shape; promoting it
    // to a signed claim would make a wrong guess permanent for a custom node.
    fs.mkdirSync(recordsRoot, { recursive: true })
    fs.writeFileSync(
      recordFile('legacy-1'),
      `accountId=\nnodeId=node-1\nendpoint=/data/e\nsignature=${sign4('legacy-1', 'system', 'node-1', '/data/e')}\n`
    )
    bindCodexThreadIdentity('legacy-1', 'node-1', '/data/e2', live([]), recordsRoot)
    expect(fs.readFileSync(recordFile('legacy-1'), 'utf8')).not.toContain('agentId=')
    expect(readCodexThreadIdentity('legacy-1', recordsRoot)?.agentDeclared).toBe(false)
  })

  it('a later bind that DOES know the agent id upgrades a pre-agent record in place', () => {
    fs.mkdirSync(recordsRoot, { recursive: true })
    fs.writeFileSync(
      recordFile('legacy-1'),
      `accountId=\nnodeId=node-1\nendpoint=/data/e\nsignature=${sign4('legacy-1', 'system', 'node-1', '/data/e')}\n`
    )
    bindCodexThreadIdentity('legacy-1', 'node-1', '/data/e', live([]), recordsRoot, undefined, {
      agentId: 'custom:abc',
      canvasControl: true
    })
    expect(readCodexThreadIdentity('legacy-1', recordsRoot)?.agentId).toBe('custom:abc')
  })

  it('refuses an EMPTY agentId line rather than reading it as codex', () => {
    // The fallback is keyed on the LINE BEING ABSENT, never on the value being empty. Keying it on
    // the value would mean a record that carries an `agentId=` line can still land on the `codex`
    // guess — the exact mislabel this slice removes, reinstated by a shape we do accept as input.
    // This record is even signed for `codex`, so a value-keyed reader would verify it happily.
    fs.mkdirSync(recordsRoot, { recursive: true })
    fs.writeFileSync(
      recordFile('thread-1'),
      `accountId=\nnodeId=node-1\nendpoint=/data/e\nagentId=\ncanvasControl=1\n` +
        `signature=${sign6('thread-1', 'system', 'node-1', '/data/e', 'codex', true)}\n`
    )
    expect(readCodexThreadIdentity('thread-1', recordsRoot)).toBeUndefined()
  })

  it('refuses to write an agent id outside the accepted alphabet', () => {
    // Re-validated at the write as well as the read: the value ends up as an environment variable in
    // an agent's shell, and a signature only proves we wrote the bytes, not that they are a shape we
    // still accept.
    for (const bad of ['', 'a b', 'a\nb', 'a/b', 'x'.repeat(129)]) {
      expect(
        () =>
          writeCodexThreadIdentity('thread-1', 'node-1', '/data/e', recordsRoot, undefined, {
            agentId: bad,
            canvasControl: true
          }),
        JSON.stringify(bad)
      ).toThrow()
    }
  })
})
