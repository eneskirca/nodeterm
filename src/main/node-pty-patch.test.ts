import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Guard for our local node-pty native patches (scripts/patch-node-pty.mjs).
 *
 * Darwin: node-pty 1.1.0's `pty_posix_spawn` leaks one ptmx device per SUCCESSFUL
 * spawn (off-by-one in the low-fd cleanup) and master+slave on every FAILED one
 * (microsoft/node-pty#950). On this app's spawn churn that exhausts
 * `kern.tty.ptmx_max` within hours.
 *
 * Windows: node-pty 1.1.0's native exit thread deletes its `pty_baton` without
 * closing the HPCON the baton owns, so a taskkill-first teardown — the session
 * host's kill path — leaves a host-parented conhost alive for the life of the
 * long-lived session-host process, and `conpty.kill(id)` reports nothing. The
 * patch serializes baton access, closes the exact HPCON before every baton
 * deletion, and makes `kill(id)` return positive proof — the contract
 * src/session-host/windows-conpty.ts requires.
 *
 * These tests do NOT measure descriptors or handles (that is environment-
 * dependent); they assert the patches are present in the sources the native
 * module is built from, so a node-pty upgrade that silently drops either one
 * fails loudly here.
 */
const PTY_CC = path.resolve(__dirname, '../../node_modules/node-pty/src/unix/pty.cc')
const CONPTY_CC = path.resolve(__dirname, '../../node_modules/node-pty/src/win/conpty.cc')
/** Must stay in sync with PATCH_MARKER in scripts/patch-node-pty.mjs. */
const PATCH_MARKER = 'NODETERM-PATCH(node-pty#950)'
/** Must stay in sync with WINDOWS_CONPTY_PATCH_MARKER in scripts/patch-node-pty.mjs. */
const WINDOWS_CONPTY_PATCH_MARKER = 'NODETERM-PATCH(node-pty-conpty-exact-close)'

const HOWTO =
  'Run `node scripts/patch-node-pty.mjs && npm run rebuild`. ' +
  'If node-pty was upgraded, check https://github.com/microsoft/node-pty/issues/950 — ' +
  'if the fix landed upstream, delete scripts/patch-node-pty.mjs, its postinstall/rebuild ' +
  'wiring and this test; otherwise re-derive the anchors in the script.'

describe('node-pty fd-leak patch (microsoft/node-pty#950)', () => {
  const exists = fs.existsSync(PTY_CC)
  const source = exists ? fs.readFileSync(PTY_CC, 'utf8') : ''

  it.skipIf(!exists)('is applied to node_modules/node-pty/src/unix/pty.cc', () => {
    expect(source.includes(PATCH_MARKER), `node-pty fd-leak patch is MISSING. ${HOWTO}`).toBe(true)
  })

  it.skipIf(!exists)('closes the slave and the master on the failure path', () => {
    // The parent must drop its slave copy after posix_spawn, and the master too
    // when the spawn failed.
    expect(source).toContain('close(slave);\n  if (*err != 0) {\n    close(*master);')
  })

  it.skipIf(!exists)('no longer contains the off-by-one low-fd cleanup loop', () => {
    expect(
      source.includes('for (; count > 0; count--) {'),
      `Upstream's off-by-one low_fds cleanup is back — one ptmx device leaks per successful ` +
        `spawn. ${HOWTO}`
    ).toBe(false)
    expect(source).toContain('size_t opened = count < 3 ? count + 1 : 3;')
  })
})

describe('node-pty exact Windows ConPTY close patch', () => {
  const exists = fs.existsSync(CONPTY_CC)
  const source = exists ? fs.readFileSync(CONPTY_CC, 'utf8') : ''

  it.skipIf(!exists)('is applied to node_modules/node-pty/src/win/conpty.cc', () => {
    expect(
      source.includes(WINDOWS_CONPTY_PATCH_MARKER),
      `node-pty Windows ConPTY patch is MISSING. ${HOWTO}`
    ).toBe(true)
  })

  it.skipIf(!exists)('closes the exact HPCON before deleting its shell-exit baton', () => {
    // The exit thread is where the stock leak lives: it deleted the baton without ever
    // closing the HPCON. The close must come first, and both under the baton mutex.
    const closeIndex = source.indexOf('baton->closeExactPseudoConsole();')
    const removeIndex = source.indexOf('remove_pty_baton(lock, baton->id)')
    expect(closeIndex).toBeGreaterThan(0)
    expect(removeIndex).toBeGreaterThan(closeIndex)
    expect(source).toContain('std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);')
  })

  it.skipIf(!exists)('returns positive proof instead of the stock void kill result', () => {
    // src/session-host/windows-conpty.ts refuses anything but `true` from conpty.kill —
    // this is the source-level half of that contract.
    expect(source).toContain('closed = handle->closeExactPseudoConsole();')
    expect(source).toContain('return Napi::Boolean::New(env, closed);')
  })
})
