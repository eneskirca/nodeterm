#!/usr/bin/env node
/**
 * patch-node-pty.mjs — local fix for a file-descriptor leak in node-pty's macOS
 * spawn path (`pty_posix_spawn` in node_modules/node-pty/src/unix/pty.cc).
 *
 * WHAT IT FIXES — upstream issue: https://github.com/microsoft/node-pty/issues/950
 *   (filed by us against node-pty 1.1.0)
 *
 *   (a) FAILED spawns leak the master + slave descriptors. None of the early
 *       returns after `posix_openpt()` succeeds close the master, and the slave
 *       is never closed in the parent on any path. Each failure burns 2 ptmx
 *       devices + 1 /dev/ttysNNN descriptor.
 *
 *   (b) SUCCESSFUL spawns leak exactly one ptmx device via the "low fd"
 *       prologue's off-by-one cleanup:
 *           for (; count > 0; count--) close(low_fds[count]);
 *       The loop stops at count == 0, so low_fds[0] — the descriptor opened
 *       first, and the only one opened in the common case where the very first
 *       posix_openpt() already returns an fd >= STDERR_FILENO — is never
 *       closed. It also skips index 0 whenever count > 0, and reads low_fds[3]
 *       out of bounds if the loop above ever runs to completion.
 *
 *   Field impact on macOS: ~16 successful spawns/min of normal park/offscreen/
 *   reap + reattach churn x 1 leaked ptmx device each walks straight into
 *   `kern.tty.ptmx_max` (511 on this machine) within hours, after which every
 *   further pty spawn fails with "posix_spawnp failed.".
 *
 * WHY A SCRIPT AND NOT patch-package: patch-package is not a dependency of this
 * repo and adding one would require an `npm install` against a node_modules
 * tree that is shared with live dev sessions. This script needs no install: it
 * is a guarded, idempotent text patch wired into `postinstall` (and `rebuild`)
 * ahead of electron-rebuild, so the native module is always compiled from
 * patched sources.
 *
 * PROPERTIES
 *   - Idempotent: re-running is a no-op (detected via the PATCH_MARKER below).
 *   - Verifiable: if any anchor is missing (e.g. after a node-pty upgrade that
 *     reshapes this function) the script exits non-zero and explains what to do
 *     rather than silently producing an unpatched build.
 *   - Cross-platform safe: pty.cc ships in every install; the patched block is
 *     inside `#if defined(__APPLE__)`, so patching on Linux/CI is harmless.
 *
 * REMOVAL CONDITION
 *   Delete this script, its postinstall/rebuild wiring, and
 *   src/main/node-pty-patch.test.ts as soon as we upgrade to a node-pty
 *   release that carries the upstream fix for issue #950. The guard test in
 *   src/main/node-pty-patch.test.ts will fail loudly if a node-pty upgrade
 *   silently drops this patch, which is the signal to check whether the fix
 *   landed upstream.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const ptyDir = path.join(repoRoot, 'node_modules', 'node-pty');
const ptyCc = path.join(ptyDir, 'src', 'unix', 'pty.cc');

export const PATCH_MARKER = 'NODETERM-PATCH(node-pty#950)';
const ISSUE_URL = 'https://github.com/microsoft/node-pty/issues/950';
const EXPECTED_VERSION = '1.1.0';

/** Anchor -> replacement. Every anchor must match exactly once. */
const EDITS = [
  {
    name: 'error-path fd cleanup (master/slave)',
    find: `  *master = posix_openpt(O_RDWR);
  if (*master == -1) {
    return;
  }

  int res = grantpt(*master) || unlockpt(*master);
  if (res == -1) {
    return;
  }

  // Use TIOCPTYGNAME instead of ptsname() to avoid threading problems.
  int slave;
  char slave_pty_name[128];
  res = ioctl(*master, TIOCPTYGNAME, slave_pty_name);
  if (res == -1) {
    return;
  }

  slave = open(slave_pty_name, O_RDWR | O_NOCTTY);
  if (slave == -1) {
    return;
  }

  if (termp) {
    res = tcsetattr(slave, TCSANOW, termp);
    if (res == -1) {
      return;
    };
  }

  if (winp) {
    res = ioctl(slave, TIOCSWINSZ, winp);
    if (res == -1) {
      return;
    }
  }
`,
    replace: `  *master = posix_openpt(O_RDWR);
  if (*master == -1) {
    return;
  }

  // ${PATCH_MARKER}: every early return below happens *after* posix_openpt()
  // handed us a master descriptor, so the parent must close it (and the slave,
  // once opened) before bailing out. Upstream leaks both. See ${ISSUE_URL}
  int res = grantpt(*master) || unlockpt(*master);
  if (res == -1) {
    close(*master);
    *master = -1;
    return;
  }

  // Use TIOCPTYGNAME instead of ptsname() to avoid threading problems.
  int slave;
  char slave_pty_name[128];
  res = ioctl(*master, TIOCPTYGNAME, slave_pty_name);
  if (res == -1) {
    close(*master);
    *master = -1;
    return;
  }

  slave = open(slave_pty_name, O_RDWR | O_NOCTTY);
  if (slave == -1) {
    close(*master);
    *master = -1;
    return;
  }

  if (termp) {
    res = tcsetattr(slave, TCSANOW, termp);
    if (res == -1) {
      close(slave);
      close(*master);
      *master = -1;
      return;
    };
  }

  if (winp) {
    res = ioctl(slave, TIOCSWINSZ, winp);
    if (res == -1) {
      close(slave);
      close(*master);
      *master = -1;
      return;
    }
  }
`
  },
  {
    name: 'post-spawn cleanup + low-fd off-by-one',
    find: `done:
  posix_spawn_file_actions_destroy(&acts);
  posix_spawnattr_destroy(&attrs);

  for (; count > 0; count--) {
    close(low_fds[count]);
  }
}`,
    replace: `done:
  posix_spawn_file_actions_destroy(&acts);
  posix_spawnattr_destroy(&attrs);

  // ${PATCH_MARKER}: the child received its own dup2'd copies of the slave, so
  // the parent's descriptor is dead weight on every path — upstream never
  // closes it. On failure the master is dead weight too. See ${ISSUE_URL}
  close(slave);
  if (*err != 0) {
    close(*master);
    *master = -1;
  }

  // ${PATCH_MARKER}: upstream ran \`for (; count > 0; count--) close(low_fds[count]);\`
  // which (1) never closes low_fds[0] — the only descriptor opened in the
  // common case — leaking one ptmx device per *successful* spawn, (2) skips
  // index 0 whenever count > 0, and (3) reads low_fds[3] out of bounds when the
  // prologue loop ran to completion. Close exactly what was opened instead.
  size_t opened = count < 3 ? count + 1 : 3;
  for (size_t i = 0; i < opened; i++) {
    if (low_fds[i] >= 0) {
      close(low_fds[i]);
    }
  }
}`
  }
];

function fail(msg) {
  console.error(`\n[patch-node-pty] ERROR: ${msg}\n`);
  console.error(`  Patch script : scripts/patch-node-pty.mjs`);
  console.error(`  Upstream bug : ${ISSUE_URL}`);
  console.error(
    `  If node-pty was upgraded: check whether the fix landed upstream. If it did,\n` +
      `  delete this script, its postinstall/rebuild wiring and src/main/node-pty-patch.test.ts.\n` +
      `  If it did not, re-derive the anchors in EDITS against the new pty.cc.\n`
  );
  process.exit(1);
}

function main() {
  if (!fs.existsSync(ptyCc)) {
    // node-pty is optional in some install shapes (e.g. docs-only CI installs).
    console.log('[patch-node-pty] node-pty sources not present, nothing to patch.');
    return;
  }

  let installedVersion = 'unknown';
  try {
    installedVersion = JSON.parse(
      fs.readFileSync(path.join(ptyDir, 'package.json'), 'utf8')
    ).version;
  } catch {
    /* fall through — the anchor check below is the real guard */
  }

  const original = fs.readFileSync(ptyCc, 'utf8');

  if (original.includes(PATCH_MARKER)) {
    console.log(`[patch-node-pty] already applied (node-pty ${installedVersion}), skipping.`);
    return;
  }

  if (installedVersion !== EXPECTED_VERSION) {
    console.warn(
      `[patch-node-pty] note: expected node-pty ${EXPECTED_VERSION}, found ${installedVersion}. ` +
        `Verifying anchors anyway.`
    );
  }

  let patched = original;
  for (const edit of EDITS) {
    const occurrences = patched.split(edit.find).length - 1;
    if (occurrences !== 1) {
      fail(
        `anchor "${edit.name}" matched ${occurrences} times (expected exactly 1) in\n  ${ptyCc}\n` +
          `  node-pty version: ${installedVersion}`
      );
    }
    patched = patched.replace(edit.find, edit.replace);
  }

  fs.writeFileSync(ptyCc, patched, 'utf8');
  console.log(
    `[patch-node-pty] applied fd-leak patch to node-pty ${installedVersion} ` +
      `(src/unix/pty.cc) — ${ISSUE_URL}`
  );
}

// Only patch when executed directly (`node scripts/patch-node-pty.mjs`), never as
// a side effect of importing this module.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
