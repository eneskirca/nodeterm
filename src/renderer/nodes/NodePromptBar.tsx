import { useEffect, useRef, useState } from 'react'
import type { NodePrompt } from '@shared/node-prompts'
import { resendPrompt } from '../lib/resendPrompt'
import { useAgentStatus } from '../state/agentStatus'
import { useNodePrompts } from '../state/nodePrompts'

const NO_PROMPTS: readonly NodePrompt[] = []
const SENT_FLASH_MS = 1500

const toastError = (message: string): void => {
  window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } }))
}

/**
 * Every prompt the person typed into this agent node, stacked under its header and always visible,
 * so a canvas of many sessions still says what each one is for. Oldest first, so the top line is
 * what the node was started for and the bottom line is where it is now.
 *
 * Each prompt is one line (the full text is its tooltip). Clicking it sends that prompt to the
 * session again (`resendPrompt` refuses, with a toast saying why, whenever the keystrokes would not
 * reach the agent's input). The × beside it is always shown — a control that only appears on hover
 * does not exist on a touch screen — and removing is the point: drop "proceed" and "yes". Nothing is
 * hidden for the person: `rememberPrompt` only keeps out what a CLI or nodeterm injected, never what
 * they wrote.
 *
 * The stack grows a row per prompt up to a cap (CSS `max-height`) and scrolls past it, so a long
 * session cannot eat the terminal. A row added or removed below the cap resizes the terminal; that
 * is the price of always-visible and it stops at the cap.
 *
 * Renders nothing until the node has a prompt, so a plain terminal and a session that predates the
 * feature carry no empty strip.
 */
export function NodePromptBar({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const prompts = useNodePrompts((s) => s.byId[nodeId]) ?? NO_PROMPTS
  const remove = useNodePrompts((s) => s.remove)
  const stack = useRef<HTMLOListElement>(null)
  const sending = useRef(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [sentId, setSentId] = useState<string | null>(null)
  const count = prompts.length

  useEffect(() => () => clearTimeout(flashTimer.current), [])

  const resend = async (prompt: NodePrompt): Promise<void> => {
    if (sending.current) return
    sending.current = true
    try {
      const { pty } = window.nodeTerminal
      const outcome = await resendPrompt(nodeId, prompt, {
        agentState: (id) => useAgentStatus.getState().byId[id]?.state,
        paneCommand: (id) => pty.paneCommand(id),
        sendText: (id, text) => pty.sendText(id, text)
      })
      if (!outcome.ok) return toastError(outcome.reason)
      setSentId(prompt.id)
      clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setSentId(null), SENT_FLASH_MS)
    } catch (err) {
      console.warn('[prompts] could not resend a prompt:', err)
      toastError('Could not send the prompt to this node.')
    } finally {
      sending.current = false
    }
  }

  // Past the cap the newest prompt is the one that matters; keep it in view as the stack grows.
  useEffect(() => {
    const el = stack.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count])

  if (count === 0) return null

  return (
    <div className="prompt-bar nodrag">
      <ol ref={stack} className="prompt-bar__stack nowheel" aria-label="Your prompts">
        {prompts.map((p) => (
          <li key={p.id} className="prompt-bar__item">
            <button
              type="button"
              className={`prompt-bar__send${p.partial ? ' prompt-bar__send--partial' : ''}`}
              title={`${p.partial ? 'Too long to send again' : 'Click to send this prompt again'}\n\n${p.text}\n${new Date(p.at).toLocaleString()}`}
              onClick={() => void resend(p)}
            >
              {p.text}
            </button>
            {sentId === p.id && (
              <span className="prompt-bar__sent" role="status">
                Sent
              </span>
            )}
            <button
              type="button"
              className="prompt-bar__remove"
              aria-label={`Remove prompt: ${p.text.slice(0, 60)}`}
              title="Remove this prompt"
              onClick={() => remove(nodeId, p.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
