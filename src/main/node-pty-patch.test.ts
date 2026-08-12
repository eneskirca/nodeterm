import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Guard for our local node-pty fd-leak patch (microsoft/node-pty#950).
 *
 * node-pty 1.1.0's darwin `pty_posix_spawn` leaks one ptmx device per SUCCESSFUL
 * spawn (off-by-one in the low-fd cleanup) and master+slave on every FAILED one.
 * On this app's spawn churn that exhausts `kern.tty.ptmx_max` within hours.
 * scripts/patch-node-pty.mjs rewrites node_modules/node-pty/src/unix/pty.cc
 * before electron-rebuild compiles it.
 *
 * This test does NOT measure descriptors (that is environment-dependent); it
 * asserts the patch is present in the sources the native module is built from,
 * so a node-pty upgrade that silently drops it fails loudly here.
 */
const PTY_CC = path.resolve(__dirname, '../../node_modules/node-pty/src/unix/pty.cc')
/** Must stay in sync with PATCH_MARKER in scripts/patch-node-pty.mjs. */
const PATCH_MARKER = 'NODETERM-PATCH(node-pty#950)'

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
