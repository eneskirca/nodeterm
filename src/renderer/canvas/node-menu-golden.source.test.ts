// The node action menu's user-facing strings and hide ids, pinned while its code moves out of
// Canvas.tsx (Canvas cannot be mounted in a test, so the move is guarded at source level here and
// behaviour-tested in lib/nodeActionItems.test.tsx). A string that changes, disappears or appears
// here is a change somebody must decide on, not a side effect of a refactor.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')

/** Comment-free code: a string inside a comment is not a row. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
/** Every single-quoted literal that starts with a capital letter — labels and hints. */
const strings = (src: string): string[] =>
  [...new Set([...code(src).matchAll(/'([A-Z][^'\n]*)'/g)].map((m) => m[1]))].sort()
/** Every template literal that starts with a capital letter — the labels and hints built from a value. */
const templates = (src: string): string[] =>
  [...new Set([...code(src).matchAll(/`([A-Z][^`\n]*)`/g)].map((m) => m[1]))].sort()
const hideIds = (src: string): string[] => [...code(src).matchAll(/isHidden\('([a-z-]+)'/g)].map((m) => m[1])

/** The menu's code, wherever it lives. Asserts the builder's two entry points are in the file, so a
 *  rename or a further move fails here by name instead of passing on a file that lost the rows. */
function menuSource(): string {
  const src = read('../lib/nodeActionItems.tsx')
  for (const marker of ['export function buildNodeActionSections(', 'export function buildAccountSwitchRows('])
    if (!src.includes(marker)) throw new Error(`node menu source: marker not found: ${marker}`)
  return src
}

const GOLDEN_STRINGS = [
  'Account',
  'Add selection to group',
  'Branch conversation',
  'Brings the conversation back.',
  'Change icon…',
  'Collapse / Expand',
  'Configure a URL and API key in Settings → Model gateway.',
  'Configure the model gateway on the machine hosting this relay session.',
  'Delete',
  'Discovering models…',
  'Duplicate',
  'Ends the tmux session on the machine hosting this relay session, not here.',
  'Group',
  'Group node',
  'Group selection',
  'Markdown view',
  'Moves this conversation to the account and resumes it there (same conversation).',
  'Not available for relay sessions.',
  'Nothing to resume yet — this session has not reported an id.',
  'Open this project on the canvas to do that.',
  'Pause',
  'Pause & end session',
  'Pause session',
  'Quits Claude, moves this conversation to the account and resumes it there — no login needed.',
  'Quits each CLI; busy ones pause after their current turn. Resume brings each back.',
  'Quits the CLI and ends its tmux session too, for a fuller memory reclaim. Resume starts a fresh session with the same conversation.',
  'Quits the CLI and relaunches it with --resume (same conversation).',
  'Quits the CLI, respawns a fresh shell (picks up env/profile changes), then resumes.',
  'Quits the CLI; the tmux session stays so Resume is fast. Frees most of the memory.',
  'Rebuilds the view and re-attaches to the same session. Nothing running is interrupted.',
  'Refresh terminal',
  'Remove from group',
  'Reopen session as',
  'Restart',
  'Restart agent',
  'Restart agent and shell',
  'Restart on Copilot defaults',
  'Restart on subscription',
  'Restart the shell on the machine hosting this relay session.',
  'Restarts the session with gateway/provider env stripped — uses your own subscription/credentials.',
  'Resume session',
  'Set icon…',
  'Snap to zone',
  'Stop agent control',
  'Switch Claude account',
  'Switch Codex account',
  'Switch model',
  'This account is no longer available.',
  'This account lives on a host that is not connected.',
  'This node already runs on this account.',
  'This node is already using this model.',
  'This session is busy — restart it once its turn (or permission prompt) is done.',
  'This session is busy — switch it once its turn (or permission prompt) is done.',
  'This session is busy — try again once its turn (or permission prompt) is done.',
  'This terminal is not attached right now.',
  'This terminal was released while off screen — refresh the terminal or bring it into view on the canvas.'
]

const GOLDEN_TEMPLATES = [
  "Add selection to ${targetGroup.data.title || 'group'}",
  'Pause ${agents.length} sessions',
  'Quits this CLI and resumes the same session as ${variant.label}.',
  'Restarts the terminal session and resumes this conversation with ${model.id}.',
  'Switch model (${currentModel})',
  'System account (${hostKey})'
]

const GOLDEN_HIDE_IDS = [
  'group',
  'group',
  'group',
  'remove-from-group',
  'colors',
  'icon',
  'duplicate',
  'snap-zone',
  'collapse',
  'markdown-view',
  'refresh-terminal',
  'vanilla-restart'
]

describe('node action menu — golden strings and hide ids', () => {
  it('offers exactly the labels and hints it did before the extraction', () => {
    expect(strings(menuSource())).toEqual(GOLDEN_STRINGS)
  })

  it('builds the same templated labels and hints', () => {
    expect(templates(menuSource())).toEqual(GOLDEN_TEMPLATES)
  })

  it('consults the hide list for exactly the same rows, in the same order', () => {
    expect(hideIds(menuSource())).toEqual(GOLDEN_HIDE_IDS)
  })
})
