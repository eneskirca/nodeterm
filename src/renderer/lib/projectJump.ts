import { isBrowserRuntime } from "../bridge/runtime";
import { useProjects } from "../state/projects";
import { projectIdAtIndex } from "./sessionList";

/**
 * The Cmd/Ctrl+1-9 "jump to the Nth project" chord — ONE decision, shared by the three places
 * that must agree about it: the Canvas keydown handler (which performs the switch), and the two
 * xterm key handlers (canvas `TerminalNode` + kanban `ModalTerminal`) that have to swallow the
 * key BEFORE xterm writes a control byte to the pty. Keeping the matcher in one module is
 * deliberate: a copy of it in each place is a rule that drifts.
 *
 * Two facts make the answer narrower than "is this the chord":
 *
 * 1. **Desktop only.** Chrome, Firefox and Safari all own Ctrl+1-9 (Cmd+1-9 on macOS) for tab
 *    switching, and a page CANNOT `preventDefault()` them. So in the Server Edition the switch
 *    can never happen — and swallowing the key there would strip the terminal's control codes
 *    for exactly zero benefit. The whole feature is therefore gated on the shell.
 * 2. **Only when the digit addresses an open project.** Ctrl+2..Ctrl+8 are real, daily-use
 *    terminal control codes (`^@ ^[ ^\ ^] ^^ ^_` — vim's `^]` jump-to-tag and `^^` alternate-file
 *    live there). Pressing Ctrl+5 with three projects open must reach the pty untouched, because
 *    the app is not going to do anything with it. So the swallow mirrors the handler's decision
 *    rather than claiming the whole digit row.
 *
 * Matching is on `e.code` (the physical digit), not `e.key`: on a French AZERTY the unshifted
 * digit row prints letters, and the shortcut is positional. `@shared/shortcut` (parseShortcut /
 * matchesShortcut) was considered and does not fit — it matches ONE named key off `e.key`, while
 * this is a family of nine matched positionally; bending it to do both would make the settings
 * capture field's contract fuzzier for no gain here.
 */
export interface ProjectJumpEvent {
  type: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface ProjectJumpContext {
  /** True in a browser tab (Server Edition) — see rule 1 above. */
  browser: boolean;
  /** Project list in store order; `closed` ones are hidden from the tab bar and not addressable. */
  projects: readonly { id: string; closed?: boolean }[];
}

const DIGIT_CODE_RE = /^Digit[1-9]$/;

/**
 * The 1-9 digit this keydown addresses, or null when it is not the chord at all.
 *
 * Accepts EITHER modifier (`meta || ctrl`) on every platform, so a mac user's Ctrl+3 jumps too —
 * and, more importantly, so the swallow covers exactly the set the handler acts on. Alt is
 * excluded because AltGr reports as ctrl+alt and must keep typing a real character on non-US
 * layouts; Shift is excluded because a shifted digit is a punctuation key.
 */
export function projectJumpDigit(e: ProjectJumpEvent): number | null {
  if (e.type !== "keydown") return null;
  if (!e.metaKey && !e.ctrlKey) return null;
  if (e.altKey || e.shiftKey) return null;
  if (!DIGIT_CODE_RE.test(e.code)) return null;
  return Number(e.code.slice(5));
}

/**
 * PURE. The project id this chord resolves to, or null when the app does not own the key —
 * either because it is not the chord, or the shell is a browser tab, or the digit addresses no
 * open project. Null means "leave the key alone": no `preventDefault`, no swallow.
 */
export function projectJumpTarget(
  e: ProjectJumpEvent,
  ctx: ProjectJumpContext,
): string | null {
  if (ctx.browser) return null;
  const digit = projectJumpDigit(e);
  if (digit === null) return null;
  return projectIdAtIndex(
    ctx.projects.filter((p) => !p.closed),
    digit,
  );
}

/**
 * `projectJumpTarget` bound to the live shell + project store. The cheap key-shape test runs
 * first so an ordinary keystroke never reaches into the store.
 */
export function liveProjectJumpTarget(e: ProjectJumpEvent): string | null {
  if (projectJumpDigit(e) === null) return null;
  return projectJumpTarget(e, {
    browser: isBrowserRuntime(),
    projects: useProjects.getState().projects,
  });
}
