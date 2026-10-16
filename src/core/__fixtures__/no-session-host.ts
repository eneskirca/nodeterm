/**
 * A `vi.mock` factory that forces `pty-manager` off the session-host backend.
 *
 * WHY THIS EXISTS. `spawnSession` picks its persistence backend in the order
 * **tmux -> session host -> plain shell**. The session-host branch is taken when tmux is absent
 * (always true on Windows) AND `sessionHostSupported()` is true — and that probe answers nothing
 * more than "is `out/session-host/host.cjs` on disk". So merely having run `npm run build` flips
 * every suite that mocks `node-pty` and expects the plain-shell path: the mocked `spawn` is never
 * called, a real `SessionHostPty` shim is constructed instead, it never connects, and the suite
 * fails with `Cannot read properties of undefined (reading 'killed')` and 5s timeouts. One file
 * went from 78 passing in 2.8s to 73 failing in 355s purely because a build artifact appeared.
 *
 * A suite that cares which backend it exercises must therefore SAY SO rather than inherit whatever
 * the machine happens to have built — the same reasoning that makes `pty-bundled-tmux.test.ts` pin
 * `os.platform()` to darwin instead of trusting the host.
 *
 * This lives in one place on purpose: the mock has to name every export of
 * `./session-host-backend`, and four copies of that list would drift the first time an export is
 * added — the new export would be `undefined` in three suites and fail somewhere unrelated.
 *
 * Usage, at the top of a suite (the path is relative to the TEST file, not to this fixture):
 *
 *     vi.mock('./session-host-backend', async () =>
 *       (await import('./__fixtures__/no-session-host')).noSessionHost()
 *     )
 *
 * Do NOT use this in a suite that is actually testing the session host — that backend has, and
 * needs, its own coverage.
 */
export function noSessionHost(): Record<string, unknown> {
  return {
    // The gate itself: false means `spawnSession` falls through to the plain-shell branch.
    sessionHostSupported: () => false,
    // Never reachable while `sessionHostSupported()` is false. Throwing rather than returning a
    // dummy makes a future regression in the branch condition fail loudly and locally, instead of
    // handing the caller a stub pty that misbehaves somewhere further away.
    createSessionHostPty: () => {
      throw new Error(
        'session-host backend was selected in a suite that mocked it out — the backend-selection ' +
          'branch in pty-manager.spawnSession has changed; see src/core/__fixtures__/no-session-host.ts'
      )
    },
    // The remaining exports are only called for a session that was already created on this
    // backend, which cannot happen here. They resolve to benign empties so that an incidental
    // call (e.g. a broad sweep over all sessions) cannot throw and mask the real assertion.
    sessionHostCapture: async () => '',
    sessionHostHasSession: async () => false,
    sessionHostKillSession: async () => {},
    sessionHostListSessions: async () => [],
    sessionHostPaneCommand: async () => null,
    sessionHostSendKeys: async () => false,
    sessionHostCaptureVisible: async () => null,
    sessionHostPaneCwd: async () => null,
    sessionHostSupportsWatch: async () => false,
    sessionHostWatchKnown: () => undefined,
    sessionHostListSessionsDetailed: async () => null,
    sessionHostMessageOwner: async () => null,
    sessionHostMessagePasteReady: async () => false,
    sessionHostMessageEnvelope: async () => false,
    sessionHostTerminateOwner: async () => 'unsupported',
    sessionHostWriteDetached: async () => false,
    // Error classes are read by `instanceof` checks on catch paths; a fresh class never matches.
    SessionHostProtocolCompatibilityError: class extends Error {},
    SessionHostWatchUnsupportedError: class extends Error {},
    sessionHostMouseTracking: async () => null,
    sessionHostExecuteLaunch: async () => {
      throw new Error('session-host launch in a suite that mocked the backend out')
    }
  }
}
