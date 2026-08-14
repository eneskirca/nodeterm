import { describe, it, expect } from "vitest";
import {
  projectJumpDigit,
  projectJumpTarget,
  type ProjectJumpEvent,
} from "./projectJump";

function ev(over: Partial<ProjectJumpEvent> = {}): ProjectJumpEvent {
  return {
    type: "keydown",
    code: "Digit1",
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    ...over,
  };
}

const THREE = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
const desktop = (projects: { id: string; closed?: boolean }[] = THREE) => ({
  browser: false,
  projects,
});

describe("projectJumpDigit", () => {
  it("reads the 1-9 digit off the physical key code, under either primary modifier", () => {
    expect(projectJumpDigit(ev({ code: "Digit1" }))).toBe(1);
    expect(projectJumpDigit(ev({ code: "Digit9" }))).toBe(9);
    expect(
      projectJumpDigit(ev({ code: "Digit4", ctrlKey: false, metaKey: true })),
    ).toBe(4);
  });

  it("is not the chord without a primary modifier, or on Digit0", () => {
    expect(projectJumpDigit(ev({ ctrlKey: false }))).toBeNull();
    expect(projectJumpDigit(ev({ code: "Digit0" }))).toBeNull();
    expect(projectJumpDigit(ev({ code: "KeyA" }))).toBeNull();
  });

  it("leaves AltGr (ctrl+alt) and shifted digits alone", () => {
    // AltGr reports as ctrl+alt on Linux/Windows and types a real character on non-US layouts.
    expect(projectJumpDigit(ev({ altKey: true }))).toBeNull();
    expect(projectJumpDigit(ev({ shiftKey: true }))).toBeNull();
  });

  it("only fires on keydown", () => {
    expect(projectJumpDigit(ev({ type: "keyup" }))).toBeNull();
  });
});

describe("projectJumpTarget", () => {
  it("resolves the digit against the open projects, in store order", () => {
    expect(projectJumpTarget(ev({ code: "Digit1" }), desktop())).toBe("p1");
    expect(projectJumpTarget(ev({ code: "Digit3" }), desktop())).toBe("p3");
  });

  it("skips closed projects, matching what the tab bar shows", () => {
    const list = [{ id: "p1" }, { id: "p2", closed: true }, { id: "p3" }];
    expect(projectJumpTarget(ev({ code: "Digit2" }), desktop(list))).toBe("p3");
    expect(projectJumpTarget(ev({ code: "Digit3" }), desktop(list))).toBeNull();
  });

  // REGRESSION GUARD (review #2): the terminal's swallow asks this same function, so a digit that
  // addresses nothing must answer null — otherwise Ctrl+5 with three projects open would be eaten
  // and vim would silently lose ^^ / ^] and friends (Ctrl+2..Ctrl+8 are real control codes).
  it("is null for a digit past the end of the list — the key belongs to the pty", () => {
    expect(projectJumpTarget(ev({ code: "Digit5" }), desktop())).toBeNull();
    expect(projectJumpTarget(ev({ code: "Digit9" }), desktop())).toBeNull();
    expect(projectJumpTarget(ev({ code: "Digit1" }), desktop([]))).toBeNull();
    expect(
      projectJumpTarget(
        ev({ code: "Digit1" }),
        desktop([{ id: "p1", closed: true }]),
      ),
    ).toBeNull();
  });

  // REGRESSION GUARD (review #1): Chrome/Firefox/Safari own Ctrl+1-9 (Cmd+1-9 on macOS) for tab
  // switching and a page cannot preventDefault it, so the Server Edition can neither perform the
  // switch nor justify swallowing the key.
  it("is null in a browser tab, even for a digit that would resolve on the desktop", () => {
    expect(
      projectJumpTarget(ev({ code: "Digit1" }), {
        browser: true,
        projects: THREE,
      }),
    ).toBeNull();
    expect(
      projectJumpTarget(ev({ code: "Digit3" }), {
        browser: true,
        projects: THREE,
      }),
    ).toBeNull();
  });
});
