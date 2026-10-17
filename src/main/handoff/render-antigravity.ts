// Renders an Antigravity (`agy`) transcript (`~/.gemini/antigravity-cli/brain/<id>/
// .system_generated/logs/transcript_full.jsonl`) to full Markdown for cross-agent handoff.
//
// Shape knowledge lives in `linesFromAntigravity` (`core/context-link-render.ts`), which strips
// injected `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>` tags from `USER_INPUT` and omits
// harness-internal `SYSTEM_MESSAGE` / `CHECKPOINT` steps so tooling prose is never attributed to
// the human speaker.
import { linesFromAntigravity } from '../../core/context-link-render'

const ROLE_RE = /^(\w+): ([\s\S]*)$/

const HEADINGS: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant'
}

export function renderAntigravityTranscript(raw: string): string {
  const out: string[] = []
  for (const line of linesFromAntigravity(raw)) {
    if (line.startsWith('  ')) {
      out.push(line.trim())
      continue
    }
    const m = ROLE_RE.exec(line)
    if (!m) {
      out.push(line)
      continue
    }
    const [, role, text] = m
    out.push(`## ${HEADINGS[role] ?? role}\n\n${text}`)
  }
  return out.join('\n\n')
}
