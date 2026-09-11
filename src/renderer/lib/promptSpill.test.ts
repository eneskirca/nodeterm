import { describe, expect, it, vi } from 'vitest'
import {
  LAUNCH_PROMPT_BUDGET_BYTES,
  encodeUtf8Base64,
  flattenPrompt,
  promptExceedsLineBudget,
  shouldSpillPrompt,
  spillPromptToFile
} from './promptSpill'
import { MAX_LAUNCH_LINE_BYTES, fitsLaunchLine, lineBytes } from '@shared/canonical-line'
import { DEFAULT_LENSES, verifyLensPrompt, verifySynthesisPrompt } from './verifyPanel'
import { assembleLaunchCommand } from '@shared/agents/launch'

const io = (saveUpload: (n: string, d: string) => Promise<string | null>) => ({
  saveUpload,
  encodeBase64: encodeUtf8Base64
})

describe('the spill decision', () => {
  it('leaves a short prompt alone — the command line stays byte-identical', () => {
    expect(promptExceedsLineBudget('hello')).toBe(false)
    expect(shouldSpillPrompt('hello', true)).toBe(false)
    expect(promptExceedsLineBudget(undefined)).toBe(false)
  })

  it('spills a prompt over the budget on a local project', () => {
    const long = 'x'.repeat(LAUNCH_PROMPT_BUDGET_BYTES + 1)
    expect(promptExceedsLineBudget(long)).toBe(true)
    expect(shouldSpillPrompt(long, true)).toBe(true)
  })

  it('NEVER spills for an SSH project — the file would land on the wrong machine', () => {
    // `saveUpload` writes where this renderer's core runs; an SSH pane runs on the host, so the
    // composed `"$(cat …)"` would read a path that does not exist there and start the agent with
    // an EMPTY prompt. A prompt at risk of truncation must not become one that is certainly gone.
    const long = 'x'.repeat(LAUNCH_PROMPT_BUDGET_BYTES + 1)
    expect(shouldSpillPrompt(long, false)).toBe(false)
  })

  it('measures the FLATTENED prompt, which is what actually gets typed', () => {
    // A prompt padded out with newlines collapses to one space per run before it reaches the
    // pane, so judging the raw text would spill a line that was never going to be long.
    const padded = 'a'.repeat(100) + '\n'.repeat(LAUNCH_PROMPT_BUDGET_BYTES)
    expect(lineBytes(padded)).toBeGreaterThan(LAUNCH_PROMPT_BUDGET_BYTES)
    expect(promptExceedsLineBudget(padded)).toBe(false)
  })
})

describe('spillPromptToFile', () => {
  it('writes the FLATTENED prompt, so a prompt does not change meaning with its length', () => {
    // Under the budget `--prompt` arrives with every whitespace run collapsed (the assembler does
    // it, and the agent-facing docs promise it). If the spilled file kept the newlines, the same
    // flag would mean two different things either side of an invisible threshold.
    const save = vi.fn(async (_n: string, _d: string) => '/tmp/p.txt' as string | null)
    return spillPromptToFile('one\n\ntwo   three', io(save)).then((path) => {
      expect(path).toBe('/tmp/p.txt')
      const written = Buffer.from(String(save.mock.calls[0][1]), 'base64').toString('utf8')
      expect(written).toBe('one two three')
    })
  })

  it('round-trips non-ASCII — a prompt is full of em dashes and ellipses', () => {
    const save = vi.fn(async (_n: string, _d: string) => '/tmp/p.txt' as string | null)
    const text = 'a — b … ç'
    return spillPromptToFile(text, io(save)).then(() => {
      expect(Buffer.from(String(save.mock.calls[0][1]), 'base64').toString('utf8')).toBe(text)
    })
  })

  it('fails OPEN: a writer that returns null or throws yields null, never a bad path', async () => {
    expect(await spillPromptToFile('x', io(async () => null))).toBeNull()
    expect(
      await spillPromptToFile(
        'x',
        io(async () => {
          throw new Error('E_UNSUPPORTED')
        })
      )
    ).toBeNull()
  })

  it('never reuses a name — two spills in the same millisecond are separate files', async () => {
    const names: string[] = []
    const sink = io(async (n) => {
      names.push(n)
      return `/tmp/${n}`
    })
    await Promise.all([spillPromptToFile('a', sink), spillPromptToFile('b', sink)])
    expect(new Set(names).size).toBe(2)
  })
})

describe("verify's own prompts (the case that fires with no user input)", () => {
  const shimPath = '/Users/x/Library/Application Support/node-terminal/context-link/context.sh'
  const targetId = 'n'.repeat(22)

  it('every default lens is over the budget, so the panel spills instead of truncating', () => {
    // The reporter's table, reproduced from the shipped prompt builder: with a nine-character
    // node title and NO `--focus`, the assembled `security` and `tests` commands are 1045 and
    // 1044 bytes against a 1024-byte MAX_CANON. This asserts the whole panel takes the file
    // route, which is what makes `verify` work on macOS at all.
    for (const lens of DEFAULT_LENSES) {
      const prompt = verifyLensPrompt({
        lens,
        targetTitle: 'short-one',
        targetId,
        agentId: 'claude',
        shimPath
      })
      expect(shouldSpillPrompt(prompt, true)).toBe(true)
    }
  })

  it('the JUDGE prompt fits and is left inline — the spill only fires where it is needed', () => {
    // Measured: the synthesis prompt assembles to 749 bytes for the three default lenses, well
    // inside the budget, so a `verify` panel writes one file per REVIEWER and none for the
    // verdict node. Pinned so a future rewording that pushes it over is a visible change rather
    // than a silent extra file — and so the "only when needed" property has a witness.
    const judge = verifySynthesisPrompt({
      lenses: DEFAULT_LENSES,
      targetTitle: 'short-one',
      agentId: 'claude',
      shimPath
    })
    expect(shouldSpillPrompt(judge, true)).toBe(false)
  })

  it('the spilled command FITS a canonical-mode line, which the inline one does not', () => {
    const prompt = verifyLensPrompt({
      lens: 'security',
      targetTitle: 'short-one',
      targetId,
      agentId: 'claude',
      shimPath
    })
    const shape = {
      agentId: 'claude',
      permissionMode: 'auto' as const,
      sessionId: '11111111-2222-3333-4444-555555555555',
      sessionIdFlagSupported: true
    }
    const inline = assembleLaunchCommand({ ...shape, initialPrompt: prompt }, {}).command
    expect(fitsLaunchLine(inline)).toBe(false)
    expect(lineBytes(inline)).toBeGreaterThan(MAX_LAUNCH_LINE_BYTES)

    const spilled = assembleLaunchCommand(
      { ...shape, promptFile: '/Users/x/Library/Application Support/node-terminal/uploads/k/p.txt' },
      {}
    ).command
    expect(fitsLaunchLine(spilled)).toBe(true)
  })
})

describe('flattenPrompt', () => {
  it('matches the assembler: every whitespace run becomes one space, ends trimmed', () => {
    expect(flattenPrompt('  a\n\n b\t\tc  ')).toBe('a b c')
  })
})
