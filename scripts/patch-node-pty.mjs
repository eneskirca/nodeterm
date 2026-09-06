#!/usr/bin/env node
/**
 * patch-node-pty.mjs — version-pinned local fixes for node-pty 1.1.0, applied to
 * node_modules before electron-rebuild compiles the native module:
 *
 *   1. DARWIN — a file-descriptor leak in the macOS spawn path (`pty_posix_spawn`
 *      in src/unix/pty.cc). Upstream issue: https://github.com/microsoft/node-pty/issues/950
 *      (filed by us against node-pty 1.1.0)
 *
 *      (a) FAILED spawns leak the master + slave descriptors. None of the early
 *          returns after `posix_openpt()` succeeds close the master, and the slave
 *          is never closed in the parent on any path. Each failure burns 2 ptmx
 *          devices + 1 /dev/ttysNNN descriptor.
 *
 *      (b) SUCCESSFUL spawns leak exactly one ptmx device via the "low fd"
 *          prologue's off-by-one cleanup:
 *              for (; count > 0; count--) close(low_fds[count]);
 *          The loop stops at count == 0, so low_fds[0] — the descriptor opened
 *          first, and the only one opened in the common case where the very first
 *          posix_openpt() already returns an fd >= STDERR_FILENO — is never
 *          closed. It also skips index 0 whenever count > 0, and reads low_fds[3]
 *          out of bounds if the loop above ever runs to completion.
 *
 *      Field impact on macOS: ~16 successful spawns/min of normal park/offscreen/
 *      reap + reattach churn x 1 leaked ptmx device each walks straight into
 *      `kern.tty.ptmx_max` (511 on this machine) within hours, after which every
 *      further pty spawn fails with "posix_spawnp failed.".
 *
 *   2. WINDOWS — the ConPTY baton/HPCON race in src/win/conpty.cc. node-pty's
 *      native exit thread deletes its `pty_baton` as soon as the shell process
 *      handle signals, WITHOUT closing the HPCON the baton owns (pty_baton has no
 *      destructor that closes it). When a caller terminates the process tree
 *      first — exactly what the session host's kill path does via `taskkill /T /F`
 *      (src/session-host/host.ts) — the exit thread wins the race, a later
 *      `conpty.kill(id)` silently finds no baton, and the host-parented conhost
 *      stays alive until the whole session-host process exits. The session host is
 *      a long-lived daemon by design, so leaked conhosts accumulate per kill.
 *      The patch serializes baton access behind a mutex, closes the exact HPCON
 *      before every baton deletion (the exit thread's included), and makes
 *      `kill(id)` return `true` only when it found and closed that exact handle —
 *      the positive proof `src/session-host/windows-conpty.ts` requires.
 *      (Adapted from the material-nodeterm fork's PR #448 branch; anchors verified
 *      against the pristine 1.1.0 sources, native behavior not yet re-measured on
 *      a Windows device by us — see the PR's device checklist.)
 *
 * WHY A SCRIPT AND NOT patch-package: patch-package is not a dependency of this
 * repo and adding one would require an `npm install` against a node_modules
 * tree that is shared with live dev sessions. This script needs no install: it
 * is a guarded, idempotent text patch wired into `postinstall` (and `rebuild`)
 * ahead of electron-rebuild, so the native module is always compiled from
 * patched sources.
 *
 * PROPERTIES
 *   - Idempotent: re-running is a no-op (detected via the per-file patch markers).
 *   - Verifiable: if any anchor is missing (e.g. after a node-pty upgrade that
 *     reshapes these functions) the script exits non-zero and explains what to do
 *     rather than silently producing an unpatched build.
 *   - Cross-platform safe: both source files ship in every install; the unix
 *     block is inside `#if defined(__APPLE__)` and conpty.cc only compiles for
 *     the win32 native target, so patching on Linux/CI is harmless and keeps
 *     packaged rebuilds honest on every host.
 *
 * REMOVAL CONDITION
 *   Delete each leg (its EDITS block, marker and test assertions) as soon as we
 *   upgrade to a node-pty release that carries the corresponding fix upstream —
 *   the darwin leg tracks microsoft/node-pty#950; the Windows leg has no upstream
 *   issue yet. The guard test in src/main/node-pty-patch.test.ts will fail loudly
 *   if a node-pty upgrade silently drops either patch, which is the signal to
 *   check whether the fix landed upstream.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const ptyDir = path.join(repoRoot, 'node_modules', 'node-pty');
const ptyCc = path.join(ptyDir, 'src', 'unix', 'pty.cc');
const conptyCc = path.join(ptyDir, 'src', 'win', 'conpty.cc');

export const PATCH_MARKER = 'NODETERM-PATCH(node-pty#950)';
export const WINDOWS_CONPTY_PATCH_MARKER = 'NODETERM-PATCH(node-pty-conpty-exact-close)';
const ISSUE_URL = 'https://github.com/microsoft/node-pty/issues/950';
const EXPECTED_VERSION = '1.1.0';

/** Anchor -> replacement. Every anchor must match exactly once. */
export const EDITS = [
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

/** Anchor -> replacement for src/win/conpty.cc. Every anchor must match exactly once. */
export const WINDOWS_EDITS = [
  {
    name: 'ConPTY baton lifetime, exact close, and synchronization',
    find: `#include <sstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>
#include <Windows.h>
#include <strsafe.h>
#include "path_util.h"
#include "conpty.h"

// Taken from the RS5 Windows SDK, but redefined here in case we're targeting <= 17134
#ifndef PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
#define PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE \\
  ProcThreadAttributeValue(22, FALSE, TRUE, FALSE)

typedef VOID* HPCON;
typedef HRESULT (__stdcall *PFNCREATEPSEUDOCONSOLE)(COORD c, HANDLE hIn, HANDLE hOut, DWORD dwFlags, HPCON* phpcon);
typedef HRESULT (__stdcall *PFNRESIZEPSEUDOCONSOLE)(HPCON hpc, COORD newSize);
typedef HRESULT (__stdcall *PFNCLEARPSEUDOCONSOLE)(HPCON hpc);
typedef void (__stdcall *PFNCLOSEPSEUDOCONSOLE)(HPCON hpc);
typedef void (__stdcall *PFNRELEASEPSEUDOCONSOLE)(HPCON hpc);

#endif

struct pty_baton {
  int id;
  HANDLE hIn;
  HANDLE hOut;
  HPCON hpc;

  HANDLE hShell;

  pty_baton(int _id, HANDLE _hIn, HANDLE _hOut, HPCON _hpc) : id(_id), hIn(_hIn), hOut(_hOut), hpc(_hpc) {};
};

static std::vector<std::unique_ptr<pty_baton>> ptyHandles;
static volatile LONG ptyCounter;

static pty_baton* get_pty_baton(int id) {
  auto it = std::find_if(ptyHandles.begin(), ptyHandles.end(), [id](const auto& ptyHandle) {
    return ptyHandle->id == id;
  });
  if (it != ptyHandles.end()) {
    return it->get();
  }
  return nullptr;
}

static bool remove_pty_baton(int id) {
  auto it = std::remove_if(ptyHandles.begin(), ptyHandles.end(), [id](const auto& ptyHandle) {
    return ptyHandle->id == id;
  });
  if (it != ptyHandles.end()) {
    ptyHandles.erase(it);
    return true;
  }
  return false;
}`,
    replace: `#include <sstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>
#include <mutex>
#include <Windows.h>
#include <strsafe.h>
#include "path_util.h"
#include "conpty.h"

// Taken from the RS5 Windows SDK, but redefined here in case we're targeting <= 17134
#ifndef PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
#define PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE \\
  ProcThreadAttributeValue(22, FALSE, TRUE, FALSE)

typedef VOID* HPCON;
typedef HRESULT (__stdcall *PFNCREATEPSEUDOCONSOLE)(COORD c, HANDLE hIn, HANDLE hOut, DWORD dwFlags, HPCON* phpcon);
typedef HRESULT (__stdcall *PFNRESIZEPSEUDOCONSOLE)(HPCON hpc, COORD newSize);
typedef HRESULT (__stdcall *PFNCLEARPSEUDOCONSOLE)(HPCON hpc);
typedef void (__stdcall *PFNCLOSEPSEUDOCONSOLE)(HPCON hpc);
typedef void (__stdcall *PFNRELEASEPSEUDOCONSOLE)(HPCON hpc);

#endif

struct pty_baton {
  int id;
  HANDLE hIn;
  HANDLE hOut;
  HPCON hpc;
  PFNCLOSEPSEUDOCONSOLE closePseudoConsole;

  HANDLE hShell = nullptr;

  pty_baton(int _id, HANDLE _hIn, HANDLE _hOut, HPCON _hpc, PFNCLOSEPSEUDOCONSOLE _closePseudoConsole) :
      id(_id), hIn(_hIn), hOut(_hOut), hpc(_hpc), closePseudoConsole(_closePseudoConsole) {};

  // ${WINDOWS_CONPTY_PATCH_MARKER}: callers hold g_ptyHandlesMutex. Exchange the handle before
  // ClosePseudoConsole can signal hShell, so the exit callback can never double-close it.
  bool closeExactPseudoConsole() {
    if (hpc == nullptr || closePseudoConsole == nullptr) {
      return false;
    }
    HPCON exact = hpc;
    hpc = nullptr;
    closePseudoConsole(exact);
    return true;
  }
};

static std::vector<std::unique_ptr<pty_baton>> ptyHandles;
static std::mutex g_ptyHandlesMutex;
static volatile LONG ptyCounter;

// The scoped-lock parameter makes the ownership precondition impossible to omit accidentally.
static pty_baton* get_pty_baton(const std::lock_guard<std::mutex>&, int id) {
  auto it = std::find_if(ptyHandles.begin(), ptyHandles.end(), [id](const auto& ptyHandle) {
    return ptyHandle->id == id;
  });
  if (it != ptyHandles.end()) {
    return it->get();
  }
  return nullptr;
}

static bool remove_pty_baton(const std::lock_guard<std::mutex>&, int id) {
  auto it = std::remove_if(ptyHandles.begin(), ptyHandles.end(), [id](const auto& ptyHandle) {
    return ptyHandle->id == id;
  });
  if (it != ptyHandles.end()) {
    ptyHandles.erase(it);
    return true;
  }
  return false;
}`
  },
  {
    name: 'close exact HPCON before shell-exit baton deletion',
    find: `    // Wait for process to complete.
    WaitForSingleObject(baton->hShell, INFINITE);
    // Get process exit code.
    GetExitCodeProcess(baton->hShell, (LPDWORD)(&exit_event->exit_code));
    // Clean up handles
    CloseHandle(baton->hShell);
    assert(remove_pty_baton(baton->id));`,
    replace: `    // Wait for process to complete.
    WaitForSingleObject(baton->hShell, INFINITE);
    {
      std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);
      // ${WINDOWS_CONPTY_PATCH_MARKER}: a taskkill-first teardown reaches this thread before JS can
      // call kill(id). Close the exact HPCON while its baton still exists, then delete the baton.
      baton->closeExactPseudoConsole();
      // Get process exit code.
      GetExitCodeProcess(baton->hShell, (LPDWORD)(&exit_event->exit_code));
      // Clean up handles
      CloseHandle(baton->hShell);
      assert(remove_pty_baton(lock, baton->id));
    }`
  },
  {
    name: 'resolve exact close primitive before ConPTY creation',
    find: `  HPCON hpc;
  HRESULT hr = CreateNamedPipesAndPseudoConsole(info, {cols, rows}, inheritCursor ? 1/*PSEUDOCONSOLE_INHERIT_CURSOR*/ : 0, &hIn, &hOut, &hpc, inName, outName, pipeName, useConptyDll);`,
    replace: `  HANDLE closeLibrary = LoadConptyDll(info, useConptyDll);
  PFNCLOSEPSEUDOCONSOLE const closePseudoConsole = closeLibrary == nullptr ? nullptr :
    (PFNCLOSEPSEUDOCONSOLE)GetProcAddress(
      (HMODULE)closeLibrary,
      useConptyDll ? "ConptyClosePseudoConsole" : "ClosePseudoConsole");
  if (closePseudoConsole == nullptr) {
    throw errorWithCode(info, "Cannot resolve exact pseudoconsole close primitive");
  }

  HPCON hpc;
  HRESULT hr = CreateNamedPipesAndPseudoConsole(info, {cols, rows}, inheritCursor ? 1/*PSEUDOCONSOLE_INHERIT_CURSOR*/ : 0, &hIn, &hOut, &hpc, inName, outName, pipeName, useConptyDll);`
  },
  {
    name: 'synchronize new ConPTY baton insertion',
    find: `    ptyHandles.emplace_back(
        std::make_unique<pty_baton>(ptyId, hIn, hOut, hpc));`,
    replace: `    std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);
    ptyHandles.emplace_back(
        std::make_unique<pty_baton>(ptyId, hIn, hOut, hpc, closePseudoConsole));`
  },
  {
    name: 'synchronize ConPTY connect lookup',
    find: `  // Fetch pty handle from ID and start process
  pty_baton* handle = get_pty_baton(id);
  if (!handle) {
    throw Napi::Error::New(env, "Invalid pty handle");
  }`,
    replace: `  // Fetch pty handle from ID and start process. This baton has no exit callback yet,
  // so it remains alive after the lookup lock is released.
  pty_baton* handle;
  {
    std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);
    handle = get_pty_baton(lock, id);
    if (!handle) {
      throw Napi::Error::New(env, "Invalid pty handle");
    }
  }`
  },
  {
    name: 'synchronize ConPTY resize',
    find: `  SHORT rows = static_cast<SHORT>(info[2].As<Napi::Number>().Uint32Value());
  const bool useConptyDll = info[3].As<Napi::Boolean>().Value();

  const pty_baton* handle = get_pty_baton(id);

  if (handle != nullptr) {
    HANDLE hLibrary = LoadConptyDll(info, useConptyDll);`,
    replace: `  SHORT rows = static_cast<SHORT>(info[2].As<Napi::Number>().Uint32Value());
  const bool useConptyDll = info[3].As<Napi::Boolean>().Value();

  std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);
  const pty_baton* handle = get_pty_baton(lock, id);

  if (handle != nullptr && handle->hpc != nullptr) {
    HANDLE hLibrary = LoadConptyDll(info, useConptyDll);`
  },
  {
    name: 'synchronize ConPTY clear',
    find: `  if (!useConptyDll) {
    return env.Undefined();
  }

  const pty_baton* handle = get_pty_baton(id);

  if (handle != nullptr) {
    HANDLE hLibrary = LoadConptyDll(info, useConptyDll);`,
    replace: `  if (!useConptyDll) {
    return env.Undefined();
  }

  std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);
  const pty_baton* handle = get_pty_baton(lock, id);

  if (handle != nullptr && handle->hpc != nullptr) {
    HANDLE hLibrary = LoadConptyDll(info, useConptyDll);`
  },
  {
    name: 'make ConPTY kill exact and positively acknowledged',
    find: `  const pty_baton* handle = get_pty_baton(id);

  if (handle != nullptr) {
    HANDLE hLibrary = LoadConptyDll(info, useConptyDll);
    bool fLoadedDll = hLibrary != nullptr;
    if (fLoadedDll)
    {
      PFNCLOSEPSEUDOCONSOLE const pfnClosePseudoConsole = (PFNCLOSEPSEUDOCONSOLE)GetProcAddress(
        (HMODULE)hLibrary,
        useConptyDll ? "ConptyClosePseudoConsole" : "ClosePseudoConsole");
      if (pfnClosePseudoConsole)
      {
        pfnClosePseudoConsole(handle->hpc);
      }
    }
    if (useConptyDll) {
      TerminateProcess(handle->hShell, 1);
    }
  }

  return env.Undefined();`,
    replace: `  bool closed = false;
  {
    std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);
    pty_baton* handle = get_pty_baton(lock, id);

    if (handle != nullptr) {
      // ${WINDOWS_CONPTY_PATCH_MARKER}: unlike stock 1.1.0's void result, true is positive proof
      // that this exact baton existed and its one HPCON was synchronously closed.
      closed = handle->closeExactPseudoConsole();
      if (useConptyDll && handle->hShell != nullptr) {
        TerminateProcess(handle->hShell, 1);
      }
    }
  }

  return Napi::Boolean::New(env, closed);`
  }
];

function fail(msg) {
  console.error(`\n[patch-node-pty] ERROR: ${msg}\n`);
  console.error(`  Patch script : scripts/patch-node-pty.mjs`);
  console.error(`  Darwin bug   : ${ISSUE_URL}`);
  console.error(`  Windows bug  : node-pty 1.1.0 ConPTY baton deletion before HPCON close`);
  console.error(
    `  If node-pty was upgraded: check whether the corresponding fix landed upstream. If it did,\n` +
      `  delete that leg (its EDITS block, marker and test assertions) — and the whole script once\n` +
      `  both legs are upstream. If it did not, re-derive the anchors against the new sources.\n`
  );
  process.exit(1);
}

/** Apply one file's edits; returns false when the marker shows they are already applied.
 * The path is resolved exactly ONCE (`open`), and the read, the marker check and the write all
 * go through that same descriptor — there is no exists/stat probe for the file to change under
 * (CodeQL js/file-system-race). A missing source is the open's own ENOENT. */
function patchOne(file, marker, edits) {
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      fail(`required node-pty source is missing:\n  ${file}`);
    }
    fail(`cannot open node-pty source for patching (${e?.code ?? e}):\n  ${file}`);
  }
  try {
    const original = fs.readFileSync(fd, 'utf8');
    if (original.includes(marker)) {
      return false;
    }

    let patched = original;
    for (const edit of edits) {
      const occurrences = patched.split(edit.find).length - 1;
      if (occurrences !== 1) {
        fail(
          `anchor "${edit.name}" matched ${occurrences} times (expected exactly 1) in\n  ${file}`
        );
      }
      patched = patched.replace(edit.find, edit.replace);
    }

    // Rewrite through the SAME descriptor. `writeFileSync(fd, …)` writes at the CURRENT position
    // (end-of-file after the read above), so it cannot be used here; truncate then write from an
    // explicit offset 0, looping because a sync write on a regular file may still be partial.
    const bytes = Buffer.from(patched, 'utf8');
    fs.ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    }
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

function main() {
  // No exists() probe (CodeQL js/file-system-race): whether node-pty is installed at all is
  // answered by the package.json read's own ENOENT — node-pty is optional in some install
  // shapes (e.g. docs-only CI installs), and an install without a package.json cannot exist.
  let installedVersion = 'unknown';
  try {
    installedVersion = JSON.parse(
      fs.readFileSync(path.join(ptyDir, 'package.json'), 'utf8')
    ).version;
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      console.log('[patch-node-pty] node-pty sources not present, nothing to patch.');
      return;
    }
    /* unreadable/unparsable for another reason — fall through; the anchor check is the guard */
  }

  if (installedVersion !== EXPECTED_VERSION) {
    console.warn(
      `[patch-node-pty] note: expected node-pty ${EXPECTED_VERSION}, found ${installedVersion}. ` +
        `Verifying anchors anyway.`
    );
  }

  const applied = [];
  if (patchOne(ptyCc, PATCH_MARKER, EDITS)) applied.push('darwin fd-leak (src/unix/pty.cc)');
  if (patchOne(conptyCc, WINDOWS_CONPTY_PATCH_MARKER, WINDOWS_EDITS)) {
    applied.push('Windows exact ConPTY close (src/win/conpty.cc)');
  }
  if (applied.length === 0) {
    console.log(`[patch-node-pty] already applied (node-pty ${installedVersion}), skipping.`);
  } else {
    console.log(`[patch-node-pty] applied to node-pty ${installedVersion}: ${applied.join('; ')}`);
  }
}

// Only patch when executed directly (`node scripts/patch-node-pty.mjs`), never as
// a side effect of importing this module.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
