import { describe, it, expect, beforeAll } from "vitest";
import type { Project } from "@shared/types";
import { markBrowserRuntime } from "../bridge/runtime";
import { useProjects } from "../state/projects";
import { liveProjectJumpTarget, type ProjectJumpEvent } from "./projectJump";

// The BROWSER half of the live binding, in its own file because `markBrowserRuntime` is the boot
// switch the WS bridge flips once and never unflips; vitest isolates module state per test file.
//
// REGRESSION GUARD (review #1): Chrome, Firefox and Safari all reserve Ctrl+1-9 (Cmd+1-9 on macOS)
// for tab switching and a page cannot `preventDefault()` them. In the Server Edition the switch
// therefore cannot happen — and without this gate the terminals would still swallow Ctrl+2..Ctrl+8
// (^@ ^[ ^\ ^] ^^ ^_) out of the pty for no benefit at all. Delete the `isBrowserRuntime()` check
// in `liveProjectJumpTarget` and this file fails.

function project(id: string): Project {
  return {
    id,
    name: id,
    color: "#888",
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
  };
}

const chord: ProjectJumpEvent = {
  type: "keydown",
  code: "Digit1",
  metaKey: false,
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
};

describe("liveProjectJumpTarget (Server Edition / browser tab)", () => {
  beforeAll(() => {
    useProjects.setState({ projects: [project("p1"), project("p2")] });
    markBrowserRuntime();
  });

  it("never claims the chord, even when the digit addresses an open project", () => {
    expect(liveProjectJumpTarget(chord)).toBeNull();
    expect(liveProjectJumpTarget({ ...chord, code: "Digit2" })).toBeNull();
    expect(
      liveProjectJumpTarget({ ...chord, ctrlKey: false, metaKey: true }),
    ).toBeNull();
  });
});
