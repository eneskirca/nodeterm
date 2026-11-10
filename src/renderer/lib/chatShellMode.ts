import { capabilityAgentId } from '@shared/agents/config'

// Shell mode in the ⌘M chat composer, drawn the way Claude Code's TUI draws it. MEASURED on Claude
// Code 2.1.319 in a private tmux server: a `!` typed into the input box — empty, or at the start of
// existing text — switches the box to shell mode. The `!` is not part of the text any more: it
// replaces the `❯` prompt, the box's rules turn pink (256-colour 211), and the status lines under the
// box are replaced by `! for shell mode` in the same pink. Backspace in an empty box leaves it.
//
// The chat draft keeps the leading `!` (it is what the send types, and what puts the TUI in shell
// mode), so "the draft starts with `!`" is exactly the TUI's rule. Only the composer's DISPLAY
// changes: the textarea shows the text after the `!`, and the `!` is drawn beside it.
//
// Claude only (and custom agents built on it): no other agent's shell mode has been measured.

/** Claude Code's own hint under the box, verbatim. */
export const SHELL_MODE_HINT = '! for shell mode'

export function showsShellMode(agentId: string | undefined | null): boolean {
  return typeof agentId === 'string' && capabilityAgentId(agentId) === 'claude'
}

export function isShellDraft(draft: string): boolean {
  return draft.startsWith('!')
}

/** What the textarea shows for a draft: the text after the `!` in shell mode, else the draft. */
export function shellDisplayText(draft: string, shell: boolean): string {
  return shell ? draft.slice(1) : draft
}

/** The draft for what the textarea now shows. */
export function draftFromDisplay(text: string, shell: boolean): string {
  return shell ? `!${text}` : text
}
