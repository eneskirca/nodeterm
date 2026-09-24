import { reportTextDelivery } from './textDelivery'
import type { TextDeliveryResult } from '@shared/text-delivery'
// Mirroring a node's title into its agent session as `/rename <name>`, safely.
//
// The io is injected so the gate below is unit-testable: it is the fix for a real data-loss bug,
// not a nicety. Lives outside Canvas.tsx for that reason alone.
import { isShellCommand } from '../terminal/agent-restart'
import { oneLine } from '@shared/one-line'

/** How long to wait for an agent CLI to take its pane before giving up on the mirror. */
export const RENAME_PUSH_ATTEMPTS = 12
export const RENAME_PUSH_RETRY_MS = 500

/**
 * The one place the `/rename` line is composed — SECURITY, not tidiness.
 *
 * `sendText` appends Enter, so this line is SUBMITTED. A `\n` or `\r` in `name` would end it
 * early and turn the rest into a second submitted line in the agent's composer: a command its
 * operator never typed. `name` is not ours — it arrives from the canvas-control `rename` verb's
 * `--title` (so from another AGENT), from `generateName`'s model output, and from the workspace
 * file. `oneLine` is what makes the line one line; the name still reads, minus a character that
 * had no glyph.
 *
 * Both push sites call this (here and TerminalNode's header rename). A second composition site is
 * how the two would drift, and this file already exists because of one such drift.
 */
export function renameCommand(name: string): string {
  return `/rename ${oneLine(name)}`
}

/**
 * Would `/rename <next>` be the line this session was already given?
 *
 * Compared AFTER `oneLine`, i.e. after exactly the normalization `renameCommand` applies, because
 * that is what decides whether the pane would receive a byte-identical line. Two titles that
 * differ only by a control character compose the same command, so a raw `!==` would answer "this
 * is a new name" and push a duplicate.
 *
 * The unchanged case is not cosmetic. Every `/rename` claude receives lands in the transcript as a
 * `local_command`, its `Session renamed to: …` stdout, AND a `<system-reminder>` that tells the
 * model *the user* just named this session — so a re-sent identical name spends the session's
 * context to assert an intent nobody expressed. Issue #582 measured 32 of them in six hours, all
 * carrying the same title; issue #569 §2 is the same push from the orchestrator's side.
 */
export function sessionNameUnchanged(next: string, current: string): boolean {
  return oneLine(next) === oneLine(current)
}

export interface RenamePushIo {
  paneCommand(persistKey: string): Promise<string | null>
  sendText(persistKey: string, text: string): Promise<TextDeliveryResult>
  /** Injected so tests don't wait in real time. */
  sleep?(ms: number): Promise<void>
}

/**
 * Push `/rename <name>` into a node's agent session — but ONLY once the agent CLI actually owns
 * the pane.
 *
 * `sendText` appends Enter, so writing while a SHELL owns the pane splices the line into whatever
 * that shell is currently reading. For a freshly opened agent node that is its own launch command
 * being typed, and the observed damage was exactly that: `claude '<long prompt>'` cut in half by
 * an interleaved `/rename …`, leaving the shell sitting at `quote>` with the agent never started
 * and the prompt lost. An agent that opens a node and renames it in the same breath — the entire
 * orchestration flow — hits that window every single time.
 *
 * So: probe the pane, and when we cannot DEMONSTRATE that a non-shell owns it, write nothing. A
 * probe that errors counts as "not demonstrated" — the asymmetry is deliberate, because an
 * unsynced session name is cosmetic while a destroyed launch is not.
 *
 * `current` is the name the node carries BEFORE this rename, and it is REQUIRED rather than
 * optional on purpose: a rename that changes nothing must reach the pane with nothing (see
 * `sessionNameUnchanged`), and an optional argument is one a call site forgets. Every caller
 * already holds the node it is renaming, so the type is what enforces the gate — neither
 * `Canvas.tsx` nor `TerminalNode.tsx` is unit-rendered in this repo, so the compiler is the only
 * reviewer that sees every site.
 *
 * Returns false both for "nothing to push" and for "the agent never took the pane"; the callers
 * are one-way mirrors and act on neither.
 */
export async function pushSessionRename(
  io: RenamePushIo,
  nodeId: string,
  name: string,
  current: string
): Promise<boolean> {
  if (sessionNameUnchanged(name, current)) return false
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let i = 0; i < RENAME_PUSH_ATTEMPTS; i++) {
    if (i > 0) await sleep(RENAME_PUSH_RETRY_MS)
    const pane = await io.paneCommand(nodeId).catch(() => null)
    if (pane && !isShellCommand(pane)) {
      return reportTextDelivery(await io.sendText(nodeId, renameCommand(name)))
    }
  }
  return false
}
