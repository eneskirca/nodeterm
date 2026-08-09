import type { AgentId } from '@shared/agents/config'
import claudeIcon from '../assets/claude.svg'
import codexIcon from '../assets/codex-color.svg'
import geminiIcon from '../assets/gemini-color.svg'
import opencodeIcon from '../assets/opencode.svg'
import grokIcon from '../assets/grok.svg'
import { IconTerminal } from '../components/icons'

// Brand logo per builtin agent; custom/unknown agents fall back to the terminal glyph.
const AGENT_LOGO: Partial<Record<string, string>> = {
  claude: claudeIcon,
  codex: codexIcon,
  gemini: geminiIcon,
  opencode: opencodeIcon,
  // Placeholder monogram, not the official Grok mark — see the comment in assets/grok.svg.
  grok: grokIcon
}

export function AgentIcon({ agentId, size = 16 }: { agentId: AgentId; size?: number }): React.JSX.Element {
  const src = AGENT_LOGO[agentId]
  if (src) {
    return <img src={src} width={size} height={size} alt="" style={{ display: 'block' }} />
  }
  return <IconTerminal />
}
