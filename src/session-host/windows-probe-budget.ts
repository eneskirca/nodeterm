// The deadlines of the Windows pane probe, in one dependency-free leaf so the core's outer budget
// (`WINDOWS_PANE_PROBE_TIMEOUT_MS`, core/agents/pane-probe.ts) can be derived from them without
// pulling child_process into the agent-messaging module graph.

/** Deadline for the first request after the probe worker spawns: PowerShell startup + the
 *  one-time Add-Type compile (windows-probe-worker.ts). */
export const PROBE_FIRST_REQUEST_TIMEOUT_MS = 6000

/** Deadline of the one-shot powershell.exe `readWindowsConsoleOwner` falls back to when the worker
 *  cannot answer (windows-pane-owner.ts). */
export const WINDOWS_ONESHOT_PROBE_TIMEOUT_MS = 4000
