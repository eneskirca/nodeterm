import { describe, expect, it } from "vitest";
import type { AgentId } from "@shared/agents/config";
import type { CustomAgent } from "@shared/types";
import { reopenVariants } from "./reopenVariants";

const customs: CustomAgent[] = [
  {
    id: "custom:claude-a",
    label: "Claude A",
    launchCmd: "claude-a",
    baseAgent: "claude",
  },
  {
    id: "custom:claude-b",
    label: "Claude B",
    launchCmd: "claude-b",
    baseAgent: "claude",
  },
  {
    id: "custom:codex",
    label: "Codex Proxy",
    launchCmd: "codex-proxy",
    baseAgent: "codex",
  },
  { id: "custom:plain", label: "Plain Custom", launchCmd: "plain" },
];

describe("reopenVariants", () => {
  it("lists enabled custom variants that share a builtin source base", () => {
    expect(reopenVariants("claude", customs, [])).toEqual([
      { id: "custom:claude-a", label: "Claude A", base: "claude" },
      { id: "custom:claude-b", label: "Claude B", base: "claude" },
    ]);
  });

  it("offers the base and sibling customs for a custom source", () => {
    expect(reopenVariants("custom:claude-a" as AgentId, customs, [])).toEqual([
      { id: "claude", label: "Claude Code", base: "claude" },
      { id: "custom:claude-b", label: "Claude B", base: "claude" },
    ]);
  });

  it("excludes disabled targets without hiding other same-base variants", () => {
    expect(
      reopenVariants("custom:claude-a" as AgentId, customs, [
        "claude",
        "custom:claude-b",
      ]),
    ).toEqual([]);
    expect(reopenVariants("claude", customs, ["custom:claude-a"])).toEqual([
      { id: "custom:claude-b", label: "Claude B", base: "claude" },
    ]);
  });

  it("returns no variants for baseless or unknown custom sources", () => {
    expect(reopenVariants("custom:plain" as AgentId, customs, [])).toEqual([]);
    expect(reopenVariants("custom:missing" as AgentId, customs, [])).toEqual(
      [],
    );
  });

  it("uses a node-persisted base after the source custom definition is deleted", () => {
    expect(
      reopenVariants("custom:missing" as AgentId, customs, [], "claude"),
    ).toEqual([
      { id: "claude", label: "Claude Code", base: "claude" },
      { id: "custom:claude-a", label: "Claude A", base: "claude" },
      { id: "custom:claude-b", label: "Claude B", base: "claude" },
    ]);
  });

  it("never crosses provider session-id namespaces", () => {
    expect(reopenVariants("codex", customs, []).map((v) => v.id)).toEqual([
      "custom:codex",
    ]);
    expect(
      reopenVariants("claude", customs, []).map((v) => v.id),
    ).not.toContain("custom:codex");
  });
});
