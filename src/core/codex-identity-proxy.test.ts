import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  bindCodexThreadIdentity,
  codexLauncherDir,
  forgetCodexThreadIdentitiesForNode,
  codexThreadIdentityRoot,
  installCodexLauncher,
  isSafeThreadId,
  readCodexThreadIdentity,
  resetCodexThreadIdentityAuthSecret,
  resolveCodexThreadNodeIdentity,
  setCodexThreadIdentityAuthSecret,
  writeCodexThreadIdentity
} from './codex-identity-proxy'
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
})
