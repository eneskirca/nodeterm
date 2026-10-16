// Prepare-for-update (issue #829, step 2): the wire shapes between the desktop main process and
// the renderer's prepare flow. Windows only — there the session host outlives the app by design
// and holds the install directory, so the installer's preflight refuses to run until it is gone.
// The flow ends every session through the host's own `shutdown` command (never a name-based kill,
// never node deletion) after giving each idle agent a chance to exit cleanly.

/** What the running host holds right now. Asked without ever launching a host. */
export type UpdatePrepInspection =
  /** Not Windows, or the session-host backend is not the one this app uses. */
  | { kind: 'unsupported' }
  /** No host is running: nothing holds the install directory on its behalf. */
  | { kind: 'no-host' }
  | {
      kind: 'host'
      /** Host session names (`nt-<nodeId>`), every project's — closed ones included. */
      sessions: string[]
      /** The host speaks `shutdown`. False for a host started by an older build, which must be
       *  handled by the manual steps — the app never kills a host by itself. */
      shutdownSupported: boolean
      /** Core's status mirror per session: the only state source for nodes whose project is not
       *  on screen (an unmounted node's renderer state is cleared). `attention` = an unanswered
       *  question or approval ticket is held. */
      mirror: Record<string, { state?: string; attention: boolean }>
      /** The host runs from its staged copy outside the installation (0.4.1+), so it does not
       *  block the installer: quitting nodeterm — from the tray too — is enough, and sessions keep
       *  running. False for a legacy/install-dir host AND for one whose location is unknown. */
      staged: boolean
    }
  | { kind: 'error'; error: string }

export type UpdatePrepShutdown =
  | { kind: 'unsupported' }
  | { kind: 'no-host' }
  /** The host ended every session and its process exited. */
  | { kind: 'shut-down'; ended: string[] }
  /** The host answered that it could not end some sessions; it is still running and serving. */
  | { kind: 'failed'; error: string }
  /** No answer we can trust (timeout, lost connection, host still alive after its reply). */
  | { kind: 'unconfirmed'; error: string }
  /** The host predates the `shutdown` feature. */
  | { kind: 'host-unsupported' }

/** The steps for a STAGED host: nothing has to stop. Kept beside the legacy steps so the dialog,
 *  the installer text and the docs say the same thing. */
export const STAGED_UPDATE_STEPS: readonly string[] = [
  'Quit nodeterm — if it keeps running in the system tray, right-click the tray icon and choose Quit.',
  'Run the installer. Your sessions keep running in the background session host and reattach when nodeterm starts again.',
  'Only if the installer still says nodeterm is running: reopen nodeterm and use Prepare for update to stop the sessions.'
]

/** The manual steps, for a host that cannot shut itself down (or did not confirm it did). Kept in
 *  one place so the dialog and the docs say the same thing. */
export const MANUAL_UPDATE_STEPS: readonly string[] = [
  'Save work in every terminal and agent, and exit each program and its shell normally. Do not use End session or delete nodes — those remove the nodes.',
  'Quit nodeterm and wait at least 30 seconds: an empty session host shuts itself down.',
  'If nodeterm-session-host.exe is still running, open Task Manager → Details, verify it is this installation’s host for your user, and end only that process (every process it owns stops).',
  'Run the installer. Your canvas nodes stay; agents resume from their saved conversations on the next launch.'
]
