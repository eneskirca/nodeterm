import type { MessageBoxOptions } from 'electron'
import type { RemoteCodexObserverPlan, RemoteCodexObservation } from '../../core/remote-ssh/codex-provider-observer'
import type { NativeSshTransport } from '../../core/remote-ssh/native/existing-transport'
import { quoteIdentityValue as quoted } from '../identity-display'

/** Display projection from main's inspected runtime, never an approval flag from IPC. */
export function observedCodexStartDialogOptions(
  plan: Readonly<RemoteCodexObserverPlan>, transport: NativeSshTransport['identity']
): MessageBoxOptions {
  return {
    type: 'warning', title: 'Start one observed SSH Codex resume',
    message: 'Approve this runtime and resume this conversation in the selected ended terminal?',
    detail: [
      `Node: ${quoted(plan.context.nodeId)}`, `Private project: ${quoted(plan.context.projectId)}`,
      `SSH endpoint: ${quoted(`${transport.user}@${transport.hostname}:${transport.port}`)}`,
      `SSH peer key SHA-256: ${quoted(transport.serverKeySha256)}`, `Connection generation: ${quoted(transport.generation)}`,
      `Account scope: ${quoted(plan.accountId)}`, `Conversation: ${quoted(plan.context.sessionId)}`,
      `Remote folder: ${quoted(plan.cwd)}`, `Account home: ${quoted(plan.codeHome)}`,
      `Frontend executable: ${quoted(plan.providerExecutable)}`, `Frontend SHA-256: ${quoted(plan.providerSha256)}`,
      `Existing account daemon: ${quoted(plan.upstreamSocket)}`, `Daemon executable SHA-256: ${quoted(plan.daemonSha256)}`,
      '', 'Approve only runtimes you recognize from your installation. A measured hash alone does not verify their source.',
      'This starts one new frontend only after the old terminal has ended. It does not stop or replace an existing session.',
      'Starting the frontend does not authorize mailbox ownership or acknowledge historical held mail.'
    ].join('\n'),
    buttons: ['Cancel', 'Approve runtime and resume'], defaultId: 0, cancelId: 0, noLink: true
  }
}

/** Metadata-only UI projection of already captured evidence. No caller-supplied process proof. */
export interface ObservedSshAdoptionDisplay {
  readonly observation: RemoteCodexObservation
  readonly transport: NativeSshTransport['identity']
  readonly kernel: {
    readonly bootId: string
    readonly host: { readonly pid: number; readonly birth: string }
    readonly pane: { readonly pid: number; readonly birth: string }
    readonly paneId: string
    readonly tty: string
    readonly socket: { readonly path: string; readonly dev: string; readonly ino: string; readonly ctimeNs: string }
  }
}

export function observedSshAdoptionDialogOptions(display: ObservedSshAdoptionDisplay): MessageBoxOptions {
  const { observation: o, transport: t, kernel: k } = display
  if (o.state !== 'observed' || !o.frontend) throw new Error('Observed SSH frontend identity unavailable')
  return {
    type: 'warning', title: 'Authorize one observed SSH session',
    message: 'Authorize this exact running SSH frontend for this private project?',
    detail: [
      `Node: ${quoted(o.nodeId)}`, `Private project: ${quoted(o.projectId)}`,
      `SSH endpoint: ${quoted(`${t.user}@${t.hostname}:${t.port}`)}`, `SSH peer key SHA-256: ${quoted(t.serverKeySha256)}`,
      `Connection generation: ${quoted(t.generation)}`, `Launch origin: ${quoted(o.launchId)}`,
      `Account scope: ${quoted(o.accountId)}`, `Conversation: ${quoted(o.threadId)}`, `Remote folder: ${quoted(o.cwd)}`,
      `Remote boot: ${quoted(k.bootId)}`, `tmux server PID/birth: ${k.host.pid} / ${k.host.birth}`,
      `tmux socket: ${quoted(k.socket.path)}`, `Socket device/inode/ctime: ${k.socket.dev} / ${k.socket.ino} / ${k.socket.ctimeNs}`,
      `Pane: ${quoted(k.paneId)}`, `Pane root PID/birth: ${k.pane.pid} / ${k.pane.birth}`, `TTY: ${quoted(k.tty)}`,
      `Supervisor PID/birth: ${o.supervisor.pid} / ${o.supervisor.startTicks}`,
      `Frontend PID/birth: ${o.frontend?.pid ?? 'unknown'} / ${o.frontend?.startTicks ?? 'unknown'}`,
      `Account daemon PID/birth: ${o.daemon.process.pid} / ${o.daemon.process.startTicks}`,
      '', 'Confirm only if you recognize this observed session and private project.',
      'This authorizes only the captured identity. Historical held mail remains unverified and is not rebound, resent, acknowledged or completed.'
    ].join('\n'),
    buttons: ['Cancel', 'Authorize this observed session'], defaultId: 0, cancelId: 0, noLink: true
  }
}
