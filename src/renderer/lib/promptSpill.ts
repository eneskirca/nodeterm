// A LAUNCH PROMPT TOO BIG FOR A TYPED LINE GOES INTO A FILE INSTEAD (issue #706).
//
// `--prompt` becomes a quoted argument on a command line that is TYPED into the pane, and a
// canonical-mode tty silently discards everything past its buffer (1024 bytes on macOS — see
// @shared/canonical-line). The closing quote is what gets dropped, so the shell is left at
// `quote>` and the agent never launches. `verify` reaches that length with no user input at all:
// two of its three default lenses assemble to > 1024 bytes with a nine-character node title.
//
// The mechanism to avoid it already exists and is already the documented answer for a prompt with
// structure: `--prompt-file` (issue #520), which the assembler composes as `"$(cat '<path>')"` —
// the pane's own shell reads the file at execution, so the TYPED line stays short whatever the
// prompt weighs. All this module adds is doing it automatically for a prompt we generated.
//
// Three properties, in order of importance:
//
//  1. **It never makes things worse.** A spill that fails for any reason (no writer on this
//     surface, a full disk, a relay tab) returns `null` and the caller passes the prompt inline
//     exactly as before. The delivery layer's own refusal (`deliverCommand`'s `line-too-long`)
//     is what stops a truncated line from being submitted in that case, so failing open here
//     costs a visible refusal, never a half-run command.
//  2. **It only fires when needed.** Under the budget the caller's command line is byte-identical
//     to what it has always been — no file is written for `--prompt "hello"`.
//  3. **It writes on the machine the terminals run on.** `files.saveUpload` is that seam by
//     definition (it is what a clipboard paste and a browser-side drop already use), which makes
//     this correct on the desktop and in the Server Edition without a branch. An SSH project's
//     pane runs on the HOST, where this cannot reach — so those callers must not spill, and
//     `shouldSpillPrompt` takes that as an explicit argument rather than guessing.

import { MAX_LAUNCH_LINE_BYTES, lineBytes } from '@shared/canonical-line'

/**
 * How many bytes of PROMPT we will put on a typed line before spilling.
 *
 * The rest of the line is the program, its args, the permission-mode flag, a minted `--session-id`
 * and an optional `--model`. Measured against `assembleLaunchCommand` (2026-09) the worst builtin
 * is claude at **122 bytes** of overhead with every one of those present; grok is 90, copilot 74,
 * codex 41, gemini 35, opencode 20. The reserve is set well above the worst measured value because
 * two inputs are NOT bounded by anything here — a per-builtin launch-command override (a wrapper
 * script the user names in Settings) and a custom agent's `args` — and being a little eager to
 * spill costs one file, while being a little short costs a truncated launch.
 *
 * Deliberately a budget on the prompt rather than a check on the finished command: the command is
 * assembled inside `createAgentNode`, which also MINTS a session id, so it cannot be dry-run to
 * measure. The finished line is still checked at delivery, which is the backstop for the cases
 * this reserve does not cover.
 */
export const LAUNCH_LINE_OVERHEAD_RESERVE = 200
export const LAUNCH_PROMPT_BUDGET_BYTES = MAX_LAUNCH_LINE_BYTES - LAUNCH_LINE_OVERHEAD_RESERVE

/**
 * What actually reaches the pane for an inline `--prompt`: the assembler collapses every run of
 * whitespace to one space (`assembleLaunchCommand`), and the agent-facing docs promise exactly
 * that. **The spilled file must hold the SAME text**, or a prompt's meaning would change with its
 * length — under the budget it arrives flattened, over the budget it would arrive with its
 * newlines intact. `--prompt-file` remains the way to ask for structure, and it is untouched by
 * this module. Kept here rather than imported so the invariant is stated where the file is
 * written.
 */
export function flattenPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim()
}

/** Would this prompt, typed inline, risk a truncated launch line? Measured on what will actually
 *  be typed — the flattened form, which is never longer than the original. */
export function promptExceedsLineBudget(prompt: string | undefined): boolean {
  return !!prompt && lineBytes(flattenPrompt(prompt)) > LAUNCH_PROMPT_BUDGET_BYTES
}

/**
 * Should this prompt be spilled to a file?
 *
 * `localFs` is the caller's answer to "will the pane read the filesystem `saveUpload` writes to?".
 * It is FALSE for an SSH project, whose pane runs on the host — spilling there would compose a
 * `cat` of a path that exists only on this machine, turning a prompt that is merely at risk of
 * truncation into one that is guaranteed empty. Those callers pass the prompt inline and rely on
 * the delivery refusal instead, which also means a host with a larger canonical buffer (Linux is
 * 4096) keeps working exactly as it does today.
 */
export function shouldSpillPrompt(prompt: string | undefined, localFs: boolean): boolean {
  return localFs && promptExceedsLineBudget(prompt)
}

export interface PromptSpillIo {
  /** `window.nodeTerminal.files.saveUpload` — writes on the machine the terminals run on. */
  saveUpload(name: string, dataBase64: string): Promise<string | null>
  /** Injected so the module tests without a DOM. */
  encodeBase64(text: string): string
}

let spillSeq = 0

/** UTF-8 → base64, which is what `saveUpload` takes. `btoa` is Latin-1 only, so the text is
 *  encoded to bytes first — a prompt is full of `—` and `…` and would otherwise throw. */
export function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/**
 * Write `prompt` to a file on the machine the terminals run on and resolve its ABSOLUTE path, or
 * `null` if it could not be written — in which case the caller keeps its inline prompt.
 *
 * Never throws: `saveUpload` is a `window.nodeTerminal` member, and a surface that stubs it
 * (a relay tab) rejects rather than resolving null.
 */
export async function spillPromptToFile(
  prompt: string,
  io: PromptSpillIo
): Promise<string | null> {
  try {
    const name = `nodeterm-prompt-${Date.now().toString(36)}-${(spillSeq++).toString(36)}.txt`
    const path = await io.saveUpload(name, io.encodeBase64(flattenPrompt(prompt)))
    return path || null
  } catch {
    return null
  }
}
