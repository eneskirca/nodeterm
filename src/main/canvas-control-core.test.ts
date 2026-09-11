import { describe, it, expect } from 'vitest'
import {
  parseControlRequest,
  isDestructiveVerb,
  mergeCanvasControlBlock,
  buildCanvasControlInstructions,
  buildCanvasSkillBody,
  CONTROL_SHIM_SCRIPT,
  CONTROL_UNREACHABLE_MSG
} from '../core/canvas-control-core'
import {
  CODEX_SANDBOX_BLOCKED_LINE,
  CODEX_SANDBOX_RETRY_LINE
} from '../core/agents/hook-sandbox-hint-sh'
import { RETRYABLE } from '../core/agents/agent-message-decide'
import { PROJECT_TARGETABLE_VERBS } from '../core/project-grants'
import { DRY_RUN_VERBS } from '../shared/control-verbs'
import { STRICT_CONTROL_VERBS } from '../core/agents/node-identity-policy'
import { BROWSER_ACTION_KEYS } from '../core/browser-verb'
import { BROWSER_RETRYABLE, BROWSER_OUTCOME_LABEL } from '../core/browser-outcomes'
import { BROWSER_CAPABILITY_OFF_MESSAGE } from './browser-drive'

describe('parseControlRequest', () => {
  it('accepts known verbs', () => {
    expect(parseControlRequest('list', {})).toEqual({ verb: 'list', args: {} })
    expect(parseControlRequest('open-claude', { count: '2' })).toEqual({
      verb: 'open-claude',
      args: { count: '2' }
    })
  })

  it('rejects unknown verbs', () => {
    expect(parseControlRequest('nuke', {})).toEqual({ error: 'Unknown verb: nuke' })
  })

  it('open-project requires --cwd (issue #338, PR 1)', () => {
    expect(parseControlRequest('open-project', {})).toEqual({
      error: 'open-project requires --cwd <abs-path>'
    })
    expect(parseControlRequest('open-project', { cwd: '/tmp/repo' })).toEqual({
      verb: 'open-project',
      args: { cwd: '/tmp/repo' }
    })
  })

  it('open-project IS destructive — its create/adopt/first-attach dialog is confirm-gated (PR 2)', () => {
    // PR 1 left a tripwire here asserting the opposite; PR 2 added the early-handled dispatch
    // block that reads `isDestructiveVerb(verb)` before its `confirmBusy()` refusal, so the
    // membership and the dispatch now exist together (control-destructive.test.ts is the alarm).
    expect(isDestructiveVerb('open-project')).toBe(true)
  })

  it('requires a target for write/close', () => {
    expect(parseControlRequest('close', {})).toEqual({ error: 'close requires --node <id>' })
    expect(parseControlRequest('write', { node: 'n1' })).toEqual({ error: 'write requires --text' })
    expect(parseControlRequest('write', { node: 'n1', text: 'hi' })).toEqual({
      verb: 'write',
      args: { node: 'n1', text: 'hi' }
    })
  })

  it('requires a source for show verbs', () => {
    expect(parseControlRequest('show-video', {})).toEqual({ error: 'show-video requires --path' })
    expect(parseControlRequest('show-web', {})).toEqual({
      error: 'show-web requires --url, --file or --html'
    })
  })

  it('open-browser requires --url', () => {
    expect(parseControlRequest('open-browser', {})).toEqual({ error: 'open-browser requires --url' })
    expect(parseControlRequest('open-browser', { url: 'https://x.dev' })).toEqual({
      verb: 'open-browser',
      args: { url: 'https://x.dev' }
    })
  })
  it('open-browser is not destructive', () => {
    expect(isDestructiveVerb('open-browser')).toBe(false)
  })

  it('classifies destructive verbs', () => {
    expect(isDestructiveVerb('write')).toBe(true)
    expect(isDestructiveVerb('close')).toBe(true)
    expect(isDestructiveVerb('open-claude')).toBe(false)
    expect(isDestructiveVerb('show-image')).toBe(false)
  })

  it('group/arrange require --nodes; align also requires --edge', () => {
    expect(parseControlRequest('group', {})).toEqual({ error: 'group requires --nodes <id,id>' })
    expect(parseControlRequest('group', { nodes: 'a,b' })).toEqual({ verb: 'group', args: { nodes: 'a,b' } })
    expect(parseControlRequest('arrange', {})).toEqual({ error: 'arrange requires --nodes <id,id>' })
    expect(parseControlRequest('align', { nodes: 'a' })).toEqual({ error: 'align requires --edge' })
    expect(parseControlRequest('align', { nodes: 'a', edge: 'left' })).toEqual({
      verb: 'align',
      args: { nodes: 'a', edge: 'left' }
    })
  })
  it('link requires --to; --from is optional and it is not destructive', () => {
    expect(parseControlRequest('link', {})).toEqual({ error: 'link requires --to <id,id>' })
    expect(parseControlRequest('link', { to: 'n2,n3' })).toEqual({
      verb: 'link',
      args: { to: 'n2,n3' }
    })
    expect(parseControlRequest('link', { to: 'n2', from: 'n1' })).toEqual({
      verb: 'link',
      args: { to: 'n2', from: 'n1' }
    })
    // A context link is pull-only (nothing is pushed into the endpoints), so it never
    // goes through the confirm dialog.
    expect(isDestructiveVerb('link')).toBe(false)
  })

  it('verify requires --node and is not destructive (it only opens read-only reviewers)', () => {
    expect(parseControlRequest('verify', {})).toEqual({ error: 'verify requires --node <id>' })
    expect(parseControlRequest('verify', { node: 'n1', lenses: 'security,tests' })).toEqual({
      verb: 'verify',
      args: { node: 'n1', lenses: 'security,tests' }
    })
    expect(isDestructiveVerb('verify')).toBe(false)
  })

  it('open-agent requires --agent, and is not destructive', () => {
    expect(parseControlRequest('open-agent', {})).toEqual({ error: 'open-agent requires --agent <id>' })
    expect(parseControlRequest('open-agent', { agent: 'codex' })).toEqual({
      verb: 'open-agent',
      args: { agent: 'codex' }
    })
    expect(isDestructiveVerb('open-agent')).toBe(false)
  })

  it('open-worktree requires --branch, close-worktree requires --group; neither destructive', () => {
    expect(parseControlRequest('open-worktree', {})).toEqual({ error: 'open-worktree requires --branch <name>' })
    expect(parseControlRequest('open-worktree', { branch: 'feat/x' })).toEqual({
      verb: 'open-worktree',
      args: { branch: 'feat/x' }
    })
    expect(parseControlRequest('close-worktree', {})).toEqual({ error: 'close-worktree requires --group <id>' })
    expect(parseControlRequest('close-worktree', { group: 'g1' })).toEqual({
      verb: 'close-worktree',
      args: { group: 'g1' }
    })
    expect(isDestructiveVerb('open-worktree')).toBe(false)
    expect(isDestructiveVerb('close-worktree')).toBe(false)
  })

  it('branch requires --node, and is not destructive', () => {
    expect(parseControlRequest('branch', {})).toEqual({ error: 'branch requires --node <id>' })
    expect(parseControlRequest('branch', { node: 'n1' })).toEqual({
      verb: 'branch',
      args: { node: 'n1' }
    })
    expect(isDestructiveVerb('branch')).toBe(false)
  })

  it('rename requires --node and --title, and is not destructive', () => {
    expect(parseControlRequest('rename', {})).toEqual({ error: 'rename requires --node <id>' })
    expect(parseControlRequest('rename', { node: 'n1' })).toEqual({ error: 'rename requires --title' })
    expect(parseControlRequest('rename', { node: 'n1', title: 'Feature Development' })).toEqual({
      verb: 'rename',
      args: { node: 'n1', title: 'Feature Development' }
    })
    expect(isDestructiveVerb('rename')).toBe(false)
  })

  it('color requires --node and --color, and is metadata-only', () => {
    expect(parseControlRequest('color', {})).toEqual({
      error: 'color requires --node <id,id>'
    })
    expect(parseControlRequest('color', { node: 'n1,n2' })).toEqual({
      error: 'color requires --color'
    })
    expect(parseControlRequest('color', { node: 'n1,n2', color: '#32d74b' })).toEqual({
      verb: 'color',
      args: { node: 'n1,n2', color: '#32d74b' }
    })
    expect(isDestructiveVerb('color')).toBe(false)
  })

  it('ungroup requires --group; move requires --nodes; neither is destructive', () => {
    expect(parseControlRequest('ungroup', {})).toEqual({ error: 'ungroup requires --group <id>' })
    expect(parseControlRequest('ungroup', { group: 'g1' })).toEqual({ verb: 'ungroup', args: { group: 'g1' } })
    expect(parseControlRequest('move', {})).toEqual({ error: 'move requires --nodes <id,id>' })
    // --group is optional on move (omitting it pulls the nodes out to the top level).
    expect(parseControlRequest('move', { nodes: 'n1,n2' })).toEqual({ verb: 'move', args: { nodes: 'n1,n2' } })
    expect(parseControlRequest('move', { nodes: 'n1', group: 'g2' })).toEqual({
      verb: 'move',
      args: { nodes: 'n1', group: 'g2' }
    })
    expect(isDestructiveVerb('ungroup')).toBe(false)
    expect(isDestructiveVerb('move')).toBe(false)
  })

  it('board takes no required args and is not destructive', () => {
    expect(parseControlRequest('board', {})).toEqual({ verb: 'board', args: {} })
    expect(isDestructiveVerb('board')).toBe(false)
  })

  it('assign requires --node; --column/--before are optional and it is not destructive', () => {
    expect(parseControlRequest('assign', {})).toEqual({ error: 'assign requires --node <id>' })
    // No --column is valid: it means "back to Ungrouped".
    expect(parseControlRequest('assign', { node: 'n1' })).toEqual({ verb: 'assign', args: { node: 'n1' } })
    expect(parseControlRequest('assign', { node: 'n1', column: 'In Progress' })).toEqual({
      verb: 'assign',
      args: { node: 'n1', column: 'In Progress' }
    })
    // Moving a card is board metadata only — no session is touched, so no confirm dialog.
    expect(isDestructiveVerb('assign')).toBe(false)
  })

  it('merges the canvas-control block idempotently, preserving other content', () => {
    const block = buildCanvasControlInstructions('/tmp/nodeterm.sh')
    const first = mergeCanvasControlBlock('# My own notes\n', block)
    expect(first).toContain('# My own notes')
    expect(first).toContain('nodeterm:manage-canvas:start')
    expect(first).toContain('/tmp/nodeterm.sh')
    // Re-merging (e.g. next app launch, updated verbs) replaces the block, not duplicates it.
    const second = mergeCanvasControlBlock(first, buildCanvasControlInstructions('/new/nodeterm.sh'))
    expect(second.match(/nodeterm:manage-canvas:start/g)).toHaveLength(1)
    expect(second).toContain('/new/nodeterm.sh')
    expect(second).not.toContain('/tmp/nodeterm.sh')
    expect(second).toContain('# My own notes')
  })

  it('instructions cover the verb set and the confirm caveat', () => {
    const body = buildCanvasControlInstructions('/tmp/nodeterm.sh')
    for (const verb of ['list', 'open-agent', 'spawn-team', 'group', 'ungroup', 'move', 'arrange', 'rename', 'color', 'write', 'close', 'board', 'assign']) {
      expect(body).toContain(verb)
    }
    expect(body).toContain('group --nodes <id,id> [--label L] [--color C]')
    expect(body).toContain('color --node <id,id> --color C')
    const skill = buildCanvasSkillBody('/tmp/nodeterm.sh')
    expect(skill).toContain('group --nodes <id,id> [--label "Frontend Team"] [--color C]')
    expect(skill).toContain('color --node <id,id> --color C')
    expect(body.toLowerCase()).toContain('confirm')
  })

  // The parser change in this commit's sibling is only half a fix: an agent that never learns the
  // `=` form simply cannot express a value beginning with `--`, and the failure stays silent for it.
  // So both agent-facing texts must carry the rule, not just one of them.
  it('the skill text documents --flag=value and warns about values starting with --', () => {
    const body = buildCanvasSkillBody('/x/shim.sh')
    expect(body).toContain('--flag=value')
    expect(body).toMatch(/starts? with `--`/)
  })

  it('the codex/gemini instructions carry the same rule', () => {
    const body = buildCanvasControlInstructions('/tmp/nodeterm.sh')
    expect(body).toContain('--flag=value')
    expect(body).toMatch(/starts? with `--`/)
  })

  // Issue #367: the shim's transport-failure sentences and the docs that explain them are held
  // together by constants — re-typing either side in prose is how the guidance and the generated
  // script drift. The runtime behaviour itself is proven against real /bin/sh in
  // canvas-control-shim.test.ts; this pins the TEACHING of it into both agent-facing bodies.
  it('both agent-facing texts carry the codex-sandbox transport guidance (issue #367)', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      // Names both exact errors the agent can see: the generic sentence and the sandbox one.
      expect(body).toContain(CONTROL_UNREACHABLE_MSG.replace(/\.$/, ''))
      expect(body).toContain(CODEX_SANDBOX_BLOCKED_LINE)
      // The one action that works everywhere, and the never-do.
      expect(body.toLowerCase()).toContain('escalated permissions')
      expect(body).toMatch(/never relink, reinstall or restart nodeterm/)
      // The macOS permanent remedy, named exactly as codex's config reads it.
      expect(body).toContain('network.allow_unix_sockets')
      expect(body).toContain('~/.codex/config.toml')
    }
  })

  it('the shim embeds the sandbox hint and its call sites in both failure tails', () => {
    // The fragment (one definition)...
    expect(CONTROL_SHIM_SCRIPT).toContain('nt_codex_sandbox_hint() {')
    expect(CONTROL_SHIM_SCRIPT).toContain(CODEX_SANDBOX_BLOCKED_LINE)
    expect(CONTROL_SHIM_SCRIPT).toContain(CODEX_SANDBOX_RETRY_LINE)
    // ...and the fallback shape: the genuine-unreachable sentence survives to the byte.
    expect(CONTROL_SHIM_SCRIPT).toContain(
      `nt_codex_sandbox_hint || echo "${CONTROL_UNREACHABLE_MSG}" >&2`
    )
  })

  it('send/reply require --text (Task 5.4)', () => {
    expect(parseControlRequest('send', { node: 'n1' })).toEqual({ error: 'send requires --text' })
    expect(parseControlRequest('reply', { node: 'n1' })).toEqual({ error: 'reply requires --text' })
  })

  it('the shim maps a bare positional onto arg.node for color/send/reply/sticky too', () => {
    // The positional list is a case pattern inside CONTROL_SHIM_SCRIPT; send/reply/sticky take the
    // same "first bare word is the node" convenience write/close/rename/color/branch already have.
    expect(CONTROL_SHIM_SCRIPT).toContain('write|close|rename|color|branch|send|reply|sticky)')
  })

  it('sticky requires --node plus exactly one of --text/--append, and is not destructive', () => {
    expect(parseControlRequest('sticky', {})).toEqual({ error: 'sticky requires --node <id|title>' })
    expect(parseControlRequest('sticky', { node: 'n1' })).toEqual({
      error: 'sticky requires --text or --append'
    })
    expect(parseControlRequest('sticky', { node: 'n1', text: 'a', append: 'b' })).toEqual({
      error: 'sticky: pass either --text or --append, not both'
    })
    expect(parseControlRequest('sticky', { node: 'n1', text: '# md' })).toEqual({
      verb: 'sticky',
      args: { node: 'n1', text: '# md' }
    })
    expect(parseControlRequest('sticky', { node: 'n1', append: 'line' })).toEqual({
      verb: 'sticky',
      args: { node: 'n1', append: 'line' }
    })
    // Presence, not truthiness: `--text=""` is how a note is cleared.
    expect(parseControlRequest('sticky', { node: 'n1', text: '' })).toEqual({
      verb: 'sticky',
      args: { node: 'n1', text: '' }
    })
    expect(isDestructiveVerb('sticky')).toBe(false)
  })

  it('both agent-facing texts warn that --prompt is one line and must not start with a slash', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      // `assembleLaunchCommand` collapses every whitespace run in the prompt, because the prompt
      // rides argv on a line that is typed into the pane. An agent that does not know this writes
      // a numbered brief and gets one paragraph.
      expect(body.toLowerCase()).toContain('one line')
      // The failure that costs a whole station: flattened, a leading slash command swallows the
      // task as its argument, and the node then reads as idle to `--after`. Silence here is what
      // let that ship.
      expect(body).toMatch(/start a prompt with `\/`|begin a prompt with `\/`/i)
    }
  })

  it('both agent-facing texts separate a denial from an unanswered dialog', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      // The two answers carry opposite guidance — a denial is final, a timeout is retryable — and
      // a body that names only "may be denied" leaves a caller reading its own timeout as refusal.
      expect(body).toContain('denied by user')
      expect(body).toContain('no answer within 120s')
    }
  })

  it('both agent-facing texts document --model on the open verbs and per-role model on spawn-team', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      // The flag is the only cost lever an orchestrator has: without it every station it opens
      // inherits one default model. A body that stops naming it leaves that lever undiscoverable,
      // which is the state this test was written to end.
      expect(body).toContain('--model')
      // Both silent no-ops must be stated, or an agent reads a missing flag as a failed call:
      // a non-switch-capable agent ignores it, and an unknown id fails in-session, not at open.
      expect(body.toLowerCase()).toContain('ignore')
      // Per-role model is what lets ONE spawn-team call mix tiers; the JSON example must show it.
      expect(body).toContain('"model"')
    }
  })

  it('both agent-facing texts document --base accepting a station id (issue #530)', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      // The flag surface must show the widened grammar…
      expect(body).toContain('--base <ref|stationId>')
      // …and both hard truths beside it: what a station id resolves to, and that the base is
      // captured at CREATION (the deferred-resolution half of #530 is not built — an agent that
      // reads this text and assumes lazy capture bases a wave on an empty branch).
      expect(body.toLowerCase()).toContain('station')
      expect(body).toMatch(/captured when the worktree is CREATED/i)
    }
  })

  it('both agent-facing texts document --dry-run, derived from DRY_RUN_VERBS (issue #532)', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      expect(body).toContain('--dry-run')
      // The verb list is RENDERED from the set (dryRunDocLines) — walk the real set so a verb
      // added to the gate lands in the text the day it is added, and a removed one reds here.
      for (const v of DRY_RUN_VERBS) expect(body).toContain(v)
      // Both hard edges must be stated, or an agent discovers them by losing a call to each:
      // unsupported verbs refuse, and --project cannot be combined.
      expect(body.toLowerCase()).toContain('refuses `--dry-run`')
      expect(body).toContain('cannot be combined with `--project`')
    }
  })

  it('both agent-facing texts document --prompt-file and the one-line --prompt fact (issue #520)', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      // `assembleLaunchCommand` collapses every whitespace run in a --prompt literal (it rides
      // argv on a line typed into the pane). An agent that does not know this writes a numbered
      // brief and gets one paragraph — and the fix, --prompt-file, is useless undocumented.
      expect(body.toUpperCase()).toContain('ONE LINE')
      expect(body).toContain('--prompt-file')
      // The per-role escape on spawn-team must be named too, or teams stay prose-only.
      expect(body).toContain('promptFile')
      // The failure that costs a whole station: flattened, a leading slash command swallows the
      // task as its argument, and the node then reads as idle to `--after`.
      expect(body.toLowerCase()).toMatch(/begin a prompt with `\/`|start a prompt with `\/`/)
    }
  })

  it('both agent-facing texts say the open reply reports `queued` (issue #569 item 1)', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      // The field itself, and the list that says WHICH ids — a caller that cannot name the queued
      // nodes cannot act on the answer.
      expect(body).toContain('queued')
      expect(body).toContain('queuedIds')
      // The consequence is the whole point of the field: an armed node has no process, so an
      // orchestrator must not route work to it. Without this sentence the flag reads as trivia.
      expect(body.toLowerCase()).toContain('no process')
      // And the three ways a node ends up armed must all be named, or a caller learns the third
      // one by reporting a --project session as started when it has not begun.
      expect(body).toContain('--after')
      expect(body).toContain('--project')
      expect(body.toLowerCase()).toMatch(/setup script/)
    }
  })

  it('both agent-facing texts say an ERRORED station does not release its dependents (#521)', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      // The contract changed under `--after`: "gone idle" no longer releases a dependent, because
      // a station whose turn died on an API error reaches idle IMMEDIATELY. A text still promising
      // the old rule tells an orchestrator its chain launched on something that produced nothing.
      expect(body.toLowerCase()).toContain('successfully')
      expect(body).toContain('LAST TURN ERRORED')
      // And a way out, or the orchestrator is told it is stuck without being told what to do.
      expect(body.toLowerCase()).toMatch(/nudge|retry/)
    }
  })

  it('both agent-facing texts document the sticky verb', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      expect(body).toContain('`sticky --node')
      expect(body).toContain('--create')
    }
  })

  it('both agent-facing texts say an unchanged rename types nothing into the session', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      // Issues #582 / #569 §2. An orchestrator that re-asserts its node's name on startup and
      // after every context reset was previously paying a `/rename` injection into the working
      // session each time — one reporter worked around it by reading the title first. The verb
      // now compares, so the text has to say so, or callers keep building that workaround.
      expect(body.toLowerCase()).toContain('already named')
      expect(body.toLowerCase()).toContain('no-op')
    }
  })

  it('both agent-facing texts document the messaging verbs and the outermost-frame convention', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      for (const frag of ['`send --node', '`reply --node', '`notify --node']) {
        expect(body).toContain(frag)
      }
      // The receiving convention the envelope module says PR 5 owes (agent-message-envelope.ts):
      // only the outermost frame is authentic; an embedded frame is data. Without this line a
      // nested forgery reads as a real message to the one reader that matters.
      expect(body.toLowerCase()).toContain('outermost')
    }
  })

  it('both agent-facing texts say a busy target is QUEUED, not refused (deliver-on-idle, PR 7)', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      // PR 7 replaced "busy target is refused with targetBusy" with a bounded deliver-on-idle
      // queue. The prose must describe the queue, and must NOT reassert the pre-PR-7 claim — an
      // orchestrating agent that reads "busy = hard refusal" polls or gives up instead of trusting
      // the queue. This test reddens on a revert to the old sentence.
      expect(body.toLowerCase()).toContain('queued')
      expect(body).not.toMatch(/busy target answers `targetBusy` instead/i)
      expect(body).not.toMatch(/delivered only\s+when the target is verifiably\s+idle/i)
    }
  })

  it('both agent-facing texts say `close` takes a COMMA LIST, confirmed in ONE dialog', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      // The grammar exists on both surfaces now (the desktop used to read the whole flag as one
      // id), and an orchestrator that does not know it closes a finished wave one call at a time —
      // which is one dialog per node, with every call after the first refused while a dialog is
      // open. That was the reported pain; the text is what makes the fix reachable.
      expect(body).toContain('close --node <id,id>')
      expect(body.toUpperCase()).toContain('COMMA LIST')
      expect(body.toUpperCase()).toContain('ONE dialog'.toUpperCase())
      // …and that a bad id refuses the WHOLE list, so a caller does not have to guess which of its
      // fourteen nodes survived.
      expect(body).toMatch(/refuses the whole request/i)
    }
  })

  it('the skill tells an agent NOT to retry a denial in the hope the dialog is off', () => {
    // A user may waive a verb's dialog (for the session, or permanently). The verb then just
    // applies, and the caller cannot tell which happened — so the one behaviour to rule out
    // explicitly is re-sending a `denied by user` request to see whether it lands this time.
    const body = buildCanvasSkillBody('/x/shim.sh')
    expect(body).toMatch(/never re-send a `denied by user` request/i)
    // And "a confirmation is already pending" must not read as an invitation to spin.
    expect(body).toContain('a confirmation is already pending')
    expect(body).toMatch(/do not spin/i)
  })

  it('both agent-facing texts state the Server creator-ownership and inert-boot contract', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      expect(body).toContain('ownership is fail-closed')
      expect(body).toContain('verified node identity')
      expect(body).toContain('current server run')
      expect(body).toMatch(/never[\s\S]*auto-adopted[\s\S]*relaunched[\s\S]*controlled at boot/)
      expect(body).toContain('before any partial mutation')
    }
  })

  it('renders the RETRYABLE table — the table is the source, not a re-typed copy', () => {
    const body = buildCanvasSkillBody('/x/shim.sh')
    const yesAt = body.indexOf('Worth retrying')
    const noAt = body.indexOf('NOT worth retrying')
    expect(yesAt).toBeGreaterThan(-1)
    expect(noAt).toBeGreaterThan(yesAt)
    const yesSection = body.slice(yesAt, noAt)
    const noSection = body.slice(noAt, body.indexOf('\n', noAt + 200) === -1 ? undefined : body.length)
    for (const [kind, retryable] of Object.entries(RETRYABLE)) {
      const word = new RegExp(`\\b${kind}\\b`)
      expect(word.test(retryable ? yesSection : noSection), `${kind} in its group`).toBe(true)
      expect(word.test(retryable ? noSection : yesSection), `${kind} not in the other`).toBe(false)
    }
  })

  // --- the `browser` verb's agent-facing docs (S8 PR 10 Task 10.1) -----------------------------
  // The flag surface is code (`BROWSER_ACTION_KEYS` + the modifier list); the doc must carry every
  // flag, so a flag added to the parser without a doc line reddens here rather than shipping unseen.
  it('both agent-facing texts document the browser verb and its FULL flag surface', () => {
    // The modifiers `parseBrowserArgs` reads off the arg map, listed here so the doc cannot drop one.
    const modifierFlags = ['into', 'clear', 'press', 'times', 'scroll', 'wait', 'timeout', 'screenshot', 'cookies']
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      expect(body).toContain('`browser --node')
      // Every action key from the pure parser table appears as a documented `--<key>` flag.
      for (const key of BROWSER_ACTION_KEYS) {
        expect(body, `action --${key} documented`).toContain(`--${key}`)
      }
      for (const flag of modifierFlags) {
        expect(body, `modifier --${flag} documented`).toContain(`--${flag}`)
      }
    }
  })

  it('both browser docs teach refs over selectors and state the real contract', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      const lower = body.toLowerCase()
      // Teach @refs over CSS selectors (Task 10.1).
      expect(body).toContain('@ref')
      expect(lower).toContain('prefer')
      expect(lower).toContain('selector')
      // Verified-only + the per-project switch, OFF by default.
      expect(lower).toContain('verified')
      expect(lower).toMatch(/off by default/)
      // Cookies are LOUDLY TRACED, and cookie WRITES are refused.
      expect(lower).toContain('trace')
      expect(lower).toMatch(/no set-cookie|writes are not|cannot set|no cookie-write/)
      // Server Edition has no browser control.
      expect(lower).toContain('server edition')
    }
  })

  // The consent sentence is a contract string owned by browser-drive.ts (main). The doc must carry
  // it BYTE-FOR-BYTE so an agent that reads it stops instead of burning a turn — importing the real
  // constant here reddens the doc on any drift of the source string.
  it('both browser docs carry the capability-off sentence verbatim from the source', () => {
    for (const body of [buildCanvasSkillBody('/x/shim.sh'), buildCanvasControlInstructions('/tmp/nodeterm.sh')]) {
      expect(body).toContain(BROWSER_CAPABILITY_OFF_MESSAGE)
    }
  })

  it('renders the browser retry table from BROWSER_RETRYABLE, not re-typed prose', () => {
    const body = buildCanvasSkillBody('/x/shim.sh')
    const yesAt = body.indexOf('Browser outcomes worth retrying')
    const noAt = body.indexOf('Browser outcomes that are terminal')
    expect(yesAt).toBeGreaterThan(-1)
    expect(noAt).toBeGreaterThan(yesAt)
    const yesSection = body.slice(yesAt, noAt)
    const noSection = body.slice(noAt, body.indexOf('\n\n', noAt) === -1 ? undefined : body.indexOf('\n\n', noAt))
    for (const [kind, retryable] of Object.entries(BROWSER_RETRYABLE)) {
      const label = BROWSER_OUTCOME_LABEL[kind as keyof typeof BROWSER_OUTCOME_LABEL]
      expect((retryable ? yesSection : noSection).includes(label), `${kind} label in its group`).toBe(true)
      expect((retryable ? noSection : yesSection).includes(label), `${kind} label not in the other`).toBe(false)
    }
  })

  it('spawn-team requires --team and none of the layout verbs are destructive', () => {
    expect(parseControlRequest('spawn-team', {})).toEqual({ error: 'spawn-team requires --team <json>' })
    expect(parseControlRequest('spawn-team', { team: '[]' })).toEqual({ verb: 'spawn-team', args: { team: '[]' } })
    for (const v of ['group', 'arrange', 'align', 'spawn-team'] as const) {
      expect(isDestructiveVerb(v)).toBe(false)
    }
  })
})

/**
 * The claim `node-identity-policy.ts` makes about itself, checked against the real verb model.
 *
 * `STRICT_CONTROL_VERBS` is pre-positioned: the ordering is fixed before the verb it is for
 * exists, so the verb cannot arrive through the `override === false` hole. These two tests are
 * what stop that from quietly becoming a false claim in either direction — the first FAILS on the
 * day the real `browser` verb lands, which is exactly when the PR body, the changelog and the
 * Settings copy all have to stop saying "nothing changes for anyone".
 */
describe('the strict identity bucket now gates a real verb', () => {
  it('`browser` IS a real verb (PR 7) AND is in the verified-only bucket', () => {
    // The day the real `browser` verb lands, this assertion FLIPS from "not a verb" to "a real,
    // strict verb" — which is exactly when the PR body, the changelog and the Settings copy stop
    // saying "nothing changes for anyone". It requires `--node` and is otherwise validated by the
    // pure `parseBrowserArgs` in the drive path.
    expect(STRICT_CONTROL_VERBS.has('browser')).toBe(true)
    expect(parseControlRequest('browser', {})).toEqual({ error: 'browser: --node <id> is required' })
    expect(parseControlRequest('browser', { node: 'browser-1', read: 'title' })).toEqual({
      verb: 'browser',
      args: { node: 'browser-1', read: 'title' }
    })
  })

  it('`open-browser` IS a real verb and is deliberately NOT in the bucket', () => {
    // Opening a node is not driving one, and open-browser has a live legacy population that a
    // strict gate would strand with no way back. See STRICT_CONTROL_VERBS' doc comment.
    expect(parseControlRequest('open-browser', { url: 'https://example.com' })).toEqual({
      verb: 'open-browser',
      args: { url: 'https://example.com' }
    })
    expect(STRICT_CONTROL_VERBS.has('open-browser')).toBe(false)
  })
})

/**
 * The messaging verbs are LIVE as of PR 5. The tripwire that used to sit here ("refused by the
 * parser, so nothing routes them today") did its one job — it failed on the day the verbs landed —
 * and is replaced by the positive claims: the verbs parse, a target is required, and they are
 * verified-only at the route (`messaging-verified-only.test.ts`) with the delivery itself behind
 * the per-project switch, off by default.
 */
describe('the messaging verbs parse', () => {
  it('send and reply accept a target and require one', () => {
    expect(parseControlRequest('send', { node: 'n-1', text: 'hi' })).toEqual({
      verb: 'send',
      args: { node: 'n-1', text: 'hi' }
    })
    expect(parseControlRequest('reply', { node: 'n-1', text: 'hi' })).toEqual({
      verb: 'reply',
      args: { node: 'n-1', text: 'hi' }
    })
    expect(parseControlRequest('send', { text: 'hi' })).toEqual({
      error: 'send requires --node <id>'
    })
    expect(parseControlRequest('reply', { text: 'hi' })).toEqual({
      error: 'reply requires --node <id>'
    })
  })

  // #98's validation, kept verbatim: notify carries NO caller text — its body is app-owned.
  it('requires a target for notify and does not accept message text', () => {
    expect(parseControlRequest('notify', {})).toEqual({ error: 'notify requires --node <id>' })
    expect(parseControlRequest('notify', { node: 'n1' })).toEqual({
      verb: 'notify',
      args: { node: 'n1' }
    })
    expect(parseControlRequest('notify', { node: 'n1', text: 'custom prompt' })).toEqual({
      error: 'notify does not accept --text'
    })
    expect(isDestructiveVerb('notify')).toBe(false)
  })
})

describe('open-project + --project docs land with the dispatch (issue #338, spec §8)', () => {
  const bodies: [string, string][] = [
    ['skill', buildCanvasSkillBody('/x/shim.sh')],
    ['instructions', buildCanvasControlInstructions('/x/shim.sh')]
  ]

  it('both bodies document open-project: idempotent, confirmed (a denial is final), local-only, the returned id, no tab focus', () => {
    for (const [name, body] of bodies) {
      expect(body, name).toContain('open-project --cwd')
      expect(body, name).toMatch(/[Ii]dempotent/)
      // The confirm may be denied, and a denial is terminal — never advice to retry it.
      expect(body, name).toMatch(/denial is final/)
      // Local-only (B5) and no focus (B4), stated to the agent as facts.
      expect(body, name).toMatch(/refused from an SSH project/)
      expect(body, name).toMatch(/never\s+focuses/)
      expect(body, name).toContain('projectId')
    }
  })

  it('every --project-targetable verb line documents the flag — walked off the REAL set', () => {
    // The drift alarm walks PROJECT_TARGETABLE_VERBS (src/core/project-grants.ts) rather than a
    // re-typed list: a fourth verb joining the set without its doc line goes red here, and a doc
    // line dropping the flag goes red too.
    for (const [name, body] of bodies) {
      for (const verb of PROJECT_TARGETABLE_VERBS) {
        const line = body.split('\n').find((l) => l.includes(`\`${verb} `))
        expect(line, `${name}: a doc line for ${verb}`).toBeTruthy()
        expect(line, `${name}: ${verb} documents --project`).toContain('--project')
      }
    }
  })

  it('both bodies state the own-or-returned-id rule as fact, the cold-open contract, and the flag exclusion', () => {
    for (const [name, body] of bodies) {
      expect(body, name).toContain('any other id is refused')
      // The cold-open sentence: a session opened into a non-active project starts when the user
      // next views it — and the agent is told not to poll for that.
      expect(body, name).toMatch(/starts when the user next views/)
      expect(body, name).toMatch(/do not poll/)
      expect(body, name).toMatch(/`--group`\/`--after` cannot\s+be combined with `--project`/)
    }
  })

  it('tells the agent that opened nodes AND --after stations are already linked — nothing to `link`', () => {
    for (const [name, body] of bodies) {
      expect(body, name).toMatch(/roped to each (listed )?station/)
      expect(body, name).toMatch(/dashed while it waits/)
      expect(body, name).toMatch(/already\s+linked/)
      expect(body, name).toMatch(/nothing to `link`/)
      // Only the skill body carries the orchestration recipe, so only it has the step-5 sentence
      // that had to stop saying an unopened station is unlinked — an `--after` station is linked.
      if (name === 'skill') expect(body, name).toMatch(/neither opened nor named in `--after`/)
    }
  })

  it('the orchestration recipe gains the multi-repo pattern', () => {
    for (const [name, body] of bodies) {
      expect(body, name).toContain('one project per repository')
      expect(body, name).toContain('open-project --cwd <repo>')
      // v1 has no cross-project links; the workaround is named.
      expect(body, name).toMatch(/reader agent inside that project/)
    }
  })
})

describe('the --project clause tells the truth about travel (review #363 I-1 + M-3)', () => {
  const bodies: [string, string][] = [
    ['skill', buildCanvasSkillBody('/x/shim.sh')],
    ['instructions', buildCanvasControlInstructions('/x/shim.sh')]
  ]

  it('no open switches the view — the own-id "travel included" claim is GONE from both bodies', () => {
    for (const [name, body] of bodies) {
      // The clause slice: from the `--project` flag doc to the open-project entry that follows
      // it in both bodies — anchored, so a caveat cannot drift into another paragraph (the
      // recipe) and still count (M-3).
      const start = body.indexOf('`--project <id>`')
      const end = body.indexOf('open-project --cwd')
      expect(start, `${name}: clause start`).toBeGreaterThan(-1)
      expect(end, `${name}: clause before the open-project entry`).toBeGreaterThan(start)
      const clause = body.slice(start, end)
      // Own id ≡ the flag omitted — still true, and still the whole of what that leg promises.
      expect(clause, name).toMatch(/behaves exactly as if the flag\s+were omitted/)
      // THE STALE CLAIM. Passing your own id (or omitting the flag) used to switch the user's
      // view to your project; it no longer does — an open whose own project is not on screen is
      // written COLD into it (lib/coldOpen, `canColdOpen`). A body still promising a view switch
      // describes a product that no longer exists, and an orchestrator reading it would expect
      // the user to be looking at what it opened.
      expect(body, name).not.toMatch(/view switch\s+included/)
      expect(body, name).not.toMatch(/a normal open, view switch/)
      // The old universal phrasing ("without switching the user's view", said of the whole flag)
      // stays gone too — the promise now belongs to EVERY open, stated in its own sentence.
      expect(body, name).not.toMatch(/without switching/)
      // M-3: the do-not-poll caveat and the refusal rule live in the clause ITSELF — dropping
      // them here while the recipe's copy survives is red.
      expect(clause, name).toMatch(/do not poll/)
      expect(clause, name).toContain('any other id is refused')
    }
  })

  it('both bodies document the OWN-project cold open: never switches the view, queued, closed case', () => {
    // The behaviour change this test exists for. All four facts an orchestrator acts on:
    // (1) an open never moves the user, (2) a node opened into a project they are not viewing
    // starts when they next view it, (3) the reply says so via `queued`, (4) a CLOSED project is
    // still written into and the tab is NOT reopened.
    for (const [name, body] of bodies) {
      expect(body, `${name}: never switches the view`).toMatch(
        /open NEVER switches the user'?s view|OPEN NEVER SWITCHES THE USER'?S VIEW/i
      )
      expect(body, `${name}: cold`).toMatch(/cold/i)
      expect(body, `${name}: queued`).toContain('queued')
      expect(body, `${name}: closed project`).toMatch(/closed/i)
      expect(body, `${name}: tab not reopened`).toMatch(/not reopened/i)
    }
  })

  it('both bodies say the DISPLAY verbs do not switch the view either — and are never queued', () => {
    // The second half of the same promise, and the half an agent meets most often: a skill that
    // renders its report as HTML reaches for `show-web` every time it finishes. Two facts it acts
    // on, and the second is why these are not folded into the cold-open sentence: the node is
    // COMPLETE when placed, so a caller told "queued" would wait for something that has already
    // happened. The `offCanvas` field is what it reads instead.
    for (const [name, body] of bodies) {
      const start = body.indexOf('`show-image')
      const end = body.indexOf('`group --nodes', start)
      expect(start, `${name}: the display-verb entries`).toBeGreaterThan(-1)
      expect(end, `${name}: the group entry after them`).toBeGreaterThan(start)
      const clause = body.slice(start, end)
      expect(clause, `${name}: never switches the view`).toMatch(/never switch(es)? the user'?s view/i)
      expect(clause, `${name}: names the field`).toContain('offCanvas')
      // THE STALE CLAIM the split exists to prevent: a display verb reported as queued.
      expect(clause, `${name}: not queued`).toMatch(/nothing (here )?is (ever )?\`?queued/i)
    }
  })
})
