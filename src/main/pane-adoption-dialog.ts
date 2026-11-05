import type { MessageBoxOptions } from 'electron'
import type { LocalPaneIdentity } from '../shared/agents/pane-adoption'
import { quoteIdentityValue as quoted } from './identity-display'

/** Mandatory native confirmation: this action never uses project/agent confirmation waivers. */
export function paneAdoptionDialogOptions(i: LocalPaneIdentity): MessageBoxOptions {
  return {
    type: 'warning', title: 'Authorize one running local session',
    message: 'Authorize this exact running session for this private project?',
    detail: [
      `Node: ${quoted(i.nodeId)}`, `Private project: ${quoted(i.projectId)}`,
      `Local folder: ${quoted(i.projectCwd)}`, `Provider: ${quoted(i.agentId)}`,
      `Provider session: ${quoted(i.providerSessionId)}`, `Host PID/birth: ${i.host.pid} / ${i.host.birth}`,
      `PTY PID/birth: ${i.pane.pid} / ${i.pane.birth}`, `Host generation: ${quoted(i.generation)}`,
      `Foreground PID/birth: ${i.foreground.map(p => `${p.pid} / ${p.birth}`).join(', ')}`,
      '', 'Confirm only if you recognize this session and this project. This creates local human-adoption authority for this exact identity.',
      'It does not start work or confirm, rebind, resend or acknowledge historical held mail.'
    ].join('\n'),
    buttons: ['Cancel', 'Authorize this session'], defaultId: 0, cancelId: 0, noLink: true
  }
}
