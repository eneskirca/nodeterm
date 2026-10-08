// Bundles host-fixture.ts for InteropHarness.kt through esbuild's JS API, so the harness only ever
// spawns `node` (audit A70).
//
// Usage (cwd = the repo root): node bundle-fixture.cjs <outfile> <electron stub, repo-relative> [entry]
//
// Why not the `esbuild` command: `node_modules/.bin/esbuild` is an npm shim, and on Windows the
// extensionless one is a sh script beside esbuild.cmd. CreateProcess (what Java's ProcessBuilder
// uses) runs neither, so bundling threw an IOException and every interop test errored on Windows
// instead of running. Why not `node node_modules/esbuild/bin/esbuild` either: esbuild's install
// script replaces that JS file with the native executable on Linux and macOS (skipped only under
// `--ignore-scripts` or yarn), and node cannot run a native executable. The JS API resolves the
// platform's esbuild binary itself on every OS.
//
// The options are the ones the harness used to pass on the command line, one for one: `electron`
// aliased to the stub (audit A60), `ws` external (it resolves from the repo's node_modules at run
// time), and the repo's two path aliases. Relative alias targets resolve against the cwd, as they did
// for the CLI.
//
// It also writes esbuild's metafile beside the bundle, as `<outfile>.meta.json`: the repo files the
// bundle was built from. WorkflowPathFilterTest checks that the Android workflow's path filters
// cover every one of them (audit A63).
'use strict'
const fs = require('fs')
const path = require('path')

const [outfile, electronStub, entry = 'android/protocol/src/test/interop/host-fixture.ts'] = process.argv.slice(2)
if (!outfile || !electronStub) {
  console.error('usage: node bundle-fixture.cjs <outfile> <electron stub, repo-relative> [entry]')
  process.exit(2)
}

const root = process.cwd()
// Resolved from the repo root, the tree whose node_modules the harness checked for esbuild.
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
// Only the managed-launch fixture runs the real PtyManager. Replace its native process boundary
// and login-PATH probe; virtualize os.homedir() so node tokens/accounts cannot touch a real profile.
// Settings/trust/workspace/host handlers are the production implementations, never aliases.
const projectLaunch = entry === 'android/protocol/src/test/interop/project-launch-fixture.ts'
const managedSession = entry === 'android/protocol/src/test/interop/managed-session-fixture.ts'
const serverProfile = entry === 'android/protocol/src/test/interop/server-profile-fixture.ts'
const serverProfilePlugin = {
  name: 'isolated-server-profile-home',
  setup(build) {
    build.onResolve({ filter: /^(?:os|node:os)$/ }, (args) => {
      if (args.importer.endsWith('/server-profile-os.ts')) return
      return { path: path.join(root, 'android/protocol/src/test/interop/server-profile-os.ts') }
    })
  }
}
const launchSeams = {
  'os': 'launch-os.ts', 'node:os': 'launch-os.ts',
  'node-pty': 'launch-native.ts'
}
const launchPlugin = {
  name: 'isolated-managed-launch',
  setup(build) {
    build.onResolve({ filter: /^(?:os|node:os|node-pty|child_process|\.\/(?:exec-path|tmux-hint))$/ }, (args) => {
      if (args.importer.endsWith('/launch-os.ts')) return
      const managerPath = args.importer === path.join(root, 'src/core/pty-manager.ts') ||
        args.importer === path.join(root, 'src/core/tmux-hint.ts')
      const managerBoundary = managerPath && ['./exec-path', './tmux-hint', 'child_process'].includes(args.path)
      const nativeLeaf = managedSession ? 'managed-native.ts' : 'launch-native.ts'
      const leaf = args.path === 'node-pty' ? nativeLeaf :
        launchSeams[args.path] || (managerBoundary ? nativeLeaf : null)
      if (leaf) return { path: path.join(root, 'android/protocol/src/test/interop', leaf) }
    })
  }
}

esbuild
  .build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // A worktree may share cached dependencies through a node_modules symlink. Keep those
    // dependency inputs under the logical node_modules path for the repository-file scanner.
    preserveSymlinks: true,
    outfile: path.resolve(root, outfile),
    alias: {
      electron: './' + electronStub,
      '@shared': './src/shared',
      '@renderer': './src/renderer'
    },
    // Keep the genuine SSH package at runtime: its optional native acceleration modules are
    // allowed to be absent under the protocol fixture's npm ci --ignore-scripts contract.
    external: ['ws', 'esbuild', 'ssh2'],
    plugins: projectLaunch || managedSession ? [launchPlugin] : serverProfile ? [serverProfilePlugin] : [],
    metafile: true,
    logLevel: 'warning'
  })
  .then(async (result) => {
    if (entry === 'android/protocol/src/test/interop/host-fixture.ts') {
      // Actual standalone host producer, with only node-pty's native leaf recorded explicitly.
      const nativeHost = await esbuild.build({ absWorkingDir: root,
        entryPoints: ['src/session-host/host.ts'], bundle: true, platform: 'node', format: 'cjs',
        outfile: path.resolve(root, outfile) + '-composed-host.cjs', preserveSymlinks: true, metafile: true, logLevel: 'warning',
        plugins: [{ name: 'explicit-composed-native-recorder', setup(build) {
          build.onResolve({ filter: /^node-pty$/ }, () => ({
            path: path.join(root, 'src/session-host/__fixtures__/composed-native-recorder.ts') }))
        } }] })
      Object.assign(result.metafile.inputs, nativeHost.metafile.inputs)
    }
    fs.writeFileSync(path.resolve(root, outfile) + '.meta.json', JSON.stringify(result.metafile))
  })
  .catch((err) => {
    // A build failure: esbuild has already printed the errors (logLevel 'warning' includes them) to
    // stderr, which the harness folds into its failure message. Anything else (the metafile write)
    // has printed nothing yet.
    if (!err || !Array.isArray(err.errors)) console.error(err)
    process.exitCode = 1
  })
