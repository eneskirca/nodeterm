import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { hookServer } from './hook-server'
import { loadOrCreateNodeAuthSecret, resetNodeAuthSecretForTests } from './node-auth-secret'
import { nodeTokenDir, resetNodeTokenFilesForTests } from './node-token-files'
import {
  initNodeTokens,
  ensureNodeToken,
  sweepNodeToken,
  refreshNodeTokens,
  nodeIdFoldKey,
  nodeIdsForCanvas,
  remoteNodeTokenMinter,
  setRemoteNodeTokenWriter,
  ensureRemoteNodeToken
} from './node-token-service'

let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-svc-'))
  resetPlatformForTests()
  resetNodeAuthSecretForTests()
  resetNodeTokenFilesForTests()
  hookServer.clearNodeAuthSecretForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
})
afterEach(() => {
  hookServer.clearNodeAuthSecretForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

const canvases = [
  { nodes: [{ id: 'node-1' }, { id: 'node-2' }] },
  { nodes: [{ id: 'node-3' }] }
]

describe('node token service', () => {
  it('materialises every node id in every persisted canvas at boot', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => canvases })
    expect(fs.readdirSync(nodeTokenDir()).sort()).toEqual(['node-1', 'node-2', 'node-3'])
  })

  it('writes nothing at all when the server has no secret (legacy mode)', () => {
    hookServer.clearNodeAuthSecretForTests()
    initNodeTokens({ canvases: () => canvases })
    expect(fs.existsSync(nodeTokenDir())).toBe(false)
  })

  it('skips an unsafe id in a corrupt project file without aborting the sweep', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => [{ nodes: [{ id: '..' }, { id: 'node-9' }] }] })
    expect(fs.readdirSync(nodeTokenDir())).toEqual(['node-9'])
  })

  it('re-derives identical bytes on a refresh (no churn)', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    ensureNodeToken('node-1')
    const first = fs.readFileSync(path.join(nodeTokenDir(), 'node-1'), 'utf8')
    ensureNodeToken('node-1')
    expect(fs.readFileSync(path.join(nodeTokenDir(), 'node-1'), 'utf8')).toBe(first)
  })

  it('sweeps a token on delete', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    ensureNodeToken('node-1')
    sweepNodeToken('node-1')
    expect(fs.existsSync(path.join(nodeTokenDir(), 'node-1'))).toBe(false)
  })
})

/**
 * On APFS `<tokenDir>/Term-1` and `<tokenDir>/term-1` are ONE file, so a `project.json` carrying
 * both ids picks — by array order — which node's token lands in it, and the other node reads it.
 * The refusal is unconditional (not fs-dependent): the test host here is case-SENSITIVE, so a
 * missing refusal shows up as two files being written rather than as a hijack.
 */
describe('node token service — case-folding node id collisions', () => {
  const files = () => fs.readdirSync(nodeTokenDir()).sort()

  it('writes NEITHER token for two ids that differ only in case, and says so out loud', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => [{ nodes: [{ id: 'Term-1' }, { id: 'term-1' }] }] })
    expect(fs.existsSync(nodeTokenDir()) ? files() : []).toEqual([])
    expect(warn.mock.calls.flat().join(' ')).toMatch(/Term-1.*term-1|term-1.*Term-1/)
    warn.mockRestore()
  })

  it('refuses only the colliding pair — an innocent third node still gets its token', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({
      canvases: () => [{ nodes: [{ id: 'Term-1' }, { id: 'term-1' }, { id: 'node-9' }] }]
    })
    expect(files()).toEqual(['node-9'])
    vi.restoreAllMocks()
  })

  it('refuses on the SPAWN path too, checked against the live canvas', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    // The canvas holds only the attacker's id; the victim is spawning right now.
    initNodeTokens({ canvases: () => [{ nodes: [{ id: 'TERM-1' }] }] })
    expect(files()).toEqual(['TERM-1'])
    ensureNodeToken('term-1')
    // Both are gone: writing the second would have overwritten the first on APFS, and LEAVING the
    // first is exactly the token the second node would have read.
    expect(files()).toEqual([])
    vi.restoreAllMocks()
  })

  it('sweeps a token already written before its twin appeared on the canvas', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    let hostile = false
    initNodeTokens({
      canvases: () => [{ nodes: hostile ? [{ id: 'Term-1' }, { id: 'term-1' }] : [{ id: 'Term-1' }] }]
    })
    expect(files()).toEqual(['Term-1'])
    hostile = true
    refreshNodeTokens()
    expect(files()).toEqual([])
    vi.restoreAllMocks()
  })

  it('an exact duplicate id is not a collision — a cloned project.json still gets its token', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => [{ nodes: [{ id: 'node-1' }] }, { nodes: [{ id: 'node-1' }] }] })
    expect(files()).toEqual(['node-1'])
  })

  it('folds Unicode case and normalization, not just ASCII', () => {
    // Not reachable through NODE_ID_CHARSET today — asserted so the key stays correct if it widens,
    // since APFS folds both and a missed fold is the vulnerability.
    expect(nodeIdFoldKey('CAFÉ')).toBe(nodeIdFoldKey('café')) // É vs e + combining acute
    expect(nodeIdFoldKey('KELVIN')).toBe(nodeIdFoldKey('kelvin')) // U+212A KELVIN SIGN
  })
})

/**
 * `refreshNodeTokens` is wired to `onPersist`, which fires on every canvas load AND save, so a
 * ~375-node workspace paid ~2000 synchronous syscalls on the main thread per save to rewrite bytes
 * that cannot change. The inode is the assertion rather than mtime: the writer is tmp+rename, so a
 * real rewrite always lands a NEW inode (the tmp is allocated while the old file still exists),
 * which no clock resolution can blur.
 */
describe('node token service — writes once, not on every persist', () => {
  const ino = (id: string) => fs.statSync(path.join(nodeTokenDir(), id)).ino

  it('does not touch the file again for an id already materialised this run', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => canvases })
    const before = canvases.flatMap((c) => c.nodes).map((n) => [n.id, ino(n.id)] as const)
    refreshNodeTokens() // what every save costs
    ensureNodeToken('node-1') // ...and what every spawn costs
    for (const [id, was] of before) expect(ino(id), id).toBe(was)
  })

  it('rewrites anyway under `force` — the boot sweep re-asserts what is on disk', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    ensureNodeToken('node-1')
    const was = ino('node-1')
    ensureNodeToken('node-1', { force: true })
    expect(ino('node-1')).not.toBe(was)
  })

  /**
   * The short-circuit is a "we wrote it" cache, and before this it was never re-checked against the
   * filesystem. Anything that removes `node-tokens/` while the app runs — a cleanup tool, a user
   * tidying their data dir, a sync client — therefore made every later refresh a no-op: live
   * sessions present an empty header, and every already-PROVEN node takes a hard 403 for the rest
   * of the run.
   */
  it('re-writes a token file deleted out of band, instead of trusting the cache forever', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => canvases })
    fs.rmSync(nodeTokenDir(), { recursive: true, force: true })
    refreshNodeTokens() // an ordinary persist, no `force`
    expect(fs.readdirSync(nodeTokenDir()).sort()).toEqual(['node-1', 'node-2', 'node-3'])
  })

  it('still writes once, not twice, when the file IS there — the stat is not a rewrite', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => canvases })
    const was = ino('node-1')
    refreshNodeTokens()
    refreshNodeTokens()
    expect(ino('node-1')).toBe(was)
  })

  it('re-materialises a swept id, so a deleted-then-recreated node is not left on legacy', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    ensureNodeToken('node-1')
    sweepNodeToken('node-1')
    expect(fs.existsSync(path.join(nodeTokenDir(), 'node-1'))).toBe(false)
    ensureNodeToken('node-1')
    expect(fs.existsSync(path.join(nodeTokenDir(), 'node-1'))).toBe(true)
  })
})

/**
 * The REMOTE (SSH) materialiser's half. The host is a different filesystem with a different
 * writer, but it must be judged by the SAME rules — otherwise a hostile `project.json` bypasses
 * the local guards simply by living on an SSH project.
 */
describe('node token service — the remote (SSH) minter', () => {
  it('returns null when there is no secret, so a connect spends no round-trips at all', () => {
    hookServer.clearNodeAuthSecretForTests()
    initNodeTokens({ canvases: () => canvases })
    expect(remoteNodeTokenMinter()).toBeNull()
  })

  it('mints the same token the local writer would file, without touching the local disk', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => canvases })
    const before = fs.readFileSync(path.join(nodeTokenDir(), 'node-1'), 'utf8')
    const mint = remoteNodeTokenMinter()!
    expect(`${mint('node-1')}\n`).toBe(before)
  })

  it('refuses a case-folding collision on the remote path too (empty ⇒ the caller sweeps)', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => [{ id: 'p1', nodes: [{ id: 'Node-1' }, { id: 'node-1' }] }] })
    const mint = remoteNodeTokenMinter()!
    expect(mint('Node-1')).toBe('')
    expect(mint('node-1')).toBe('')
    expect(mint('node-7')).not.toBe('')
  })

  it('refuses an unsafe id', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => canvases })
    const mint = remoteNodeTokenMinter()!
    expect(mint('..')).toBe('')
    expect(mint('../x')).toBe('')
  })

  it('nodeIdsForCanvas returns one project’s node ids, de-duplicated, and nothing for a stranger', () => {
    initNodeTokens({
      canvases: () => [
        { id: 'p1', nodes: [{ id: 'node-1' }, { id: 'node-1' }, { id: 'node-2' }] },
        { id: 'p2', nodes: [{ id: 'node-3' }] }
      ]
    })
    expect(nodeIdsForCanvas('p1')).toEqual(['node-1', 'node-2'])
    expect(nodeIdsForCanvas('p2')).toEqual(['node-3'])
    expect(nodeIdsForCanvas('nope')).toEqual([])
  })

  it('the spawn-path writer is a no-op until one is registered, and never throws', () => {
    setRemoteNodeTokenWriter(null)
    expect(() => ensureRemoteNodeToken('/cm.sock', 'node-1')).not.toThrow()
    const seen: string[][] = []
    setRemoteNodeTokenWriter((cp, id) => seen.push([cp, id]))
    ensureRemoteNodeToken('/cm.sock', 'node-1')
    expect(seen).toEqual([['/cm.sock', 'node-1']])
    // a writer that throws must not reach the pty spawn that called it
    setRemoteNodeTokenWriter(() => {
      throw new Error('ssh gone')
    })
    expect(() => ensureRemoteNodeToken('/cm.sock', 'node-1')).not.toThrow()
    setRemoteNodeTokenWriter(null)
  })
})

/**
 * A token file outlives its node whenever the node leaves the canvas by a path that does not go
 * through `ptyManager.destroy(intent:'delete')` — a project removed, a canvas edited elsewhere, a
 * hand-rewritten `project.json` — so the dir grows one 0600 file per dead id, forever.
 *
 * The sweep's authority is deliberately narrow: an id has to have been OBSERVED on a canvas earlier
 * this run. `persistedCanvases()` is a view of what has been READ this run, so an id's absence from
 * it is not evidence a node is gone — and sweeping a live node's token un-proves it and drops it to
 * `legacy`, which after the cutoff is a node that cannot drive the canvas at all.
 */
describe('node token service — a node that leaves the canvas takes its token with it', () => {
  it('sweeps the file and releases the latch for an id that was there and now is not', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    let live = [{ id: 'stays' }, { id: 'departs' }]
    initNodeTokens({ canvases: () => [{ nodes: live }] })
    expect(fs.readdirSync(nodeTokenDir()).sort()).toEqual(['departs', 'stays'])

    // A departed node may have proved itself while it was still here, and a latch outliving the
    // token it was earned with is a permanent 403 on that id if it ever comes back.
    const forget = vi.spyOn(hookServer, 'forgetProvenNode')

    live = [{ id: 'stays' }]
    refreshNodeTokens()
    expect(fs.readdirSync(nodeTokenDir())).toEqual(['stays'])
    expect(forget).toHaveBeenCalledWith('departs')
    forget.mockRestore()
  })

  it('never sweeps an id it has not seen on a canvas this run', async () => {
    // A file from a PREVIOUS run, for a node on a project this run has not read yet. Deleting it
    // because it is missing from `canvasNodeIds()` would strand that node the moment its project
    // loads — the exact bug the narrow authority exists to avoid.
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => [{ nodes: [{ id: 'known' }] }] })
    fs.writeFileSync(path.join(nodeTokenDir(), 'from-a-project-not-loaded-yet'), 'tok\n', { mode: 0o600 })
    refreshNodeTokens()
    expect(fs.readdirSync(nodeTokenDir()).sort()).toEqual([
      'from-a-project-not-loaded-yet',
      'known'
    ])
  })

  it('sweeps nothing on the BOOT pass, however empty the index still is', async () => {
    // `initNodeTokens` runs before the desktop's workspace has necessarily been read. Starting the
    // observed set empty is what stops a half-loaded index from costing every live node its token.
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => [{ nodes: [{ id: 'node-1' }] }] })
    initNodeTokens({ canvases: () => [] })
    expect(fs.readdirSync(nodeTokenDir())).toEqual(['node-1'])
  })
})
