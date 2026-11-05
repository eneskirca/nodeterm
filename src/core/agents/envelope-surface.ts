import { capabilityAgentId, type AgentId } from '../../shared/agents/config'
import { readClaudeScreen } from '../../shared/agents/claude-screen'
import { AGENT_BINARIES, isAgentPane, type PaneOwner } from '../../shared/agents/pane-owner-predicate'
import { cursorApprovalIn, cursorQuestionIn, cursorPlanPromptIn } from './cursor-approval'

/** The single positive input-surface contract for every envelope backend. Plain captures only;
 * unknown providers, modes and interfaces refuse. Callers recheck this at EACH write point.
 */
export function envelopeSurfaceReady(screen: string, agent: string): boolean {
  if (!screen.trim()) return false
  const base = capabilityAgentId(agent as AgentId)
  // A nonempty screen and absence of one known dialog are NOT positive composer evidence.
  // Do not submit the bang/shell-mode draft even while the agent process still owns the tty.
  if (/(?:^|\n)!(?:[ \t]|$)/.test(screen)) return false
  if (base === 'claude') return readClaudeScreen(screen).kind === 'prompt'
  if (base === 'cursor') return !cursorApprovalIn(screen) && !cursorQuestionIn(screen) &&
    !cursorPlanPromptIn(screen) && readClaudeScreen(screen).kind === 'prompt'
  if (base === 'codex') {
    // captureSession's tmux path supplies plain text. Styled/control-only captures and
    // unrecognized layouts fail closed. Codex's ordinary composer has a >-shaped U+203A
    // prompt and its own final shortcuts footer; an approval selection replaces that footer.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(screen)) return false
    const lines = screen.replace(/\r/g, '').split('\n').map(line => line.trimEnd())
    let footer = lines.length - 1
    while (footer >= 0 && lines[footer].trim() === '') footer--
    // Observed warning badge is passive metadata, not arbitrary trailing confirmation text.
    const idleFooter = /^\s*(?:← for agents\s*·\s*)?\? for shortcuts(?:\s+(?:100|\d{1,2})% context left)?(?:\s+⚠\ufe0f?\s+[1-9]\d{0,3}\s+warnings?\s*·\s*f2 to view)?\s*$/
    if (footer < 0 || !idleFooter.test(lines[footer])) return false
    let prompt = footer - 1
    while (prompt >= 0 && !/^\s*›(?:\s|$)/.test(lines[prompt])) prompt--
    if (prompt < 0 || footer - prompt > 48 || /^\s*›\s*\d+[.)]\s/.test(lines[prompt])) return false
    const above = lines.slice(Math.max(0, prompt - 12), prompt).join('\n')
    if (/would you like to|do you want to|do you trust|enter to confirm|esc to cancel|press[^\n]*enter/i.test(above)) return false
    return !/^\s*›\s*(?:input disabled|connecting|reconnecting)\b/i.test(lines[prompt])
  }
  // No provider-specific positive reader: never guess that an unknown interface is safe.
  return false
}

/** OS-attested native/host owner selects the reader; screen text and stored node labels cannot.
 * Ambiguous foreground agents or custom binaries without a known positive reader fail closed.
 */
export function ownerEnvelopeSurfaceReady(screen: string, owner: PaneOwner): boolean {
  const ids = Object.keys(AGENT_BINARIES).filter(id => isAgentPane(owner, id, AGENT_BINARIES[id]) === 'agent')
  return ids.length === 1 && envelopeSurfaceReady(screen, ids[0])
}
