// Source-text guards over the gates in `TerminalNode.tsx` that no test can reach behaviourally.
//
// Two families live here, for the same reason: neither `TerminalNode.tsx` nor `Canvas.tsx` is
// unit-rendered anywhere in this repo, so a wrong gate compiles, ships, and leaves the whole suite
// green. Both were verified by MUTATION — revert a gate and the matching test below fails.
//   1. the TWO TITLE gates (read vs write), below;
//   2. the CLAUDE-TRANSCRIPT gates (meter rehydration, find-bar transcript index, and the search
//      tooltip that describes them) at the bottom of this file.
//
// A guard over the TWO title gates, because the split is the whole point of the title lists.
//
// Reading a session's own name (`TITLE_READ_CAPABLE` — claude, grok, gemini) and PUSHING a name into
// a session (`RENAME_CAPABLE` — claude, grok) are different capabilities. Gating the poll on the
// write list costs gemini the title it names itself; gating a push on the read list types
// `/rename <name>` into a CLI that has no such command, in front of the user, on every rename.
//
// Neither `TerminalNode.tsx` nor `Canvas.tsx` is unit-rendered anywhere in this repo, so there is no
// behavioural test to catch either mistake — these are asserted over the SOURCE TEXT, the same
// technique `core/no-electron.test.ts` uses for the shell boundary. If a refactor moves a gate, the
// invariant is what matters: the poll reads, the push writes.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
const terminalNode = read('nodes/TerminalNode.tsx')
const canvas = read('canvas/Canvas.tsx')
const sessionRename = read('lib/sessionRename.ts')

describe('session-name title gates', () => {
  it('the node-title poll is gated on the READ capability', () => {
    // The effect that adopts the agent's own session name into data.title.
    expect(terminalNode).toContain(
      'const canReadTitleNode = !!agentHarnessId && canReadTitle(agentHarnessId)'
    )
    expect(terminalNode).toContain('if (!canReadTitleNode || data.titleAuto === false) return')
    // The pre-split gate must be gone from that effect — with it, a gemini node never polls.
    expect(terminalNode).not.toContain('if (!canRenameNode || data.titleAuto === false) return')
  })

  it('the `/rename` push is gated on the WRITE capability', () => {
    // Matched on `renameCommand(` rather than the literal `/rename `: the line is no longer
    // composed here — see the next test for why that matters.
    const pushes = terminalNode
      .split('\n')
      .filter((l) => l.includes('renameCommand(') && l.includes('sendText'))
    expect(pushes.length).toBe(1)
    expect(pushes[0]).toContain('canRenameNode')
  })

  it('SECURITY: nobody composes the `/rename` line by hand — it comes from `renameCommand`', () => {
    // `renameCommand` is where the title is stripped to ONE line (`@shared/one-line`), because
    // `sendText` appends Enter and a `\n`/`\r` in the title would submit a SECOND line — a command
    // the agent's operator never typed. The title is agent-supplied (the canvas-control `rename`
    // verb's `--title`) and model-supplied (✦ Name with AI), so a second, hand-rolled composition
    // site would be a second hole. This is the guard that keeps the strip un-bypassable; a
    // behavioural test cannot see it, because neither file is unit-rendered.
    for (const [name, src] of [
      ['nodes/TerminalNode.tsx', terminalNode],
      ['canvas/Canvas.tsx', canvas]
    ] as const) {
      // The composition shape specifically — a template literal interpolating the name — not the
      // string `/rename`, which both files mention in prose.
      expect(src.includes('`/rename ${'), `${name} composes the rename line itself`).toBe(false)
    }
    expect(sessionRename).toContain('export function renameCommand')
    expect(sessionRename).toContain('oneLine(name)')
  })

  it('no rename-WRITE site gates on the read capability', () => {
    // These three files hold every push of a node title into a live session (the node header /
    // ✦ AI-name funnel, the canvas-control `rename` verb, `renameSession`, and the pane-probing
    // helper they all use). None of them may ever consult the READ list: an agent that names its
    // own sessions does not necessarily accept a rename.
    // TerminalNode's own push is covered by the test above (it holds both gates, so a
    // whole-file scan would say nothing); these are the files that hold ONLY write paths.
    for (const [name, src] of [
      ['Canvas.tsx', canvas],
      ['lib/sessionRename.ts', sessionRename]
    ] as const) {
      expect(src.includes('canReadTitle'), name).toBe(false)
    }
  })

  it('every canvas rename push sits behind a canRename guard', () => {
    const lines = canvas.split('\n')
    const calls = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes('pushSessionRename('))
    expect(calls.length).toBeGreaterThan(0)
    for (const [line, i] of calls) {
      // The guard is an `if (agentId && canRename(agentId) && …)` a few lines above the call.
      const window = lines.slice(Math.max(0, i - 8), i + 1).join('\n')
      expect(window.includes('canRename('), `${i + 1}: ${line.trim()}`).toBe(true)
    }
  })
})

/**
 * The claude-transcript gates: `claudeTranscript` (`readsClaudeTranscript(agentHarnessId)`), NOT
 * `showUsage` (`hasUsage(agentHarnessId)`).
 *
 * `USAGE_CAPABLE` grew to claude + codex + gemini, so `showUsage` is now true for three agents while
 * only ONE of them has a claude transcript. Both readers behind these gates resolve a session id
 * through claude's `resolveTranscript`, whose cwd fallback answers *the newest claude transcript for
 * that cwd* — so on a codex or gemini node they resolve an UNRELATED claude session and then meter
 * it, and search it, under this node's session id. That was this branch's own Critical fix, and
 * reverting either gate to `showUsage` left the full suite green: nothing in this repo renders
 * `TerminalNode`, so this file is the only thing standing between the bug and a re-landing.
 *
 * Asserted per LINE rather than with `toContain` over a 6000-line file: a whole-file `toContain`
 * failure dumps the file as its diff, and a per-line assertion names the site instead.
 */
describe('claude-transcript gates', () => {
  const lines = terminalNode.split('\n')
  /** The lines mentioning `needle`, 1-indexed, as `[lineNo, text]`. */
  const sites = (needle: string): [number, string][] =>
    lines.map((l, i) => [i + 1, l] as [number, string]).filter(([, l]) => l.includes(needle))

  it('is derived from the agent, not from the meter', () => {
    // The fact itself, kept separate from `showUsage` one line above it.
    expect(terminalNode).toContain(
      'const claudeTranscript = readsClaudeTranscript(agentHarnessId)'
    )
    expect(terminalNode).toContain(
      'const showUsage = !!agentHarnessId && hasUsage(agentHarnessId)'
    )
  })

  it('gates the mount-time meter rehydration (`context.ensure`)', () => {
    const found = sites('window.nodeTerminal.context.ensure(')
    expect(found.length).toBe(1)
    const [lineNo] = found[0]
    // The `if (…) ensure(…)` guard is the line above the call.
    const guard = lines.slice(Math.max(0, lineNo - 3), lineNo).join('\n')
    expect(guard, `${lineNo}: context.ensure guard`).toContain('claudeTranscript')
    expect(guard, `${lineNo}: context.ensure guard`).not.toContain('showUsage')
  })

  it('gates the find bar’s transcript index (`searchTranscript`)', () => {
    const found = sites('searchTranscript:')
    expect(found.length).toBe(1)
    const [lineNo, text] = found[0]
    expect(text, `${lineNo}: ${text.trim()}`).toContain('claudeTranscript')
    expect(text, `${lineNo}: ${text.trim()}`).not.toContain('showUsage')
  })

  it('describes the search the node actually runs, in the button tooltip', () => {
    // A tooltip keyed on `showUsage` promises a codex/gemini node "Search terminal + conversation"
    // while its transcript leg is off — the copy has to follow the gate, not the meter.
    const found = sites("'Search terminal + conversation'")
    expect(found.length).toBe(1)
    const [lineNo, text] = found[0]
    expect(text, `${lineNo}: ${text.trim()}`).toContain('claudeTranscript ?')
    expect(text, `${lineNo}: ${text.trim()}`).not.toContain('showUsage')
  })

  it('leaves the meter itself on the meter capability', () => {
    // The inverse mistake: `USAGE_CAPABLE` is what decides whether a meter is shown at all, and
    // narrowing THAT to claude would take codex's and gemini's meters away.
    const found = sites('<ContextMeter')
    expect(found.length).toBe(1)
    const [lineNo, text] = found[0]
    expect(text, `${lineNo}: ${text.trim()}`).toContain('showUsage &&')
  })
})
