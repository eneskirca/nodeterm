#!/usr/bin/env node
/**
 * Build the BUNDLED tmux that ships inside the macOS app (`<app>/Contents/Resources/bin/tmux`).
 *
 * WHY: without tmux on the machine the app silently degrades to a plain shell — terminals don't
 * survive a restart, the mobile companion can't attach, and a park/offscreen dispose kills the
 * shell AND whatever agent CLI is running in it instead of merely detaching a client (issue #126).
 * A tmux-less user could only fix that by installing tmux themselves. Shipping one removes the
 * whole failure class from the default install.
 *
 * PRECEDENCE (see src/core/tmux-hint.ts `bundledTmuxPath` and pty-manager's `findTmux`): the
 * SYSTEM tmux still wins; this binary is the LAST candidate. A tmux client must be able to talk to
 * the tmux SERVER already running on the user's machine, and pairing a newer bundled client with an
 * older running server fails outright ("server version is too old"). System-first means existing
 * tmux users see literally no change; the bundle only rescues the population that had none.
 *
 * The OUTPUT (resources/bin/tmux) is gitignored — this script is the source of truth. The release
 * job runs it before electron-builder, which copies it in via `extraResources`.
 *
 * Shape of the build: static libevent and static utf8proc (so the app never depends on a Homebrew
 * dylib that isn't there), ncurses taken dynamically from macOS itself (/usr/lib/libncurses.dylib
 * ships with the OS — vendoring terminfo would be a second, larger problem), one `lipo` pass to
 * make the two arch builds universal. No npm dependencies on purpose: node stdlib + the system
 * curl/cc/make/lipo, so the release runner needs nothing installed beyond the Xcode command line
 * tools — in particular no cmake, no autoconf, no pkg-config and no Rosetta.
 *
 * Usage: node scripts/build-tmux.mjs [--force] [--verbose]
 */

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Pins ────────────────────────────────────────────────────────────────────────────────────────
// Exact upstream releases, with the sha256 of each official tarball. Pinned rather than "latest"
// so a release build is reproducible and a compromised/rewritten upstream asset fails the build
// instead of shipping. Bump deliberately: change the version AND the hash together (recompute with
// `shasum -a 256 <tarball>` from the GitHub release page).
const TMUX_VERSION = '3.7b'
const TMUX_SHA256 = '87f2e99e3b685973f2ca002ffd6ed7e51a5744f7009daae5a15670b6d532db96'
const TMUX_URL = `https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz`

// libevent 2.1.13-stable is the current 2.1.x; it carries the 2026-07 security fixes (evhttp
// request smuggling, evtag OOB read, evbuffer dangling pointer). tmux only uses libevent_core,
// but the pin still tracks the fixed release.
const LIBEVENT_VERSION = '2.1.13-stable'
const LIBEVENT_SHA256 = 'f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c'
const LIBEVENT_URL = `https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_VERSION}/libevent-${LIBEVENT_VERSION}.tar.gz`

// utf8proc supplies the Unicode width/grapheme tables tmux uses for `--enable-utf8proc`. See the
// configure flag below for why it is worth a third vendored library.
const UTF8PROC_VERSION = '2.11.3'
const UTF8PROC_SHA256 = '415189fd2c85cd6ee5ff26af500fa387de9ada1e3e316e93f7338551481d557d'
const UTF8PROC_URL = `https://github.com/JuliaStrings/utf8proc/releases/download/v${UTF8PROC_VERSION}/utf8proc-${UTF8PROC_VERSION}.tar.gz`

/** Slices in the universal output, with the deployment target each is built against.
 *  arm64 cannot go below 11.0 (Apple Silicon did not exist before it); 10.15 keeps the Intel
 *  slice usable on every macOS the Intel app build still supports. */
const ARCHS = [
  { arch: 'arm64', triple: 'aarch64-apple-darwin', minOs: '11.0' },
  { arch: 'x86_64', triple: 'x86_64-apple-darwin', minOs: '10.15' }
]

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(repoRoot, 'resources', 'bin')
const outFile = path.join(outDir, 'tmux')
const licenseDir = path.join(repoRoot, 'resources', 'licenses')
/** Written next to the binary; its exact content is the "is the output already the pinned build?"
 *  test, so bumping a version above automatically invalidates a stale binary. */
const markerFile = path.join(outDir, '.tmux-build-version')
const MARKER = `tmux-${TMUX_VERSION} libevent-${LIBEVENT_VERSION} utf8proc-${UTF8PROC_VERSION} universal(${ARCHS.map((a) => a.arch).join('+')})\n`

const force = process.argv.includes('--force')
const verbose = process.argv.includes('--verbose')

function log(msg) {
  console.log(`[build-tmux] ${msg}`)
}

/** Run a command, failing loudly. Output is swallowed unless --verbose (a configure+make pair is
 *  thousands of lines of noise); on failure the tail of the captured output is printed, which is
 *  the part that says why. */
function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      stdio: verbose ? 'inherit' : 'pipe',
      encoding: 'utf8',
      ...opts
    })
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    if (out) console.error(out.split('\n').slice(-40).join('\n'))
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${err.status})`)
  }
}

/** Capture stdout of a command that is expected to succeed (verification steps). */
function capture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

function download(url, dest, expectedSha256) {
  log(`downloading ${path.basename(dest)}`)
  // --fail so an HTML error page never lands on disk as a "tarball"; -L follows the GitHub
  // release redirect to the asset CDN.
  run('curl', ['--fail', '--location', '--silent', '--show-error', '--output', dest, url])
  const actual = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex')
  if (actual !== expectedSha256) {
    throw new Error(
      `sha256 mismatch for ${url}\n  expected ${expectedSha256}\n  actual   ${actual}\n` +
        'Refusing to build. Either the pin is stale (bump the constant deliberately) or the ' +
        'asset changed under us.'
    )
  }
  log(`verified sha256 ${actual.slice(0, 16)}… ok`)
}

/**
 * Build libevent (static only) and then tmux against it, for ONE arch. Returns the path of the
 * single-arch tmux binary.
 *
 * The cross slice (whichever arch is not this machine's) is configured with `--host`, which puts
 * autoconf in cross-compile mode so it never tries to RUN a test binary — the release runner is
 * an Apple Silicon Mac that may not have Rosetta installed. tmux's three AC_RUN_IFELSE probes
 * (strtonum / reallocarray / recallocarray) all fall back to tmux's own compat implementations
 * when cross-compiling, which is the correct, portable answer anyway.
 */
function buildArch({ arch, triple, minOs }, work, tarballs) {
  // A FRESH extraction per arch, never a copy of one tree: `tar` restores the archive's mtimes,
  // and automake's maintainer rules compare configure.ac against configure. A recursive copy
  // rewrites those timestamps and the build then tries to re-run autoconf — which is not
  // installed on this machine or (deliberately) required on the release runner.
  const stage = path.join(work, `build-${arch}`)
  fs.mkdirSync(stage, { recursive: true })
  run('tar', ['-xzf', tarballs.libevent, '-C', stage])
  run('tar', ['-xzf', tarballs.utf8proc, '-C', stage])
  run('tar', ['-xzf', tarballs.tmux, '-C', stage])
  const evDir = path.join(stage, `libevent-${LIBEVENT_VERSION}`)
  const u8Dir = path.join(stage, `utf8proc-${UTF8PROC_VERSION}`)
  const tmuxDir = path.join(stage, `tmux-${TMUX_VERSION}`)

  const prefix = path.join(work, `prefix-${arch}`)
  const flags = `-arch ${arch} -mmacosx-version-min=${minOs}`
  const cross = arch !== (process.arch === 'arm64' ? 'arm64' : 'x86_64')
  const env = {
    ...process.env,
    CFLAGS: `${flags} -O2`,
    LDFLAGS: flags,
    // Hard off. If the runner happens to have pkg-config + a Homebrew libevent/ncurses installed,
    // tmux's configure would prefer those .pc files and link the bundled binary against
    // /opt/homebrew dylibs that do not exist on a user's machine. Without pkg-config configure
    // falls through to AC_SEARCH_LIBS, which sees only what our LDFLAGS point at (our static
    // libevent) plus the system libraries. The `otool -L` assertion at the end is the backstop.
    PKG_CONFIG: '/usr/bin/false',
    MACOSX_DEPLOYMENT_TARGET: minOs
  }
  const hostArg = cross ? [`--host=${triple}`] : []

  log(`building libevent (${arch})…`)
  run(
    './configure',
    [
      `--prefix=${prefix}`,
      '--disable-shared',
      '--enable-static',
      '--with-pic',
      // tmux needs libevent_core only; everything else is dead weight in the binary and extra
      // ways for the build to need a dependency the runner doesn't have (openssl, mbedtls).
      '--disable-openssl',
      '--disable-mbedtls',
      '--disable-samples',
      '--disable-libevent-regress',
      '--disable-debug-mode',
      ...hostArg
    ],
    { cwd: evDir, env }
  )
  run('make', [`-j${os.cpus().length}`], { cwd: evDir, env })
  run('make', ['install'], { cwd: evDir, env })

  log(`building utf8proc (${arch})…`)
  // utf8proc ships a plain Makefile as well as a CMakeLists — the Makefile route is used on
  // purpose so the release runner never needs cmake installed. `libutf8proc.a` is a target of its
  // own (the default `all` would also build a dylib), and the .a plus the header are placed into
  // our prefix BY HAND rather than with `make install`: that target insists on the dylib, and a
  // libutf8proc.dylib sitting in the prefix is exactly what the linker would then prefer, turning
  // the bundled tmux into something that needs a library the user does not have.
  run(
    'make',
    [`-j${os.cpus().length}`, 'libutf8proc.a', 'CC=cc', `CFLAGS=${flags} -O2`],
    { cwd: u8Dir, env }
  )
  fs.mkdirSync(path.join(prefix, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(prefix, 'include'), { recursive: true })
  fs.copyFileSync(
    path.join(u8Dir, 'libutf8proc.a'),
    path.join(prefix, 'lib', 'libutf8proc.a')
  )
  fs.copyFileSync(path.join(u8Dir, 'utf8proc.h'), path.join(prefix, 'include', 'utf8proc.h'))

  log(`building tmux (${arch})…`)
  // Point tmux at OUR libevent and nothing else: only the static .a lives in that prefix, so the
  // link is static with no -static flag and no chance of picking up a system libevent.dylib.
  const tmuxEnv = {
    ...env,
    CPPFLAGS: `-I${path.join(prefix, 'include')}`,
    LDFLAGS: `${flags} -L${path.join(prefix, 'lib')}`,
    // Pre-answer tmux's PKG_CHECK_MODULES for utf8proc. That macro is invoked with NO
    // action-if-not-found, so with pkg-config disabled it would abort configure outright
    // ("The pkg-config script could not be found") — but autoconf skips the pkg-config call
    // entirely when both <VAR>_CFLAGS and <VAR>_LIBS are already set, which is what these do.
    // Result: PKG_CONFIG stays neutralized AND tmux links the static lib we just built.
    LIBUTF8PROC_CFLAGS: `-I${path.join(prefix, 'include')}`,
    LIBUTF8PROC_LIBS: `-L${path.join(prefix, 'lib')} -lutf8proc`
  }
  run(
    './configure',
    [
      `--prefix=${prefix}`,
      // ON, and it must be stated explicitly: tmux 3.7's configure REFUSES to guess on macOS and
      // recommends this ("macOS library support for Unicode is very poor, particularly for complex
      // codepoints like emojis"). Without it, character widths come from macOS's own wcwidth,
      // whose tables predate modern emoji — a 2-cell emoji measured as 1 cell corrupts every line
      // drawn after it. What nodeterm's terminals mostly show is agent TUIs (Claude Code and
      // friends), which are emoji-dense and redraw boxes constantly, and the only people who ever
      // run THIS binary are those with no tmux of their own — they have no better copy to fall
      // back on. Homebrew's tmux enables it too, so this also keeps bundled and system tmux
      // rendering the same. The price is the third vendored library above: one more pinned
      // tarball to download, verify, cross-build statically and carry a license for.
      '--enable-utf8proc',
      ...hostArg
    ],
    { cwd: tmuxDir, env: tmuxEnv }
  )
  run('make', [`-j${os.cpus().length}`], { cwd: tmuxDir, env: tmuxEnv })

  const bin = path.join(work, `tmux-bin-${arch}`)
  fs.copyFileSync(path.join(tmuxDir, 'tmux'), bin)
  return bin
}

/** Copy the upstream license texts next to the binary's notices. tmux is ISC, libevent BSD-3 —
 *  both require the notice to travel with a redistributed binary, and these are tracked in git
 *  (unlike resources/bin) so the repo carries them even when nobody has run this script. */
function writeLicenses(sources) {
  fs.mkdirSync(licenseDir, { recursive: true })
  fs.copyFileSync(path.join(sources.tmux, 'COPYING'), path.join(licenseDir, 'tmux-COPYING.txt'))
  fs.copyFileSync(
    path.join(sources.libevent, 'LICENSE'),
    path.join(licenseDir, 'libevent-LICENSE.txt')
  )
  fs.copyFileSync(
    path.join(sources.utf8proc, 'LICENSE.md'),
    path.join(licenseDir, 'utf8proc-LICENSE.md')
  )
  log(`licenses refreshed in ${path.relative(repoRoot, licenseDir)}/`)
}

/** Every dylib the binary loads must come from macOS itself; anything under /opt/homebrew or
 *  /usr/local would be missing on a user's machine and the bundled tmux would fail to exec —
 *  the exact silent-degradation this whole feature removes. */
function assertNoForeignDylibs(file) {
  // On a universal binary otool prints one "<file> (architecture x86_64):" header per slice at
  // column 0 and each dependency INDENTED — so match the indented lines only, or the file's own
  // path reads as a dependency.
  const deps = [
    ...new Set(
      capture('otool', ['-L', file])
        .split('\n')
        .filter((l) => /^\s+\S+\s+\(compatibility version/.test(l))
        .map((l) => l.trim().split(' ')[0])
    )
  ]
  if (!deps.length) throw new Error(`otool -L reported no dependencies for ${file}`)
  const foreign = deps.filter((d) => !d.startsWith('/usr/lib/') && !d.startsWith('/System/'))
  if (foreign.length) {
    throw new Error(
      `bundled tmux links non-system libraries: ${foreign.join(', ')}\n` +
        'Those will not exist on a user machine. Check that PKG_CONFIG was disabled and that ' +
        'libevent built static.'
    )
  }
  log(`dylib deps are all system: ${deps.join(', ')}`)
}

/**
 * Prove utf8proc really got linked into BOTH slices — the decisive check, and the only one that
 * can speak for the cross slice at all (the runner may have no Rosetta to execute it with).
 * `_utf8proc_charwidth` is the exact symbol tmux's configure searches for, and `strip -S -x` keeps
 * global symbols, so it survives into the shipped binary as a defined (T) symbol.
 */
function assertUtf8procLinked(file) {
  for (const { arch } of ARCHS) {
    const defined = capture('nm', ['-arch', arch, file])
      .split('\n')
      .some((l) => / T _utf8proc_charwidth$/.test(l.trimEnd()))
    if (!defined) {
      throw new Error(
        `the ${arch} slice has no _utf8proc_charwidth — tmux was built without utf8proc, or the ` +
          'static lib was not picked up (check LIBUTF8PROC_CFLAGS/LIBUTF8PROC_LIBS).'
      )
    }
  }
  log('utf8proc is statically linked into both slices (_utf8proc_charwidth defined)')
}

/** Block the (single-threaded, already synchronous) build for `ms` — the pane below needs a beat
 *  to run its command before the capture can see the output. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * End-to-end proof that the binary actually runs a server: start one on a THROWAWAY socket, list
 * it, run the emoji check below, kill it. Never touches the app's own `node-terminal` socket.
 *
 * The emoji check exercises the width path end to end, which `tmux -V` cannot: a pane prints a
 * 2-cell emoji followed by two ASCII characters, and the cursor must end at column 4 — the
 * off-by-one this guards against is what smears every subsequent redraw in an agent TUI. It is a
 * BEHAVIORAL check, not proof that utf8proc is present (macOS's own wcwidth agrees about some
 * emoji, and about U+1F680 on current macOS); `assertUtf8procLinked` is the proof.
 */
function smokeTest(file) {
  const sock = `nodeterm-bundle-test-${process.pid}`
  const EMOJI = '🚀'
  const tmux = (...args) =>
    capture(file, ['-L', sock, '-f', '/dev/null', '-u', ...args], {
      // -u plus a UTF-8 locale: the release runner's env may carry neither, and tmux decides
      // whether it is in UTF-8 mode from exactly these.
      env: { ...process.env, TMUX: '', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
    })
  try {
    tmux('new-session', '-d', '-s', 'smoke')
    const sessions = tmux('list-sessions')
    if (!/^smoke:/m.test(sessions)) throw new Error(`unexpected list-sessions output: ${sessions}`)
    log(`smoke: server started on -L ${sock}, list-sessions → ${sessions.trim()}`)

    tmux('new-session', '-d', '-s', 'emoji', `printf '${EMOJI}AB'; sleep 30`)
    let pane = ''
    for (let i = 0; i < 60 && !pane.includes(EMOJI); i++) {
      sleepSync(50)
      pane = tmux('capture-pane', '-p', '-t', 'emoji')
    }
    if (!pane.includes(`${EMOJI}AB`)) {
      throw new Error(`emoji did not survive the pane round-trip; capture-pane gave: ${pane}`)
    }
    const cursorX = tmux('display-message', '-p', '-t', 'emoji', '#{cursor_x}').trim()
    if (cursorX !== '4') {
      throw new Error(
        `emoji width is wrong: after "${EMOJI}AB" the cursor is at column ${cursorX}, expected 4. ` +
          'utf8proc is probably not linked in (macOS wcwidth measures the emoji as 1 cell).'
      )
    }
    log(`smoke: "${EMOJI}AB" round-tripped through a pane, cursor at column ${cursorX} (2+1+1) ok`)
  } finally {
    try {
      capture(file, ['-L', sock, 'kill-server'])
    } catch {
      // no server to kill (the start itself failed) — the real error is already propagating
    }
  }
}

function main() {
  if (process.platform !== 'darwin') {
    // The bundled binary is a macOS artifact by design: the Linux packages and the Server Edition
    // install tmux from the distro, where it is one `apt-get install` away and already expected.
    log(`nothing to do on ${process.platform} — the bundled tmux is a macOS-only artifact`)
    return
  }

  if (!force && fs.existsSync(outFile) && readMarker() === MARKER) {
    log(`up to date: ${path.relative(repoRoot, outFile)} is already ${MARKER.trim()} (--force to rebuild)`)
    return
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-tmux-'))
  try {
    const tmuxTar = path.join(work, `tmux-${TMUX_VERSION}.tar.gz`)
    const evTar = path.join(work, `libevent-${LIBEVENT_VERSION}.tar.gz`)
    const u8Tar = path.join(work, `utf8proc-${UTF8PROC_VERSION}.tar.gz`)
    download(TMUX_URL, tmuxTar, TMUX_SHA256)
    download(LIBEVENT_URL, evTar, LIBEVENT_SHA256)
    download(UTF8PROC_URL, u8Tar, UTF8PROC_SHA256)
    const tarballs = { tmux: tmuxTar, libevent: evTar, utf8proc: u8Tar }

    // One extra extraction, purely to lift the three license texts out of the pinned tarballs.
    const licenseSrc = path.join(work, 'licenses-src')
    fs.mkdirSync(licenseSrc, { recursive: true })
    run('tar', ['-xzf', tmuxTar, '-C', licenseSrc, `tmux-${TMUX_VERSION}/COPYING`])
    run('tar', ['-xzf', evTar, '-C', licenseSrc, `libevent-${LIBEVENT_VERSION}/LICENSE`])
    run('tar', ['-xzf', u8Tar, '-C', licenseSrc, `utf8proc-${UTF8PROC_VERSION}/LICENSE.md`])
    writeLicenses({
      tmux: path.join(licenseSrc, `tmux-${TMUX_VERSION}`),
      libevent: path.join(licenseSrc, `libevent-${LIBEVENT_VERSION}`),
      utf8proc: path.join(licenseSrc, `utf8proc-${UTF8PROC_VERSION}`)
    })

    const slices = ARCHS.map((a) => buildArch(a, work, tarballs))

    fs.mkdirSync(outDir, { recursive: true })
    // Write the marker only after the binary is in place and verified, so an interrupted run
    // leaves a "not built" state rather than a stale binary that claims to be current.
    fs.rmSync(markerFile, { force: true })
    run('lipo', ['-create', '-output', outFile, ...slices])
    run('strip', ['-S', '-x', outFile])
    fs.chmodSync(outFile, 0o755)

    log(`file: ${capture('file', [outFile]).trim()}`)
    log(`lipo: ${capture('lipo', ['-info', outFile]).trim()}`)
    const missing = ARCHS.map((a) => a.arch).filter(
      (a) => !capture('lipo', ['-info', outFile]).includes(a)
    )
    if (missing.length) throw new Error(`universal binary is missing slices: ${missing.join(', ')}`)
    assertNoForeignDylibs(outFile)
    assertUtf8procLinked(outFile)

    // -V runs the NATIVE slice; the cross slice is verified structurally (lipo/otool) because the
    // runner may have no Rosetta to execute it with.
    const version = capture(outFile, ['-V']).trim()
    if (version !== `tmux ${TMUX_VERSION}`) {
      throw new Error(`built binary reports "${version}", expected "tmux ${TMUX_VERSION}"`)
    }
    log(`version: ${version}`)
    smokeTest(outFile)

    fs.writeFileSync(markerFile, MARKER)
    log(`done → ${path.relative(repoRoot, outFile)}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

function readMarker() {
  try {
    return fs.readFileSync(markerFile, 'utf8')
  } catch {
    return null
  }
}

main()
