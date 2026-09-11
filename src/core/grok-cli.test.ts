import { describe, it, expect } from 'vitest'
import { grokCapsFromRunner, grokCliCapsFrom, UNKNOWN_GROK_CLI_CAPS } from './grok-cli'

// Verbatim from `grok --help` on 1.0.13 (2026-09-02). The two lines matter for opposite reasons:
// the first DEFINES the flag, the second only MENTIONS it inside another option's prose.
const REAL_HELP = `
  -c, --continue
          Continue the most recent session for the current working directory
      --fork-session
          When resuming (\`--resume\` / \`--continue\`), create a new session ID instead of reusing the original (optionally set via \`--session-id\`)
  -r, --resume [<SESSION_ID_OR_TITLE>]
          Resume a session by ID or title, or the most recent if omitted
  -s, --session-id <SESSION_ID>
          Use a specific session UUID for a **new** conversation (must be a valid UUID and must not already exist under the target session directory)
`

describe('grokCliCapsFrom', () => {
  it('detects the flag from the real help text', () => {
    expect(grokCliCapsFrom(REAL_HELP)).toEqual({ sessionIdFlag: true, models: [] })
  })

  it('is not fooled by a longer flag that merely starts the same', () => {
    // The word-boundary anchor. `--session-id-file` is a different flag; answering yes for it would
    // put an unknown option on the command line, and an unknown option makes grok EXIT — the launch
    // dies rather than degrading.
    expect(grokCliCapsFrom('  --session-id-file <PATH>\n')).toEqual({ sessionIdFlag: false, models: [] })
  })

  it('is not fooled by a prose mention inside another option', () => {
    // grok's own help does this: `--fork-session`'s description says "optionally set via
    // `--session-id`". Backticks are not whitespace, so the anchor rejects it — but the case is
    // pinned because grok WRITES it, not because it is hypothetical.
    const proseOnly =
      '      --fork-session\n          create a new session ID instead of reusing the original (optionally set via `--session-id`)\n'
    expect(grokCliCapsFrom(proseOnly)).toEqual({ sessionIdFlag: false, models: [] })
  })

  it('answers no for absent, empty and unreadable help', () => {
    // A failed probe must mean "omit the flag", never "block the launch".
    expect(grokCliCapsFrom('')).toEqual(UNKNOWN_GROK_CLI_CAPS)
    expect(grokCliCapsFrom(null)).toEqual(UNKNOWN_GROK_CLI_CAPS)
    expect(grokCliCapsFrom(undefined)).toEqual(UNKNOWN_GROK_CLI_CAPS)
    expect(UNKNOWN_GROK_CLI_CAPS.sessionIdFlag).toBe(false)
  })

  it('accepts the `=` spelling and end-of-line', () => {
    expect(grokCliCapsFrom('--session-id=<ID>').sessionIdFlag).toBe(true)
    expect(grokCliCapsFrom('  -s, --session-id').sessionIdFlag).toBe(true)
  })
})

describe('grokCliCapsFrom — the model catalogue rides the same probe', () => {
  it("carries grok's own model ids when `grok models` answered", () => {
    const models = 'Available models:\n  * grok-4.6 (default)\n  - grok-4.5\n'
    expect(grokCliCapsFrom('-s, --session-id <ID>', models).models).toEqual(['grok-4.6', 'grok-4.5'])
  })

  it('is empty when that subcommand failed, without costing the help answer', () => {
    // Two spawns, two independent degrades: a `grok models` that errors must not also throw away
    // what `--help` already told us about `--session-id`.
    const caps = grokCliCapsFrom('-s, --session-id <ID>', null)
    expect(caps.sessionIdFlag).toBe(true)
    expect(caps.models).toEqual([])
  })
})

describe('grokCapsFromRunner — both subcommands are actually asked', () => {
  it('asks --help AND models, and feeds both into the caps', async () => {
    const asked: string[][] = []
    const caps = await grokCapsFromRunner(async (args) => {
      asked.push(args)
      return args[0] === '--help'
        ? '-s, --session-id <ID>'
        : 'Available models:\n  - grok-4.6\n'
    })
    expect(asked).toEqual([['--help'], ['models']])
    expect(caps).toEqual({ sessionIdFlag: true, models: ['grok-4.6'] })
  })

  it('keeps the help answer when `models` fails', async () => {
    const caps = await grokCapsFromRunner(async (args) =>
      args[0] === '--help' ? '-s, --session-id <ID>' : null
    )
    expect(caps).toEqual({ sessionIdFlag: true, models: [] })
  })

  it('gives up entirely when --help itself fails', async () => {
    // No help means we know nothing about this binary; guessing from a models list alone would be
    // claiming a flag we never saw advertised.
    expect(await grokCapsFromRunner(async () => null)).toEqual(UNKNOWN_GROK_CLI_CAPS)
  })
})
