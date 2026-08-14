import { describe, it, expect, beforeEach } from "vitest";
import type { Project } from "@shared/types";
import { useProjects } from "../state/projects";
import { liveProjectJumpTarget, type ProjectJumpEvent } from "./projectJump";

// The DESKTOP half of the live binding (the browser half needs its own file — markBrowserRuntime
// is a one-way boot switch, and vitest isolates module state per file). Under Electron the flag is
// never set, which is exactly the state this file runs in.

function project(id: string, closed?: boolean): Project {
  return {
    id,
    name: id,
    color: "#888",
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    ...(closed ? { closed: true } : {}),
  };
}

function ev(code: string): ProjectJumpEvent {
  return {
    type: "keydown",
    code,
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
  };
}

describe("liveProjectJumpTarget (desktop shell)", () => {
  beforeEach(() => {
    useProjects.setState({
      projects: [project("p1"), project("p2"), project("p3")],
    });
  });

  it("resolves a digit that addresses an open project", () => {
    expect(liveProjectJumpTarget(ev("Digit2"))).toBe("p2");
  });

  it("answers null for a digit past the end — the terminals must not swallow that key", () => {
    expect(liveProjectJumpTarget(ev("Digit4"))).toBeNull();
  });

  it("reads the project list live, so closing a project narrows the addressable range", () => {
    useProjects.setState({
      projects: [project("p1"), project("p2", true), project("p3")],
    });
    expect(liveProjectJumpTarget(ev("Digit2"))).toBe("p3");
    expect(liveProjectJumpTarget(ev("Digit3"))).toBeNull();
  });

  it("is null for a non-chord keydown", () => {
    expect(
      liveProjectJumpTarget({ ...ev("Digit1"), ctrlKey: false }),
    ).toBeNull();
  });
});
