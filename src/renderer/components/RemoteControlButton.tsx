import { useState } from 'react'
import type { AgentState } from '@shared/agents/normalize'
import type { PtyApi } from '@shared/types'
import { IconRemoteAccess } from './icons'
import { Tooltip } from './Tooltip'
import { remoteControlOn, useRemoteControl } from '../state/remoteControl'
import { useSettings } from '../state/settings'
import { isHidden } from '../lib/ui-visibility'
import { remoteControlRefusal, toggleRemoteControl } from '../lib/remoteControlToggle'

/**
 * Claude Remote Control toggle — ONE component for the canvas node header and the kanban card
 * modal (two views of the same session must not behave differently). Green while this session is
 * reachable from claude.ai / the Claude app; a click runs `/remote-control` in the session.
 *
 * `write` is the caller's raw write to its LIVE pty view, used for the single pane-gated Enter that
 * confirms a disconnect (lib/remoteControlToggle.ts). A caller without one passes nothing: Claude's
 * own disconnect dialog then stays open in the terminal for the user to confirm.
 */
export function RemoteControlButton({
  nodeId,
  sessionId,
  readState,
  pty,
  write,
  className
}: {
  nodeId: string
  /** The session this node's transcript readers look at (`transcriptSessionFor`). */
  sessionId: string | null | undefined
  /** The node's agent state, read at CLICK time. */
  readState: () => AgentState | undefined
  pty: Pick<PtyApi, 'sendText' | 'capture'>
  write?: (data: string) => void
  className: string
}): JSX.Element | null {
  // Hidden here, like the context meter, so the Settings switch covers both views at once.
  const hidden = useSettings((s) => isHidden('remote-control', s.settings.hiddenHeaderButtons))
  const entry = useRemoteControl((s) => s.byNode[nodeId])
  const [busy, setBusy] = useState(false)
  // Green only when the transcript of THIS node's current session says so; unknown reads as off.
  const on = remoteControlOn(entry, sessionId)

  const toast = (message: string): void => {
    window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } }))
  }

  const onClick = async (): Promise<void> => {
    // Re-read at click time: a prompt that appeared since the last render would be ANSWERED by
    // the typed command.
    const why = remoteControlRefusal(readState())
    if (why) return toast(why)
    setBusy(true)
    try {
      const result = await toggleRemoteControl(
        {
          sendText: (text) => pty.sendText(nodeId, text),
          capture: () => pty.capture(nodeId),
          write,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms))
        },
        on
      )
      if (result === 'undelivered') toast('Could not send /remote-control to this session.')
    } finally {
      setBusy(false)
    }
  }

  if (hidden) return null
  return (
    <Tooltip
      label={
        on
          ? 'Remote Control is on — reachable from claude.ai and the Claude app. Click to disconnect'
          : 'Remote Control is off — click to reach this session from claude.ai or the Claude app'
      }
    >
      <button
        className={`${className} nodrag`}
        aria-label="Claude Remote Control"
        aria-pressed={on}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          void onClick()
        }}
      >
        <IconRemoteAccess />
      </button>
    </Tooltip>
  )
}
