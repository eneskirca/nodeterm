import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ManagedPaneReceipt } from '../shared/managed-terminal'
import { MANAGED_CREATION_ENV, MANAGED_CREATION_UUID } from '../shared/managed-terminal'
import { pasteBufferName, TMUX_SOCKET } from './tmux-naming'

export const MANAGED_PANE_FORMAT = '#{session_name}|#{session_created}|#{pane_id}|#{pane_pid}|#{' + MANAGED_CREATION_ENV + '}'

/** Require one pane in the whole session; a selected window is insufficient. */
export function parseManagedPane(raw: string, expected: Pick<ManagedPaneReceipt, 'creationId' | 'session'>):
  Pick<ManagedPaneReceipt, 'sessionCreated' | 'paneId' | 'panePid'> | null {
  const rows = raw.trim().split('\n')
  if (rows.length !== 1) return null
  const [session, created, pane, pid, creation, ...extra] = rows[0].split('|')
  if (extra.length || session !== expected.session || creation !== expected.creationId ||
      !/^[1-9][0-9]*$/.test(created) || !/^%[0-9]+$/.test(pane) || !/^[1-9][0-9]*$/.test(pid)) return null
  const panePid = Number(pid)
  if (!Number.isSafeInteger(panePid)) return null
  return { sessionCreated: created, paneId: pane, panePid }
}

/** /proc comm may itself contain ')' or spaces. Field 22 follows the FINAL closing parenthesis. */
export function linuxManagedBirth(stat: string, boot: string): string | null {
  const close = stat.lastIndexOf(')')
  const ticks = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/)[19] : undefined
  if (!ticks || !/^[0-9]+$/.test(ticks) || !/^[0-9a-f-]{36}$/.test(boot.trim())) return null
  return `linux:${boot.trim()}:${ticks}`
}

export async function readManagedProcessBirth(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid managed pane process')
  if (process.platform === 'linux') {
    const [stat, boot] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, 'utf8'), fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')
    ])
    const birth = linuxManagedBirth(stat, boot)
    if (!birth) throw new Error('Could not attest the managed pane process')
    return birth
  }
  if (process.platform === 'darwin') {
    const { stdout } = await promisify(execFile)('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 1500, env: { ...process.env, LC_ALL: 'C' } })
    const value = stdout.trim().replace(/\s+/g, ' ')
    if (!/^[A-Za-z]{3} [A-Za-z]{3} [0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/.test(value))
      throw new Error('Could not attest the managed pane process')
    return `darwin:${value}`
  }
  throw new Error('Managed SSH creation requires Linux or macOS tmux')
}

export function sameManagedPane(a: ManagedPaneReceipt, b: ManagedPaneReceipt): boolean {
  return a.version === b.version && a.creationId === b.creationId && a.nodeId === b.nodeId &&
    a.projectId === b.projectId && a.socket === b.socket && a.session === b.session &&
    a.paneId === b.paneId && a.panePid === b.panePid && a.paneBirth === b.paneBirth &&
    a.sessionCreated === b.sessionCreated
}

/** The create-only flag is passed privately through normal spawn policy, never as a wire option. */
export function managedCreateFlags(creationId: string): string[] {
  if (!MANAGED_CREATION_UUID.test(creationId)) throw new Error('Invalid managed creation id')
  return ['-e', `${MANAGED_CREATION_ENV}=${creationId}`]
}

/** A single tmux queue owns the final identity gate, paste and Enter. Text travels on stdin.
 * The receipt's process birth is separately re-read by the host immediately before this dispatch;
 * pane IDs are immutable for this tmux server, and the queue checks PID, creation and session too. */
export function managedLaunchPlan(r: ManagedPaneReceipt, command: string): { args: string[]; body: string; cleanup: string[] } {
  if (r.socket !== TMUX_SOCKET || !MANAGED_CREATION_UUID.test(r.creationId) ||
      !/^nt-term-[a-z0-9]+-[a-z0-9]{1,16}$/.test(r.session) || !/^%[0-9]+$/.test(r.paneId) ||
      !Number.isSafeInteger(r.panePid) || r.panePid < 1 || !/^[1-9][0-9]*$/.test(r.sessionCreated) ||
      !command || command.length > 32_768 || /[\r\n\u0000\u001b]/.test(command))
    throw new Error('Invalid managed launch')
  const buffer = pasteBufferName()
  const parts = [
    `#{==:#{session_name},${r.session}}`, `#{==:#{session_created},${r.sessionCreated}}`,
    `#{==:#{pane_pid},${r.panePid}}`, `#{==:#{${MANAGED_CREATION_ENV}},${r.creationId}}`
  ]
  const condition = parts.reduce((a, b) => `#{&&:${a},${b}}`)
  const yes = `if-shell -F -t ${r.paneId} '#{pane_in_mode}' 'send-keys -t ${r.paneId} -X cancel' ; ` +
    `paste-buffer -d -p -r -b ${buffer} -t ${r.paneId} ; send-keys -t ${r.paneId} Enter ; display-message -p nt-managed-delivered`
  const no = `delete-buffer -b ${buffer} ; display-message -p nt-managed-refused`
  return {
    args: ['-L', r.socket, 'load-buffer', '-b', buffer, '-', ';', 'if-shell', '-F', '-t', r.paneId, condition, yes, no],
    body: command,
    cleanup: ['-L', r.socket, 'delete-buffer', '-b', buffer]
  }
}
