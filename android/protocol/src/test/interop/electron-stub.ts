// Stand-in for the `electron` package in the Android interop fixture. InteropHarness.kt bundles
// host-fixture.ts with `--alias:electron=<this file>`, so the bundle never `require`s the real one.
//
// Why (audit A60): host-service.ts, host-identity.ts and host-canvas-hub.ts import `electron` at the
// top. Outside Electron, `require('electron')` runs the npm package's index.js, which returns the PATH
// of the Electron binary and, when that binary is missing, first downloads it synchronously: about
// 110 MB from GitHub releases, inside the harness's 20 s wait for the fixture's ready line. The package
// has no install script, so every fresh `npm ci` (a CI runner) lacks the binary; a slow or failed
// download then failed every interop test with a timeout.
//
// The fixture injects everything those modules would otherwise take from Electron (the pty, the
// canvas feed, the host keys, the relay gate), so no member below is reached at run time. Under the
// real package every member was `undefined` here, so any use already failed; each member keeps that,
// but throws an error naming the member instead of a bare TypeError on `undefined`. A no-op would
// instead let a code path that started depending on Electron pass silently (`app.isPackaged` would
// read as a plain falsy value, `ipcMain.on` would register nothing).
//
// Export every member that a src/main module the fixture reaches imports from 'electron'; between
// them the src/main/remote files import these four (plus types, which esbuild erases). A missing one
// fails the esbuild step with "No matching export", which is the intended signal: add it here, do not
// reach for the real package.

function unavailable(member: string): never {
  throw new Error(
    `electron.${member} is not available in the Android interop fixture ` +
      '(android/protocol/src/test/interop/electron-stub.ts): inject the dependency into the desktop code instead'
  )
}

function stub(name: string): Record<string, unknown> {
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, prop) {
      // Symbol keys (util.inspect, Symbol.toPrimitive) and `then` (a stray `await`) are probes, not uses.
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      return unavailable(`${name}.${prop}`)
    },
    set(_target, prop) {
      return unavailable(`${name}.${String(prop)}`)
    }
  })
}

export const app = stub('app')
export const ipcMain = stub('ipcMain')
export const safeStorage = stub('safeStorage')
export const dialog = stub('dialog')
