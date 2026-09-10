import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentLaunchIntent } from "../shared/types";
import {
  AgentLaunchPreparationError,
  prepareAgentLaunch,
  type AgentLaunchDialect,
  type AgentLaunchTrustedContext,
  type PreparedAgentLaunch,
  type TrustedCustomAgentLaunchConfig,
} from "./agent-launch";

const WINDOWS = process.platform === "win32";
const WINDOWS_POWERSHELL = WINDOWS
  ? path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    )
  : null;

function firstWhere(command: string): string | null {
  if (!WINDOWS) return null;
  const result = spawnSync("where.exe", [command], { encoding: "utf8" });
  const first =
    result.status === 0
      ? result.stdout.split(/\r?\n/u).find(Boolean)
      : undefined;
  return first?.trim() || null;
}

const PWSH = firstWhere("pwsh.exe");
const GIT_BASH = WINDOWS
  ? ([
      path.join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "Git",
        "bin",
        "bash.exe",
      ),
      path.join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Git",
        "bin",
        "bash.exe",
      ),
    ].find((candidate) => existsSync(candidate)) ?? null)
  : existsSync("/bin/bash")
    ? "/bin/bash"
    : null;

function installedWslDistros(): string[] {
  if (!WINDOWS) return [];
  const result = spawnSync("wsl.exe", ["--list", "--quiet"]);
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return [];
  const stdout = result.stdout.includes(0)
    ? result.stdout.toString("utf16le")
    : result.stdout.toString("utf8");
  return stdout
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\0/g, "").trim())
    .filter(Boolean);
}

const WSL_DISTROS = installedWslDistros();

const start = (
  agentId: string,
  extra: Partial<Extract<AgentLaunchIntent, { action: "start" }>> = {},
): AgentLaunchIntent => ({ kind: "agent", action: "start", agentId, ...extra });

const resume = (
  agentId: string,
  sessionId = "session-1",
  extra: Partial<Extract<AgentLaunchIntent, { action: "resume" }>> = {},
): AgentLaunchIntent => ({
  kind: "agent",
  action: "resume",
  agentId,
  sessionId,
  ...extra,
});

const builtinContext = (
  agentId: string,
  extra: Partial<AgentLaunchTrustedContext> = {},
): AgentLaunchTrustedContext => ({
  expectedAgentId: agentId,
  sharedIdentityAvailable: false,
  ...extra,
});

function customContext(
  customAgent: TrustedCustomAgentLaunchConfig,
  extra: Partial<AgentLaunchTrustedContext> = {},
): AgentLaunchTrustedContext {
  return {
    expectedAgentId: customAgent.id,
    customAgent,
    sharedIdentityAvailable: false,
    ...extra,
  };
}

async function expectFailure(
  intent: AgentLaunchIntent,
  dialect: AgentLaunchDialect,
  context: AgentLaunchTrustedContext,
  code: AgentLaunchPreparationError["code"],
): Promise<AgentLaunchPreparationError> {
  try {
    await prepareAgentLaunch(intent, dialect, context);
  } catch (error) {
    expect(error).toBeInstanceOf(AgentLaunchPreparationError);
    expect((error as AgentLaunchPreparationError).code).toBe(code);
    return error as AgentLaunchPreparationError;
  }
  throw new Error("Expected prepareAgentLaunch to reject");
}

describe("prepareAgentLaunch logical argv", () => {
  it("keeps the historical no-separator order and validates a minted Claude id", async () => {
    await expect(
      prepareAgentLaunch(
        start("claude", {
          prompt: "fix 'this'",
          permissionMode: "plan",
          newSessionId: "550e8400-e29b-41d4-a716-446655440000",
        }),
        "posix",
        builtinContext("claude"),
      ),
    ).resolves.toEqual({
      command:
        "'claude' 'fix '\\''this'\\''' '--permission-mode' 'plan' '--session-id' '550e8400-e29b-41d4-a716-446655440000'",
    });
  });

  it("puts Grok flags before its end-of-options separator", async () => {
    await expect(
      prepareAgentLaunch(
        start("grok", { prompt: "version", permissionMode: "plan" }),
        "posix",
        builtinContext("grok"),
      ),
    ).resolves.toEqual({
      command: "'grok' '--permission-mode' 'plan' '--' 'version'",
    });
  });

  it("uses flag-prompt for OpenCode and preserves a trailing slash", async () => {
    await expect(
      prepareAgentLaunch(
        start("opencode", { prompt: "repo/" }),
        "posix",
        builtinContext("opencode"),
      ),
    ).resolves.toEqual({ command: "'opencode' '--prompt' 'repo/'" });
  });

  it("preserves Gemini's historical positional prompt, including an empty prompt", async () => {
    await expect(
      prepareAgentLaunch(
        start("gemini", { prompt: "", permissionMode: "plan" }),
        "posix",
        builtinContext("gemini"),
      ),
    ).resolves.toEqual({
      command: "'gemini' '' '--approval-mode' 'plan'",
    });
  });

  it("builds AGY, Pi, and Goose interactive launches", async () => {
    await expect(
      prepareAgentLaunch(start("agy", { prompt: "fix it" }), "posix", builtinContext("agy")),
    ).resolves.toEqual({ command: "'agy' '--prompt-interactive' 'fix it'" });
    await expect(
      prepareAgentLaunch(start("pi", { prompt: "fix it" }), "posix", builtinContext("pi")),
    ).resolves.toEqual({ command: "'pi' 'fix it'" });
    await expect(
      prepareAgentLaunch(start("goose"), "posix", builtinContext("goose")),
    ).resolves.toEqual({ command: "'goose' 'session'" });
    await expect(
      prepareAgentLaunch(start("goose", { prompt: "fix it" }), "posix", builtinContext("goose")),
    ).resolves.toEqual({
      command: "'goose' 'run' '--interactive' '--text' 'fix it'",
    });
  });

  it("builds every builtin resume grammar and derives shared identity from trusted context", async () => {
    await expect(
      prepareAgentLaunch(
        resume("codex", "thread-1", { permissionMode: "auto" }),
        "posix",
        builtinContext("codex", { sharedIdentityAvailable: true }),
      ),
    ).resolves.toEqual({
      command:
        "'nodeterm-codex' 'resume' 'thread-1' '--ask-for-approval' 'on-request'",
    });
    await expect(
      prepareAgentLaunch(
        resume("opencode", "chat-1"),
        "posix",
        builtinContext("opencode"),
      ),
    ).resolves.toEqual({ command: "'opencode' '--session' 'chat-1'" });
    await expect(
      prepareAgentLaunch(
        resume("claude", "chat-2"),
        "posix",
        builtinContext("claude"),
      ),
    ).resolves.toEqual({ command: "'claude' '--resume' 'chat-2'" });
  });

  it("uses the exact machine-local custom config and honors structural prompt modes", async () => {
    const argv = {
      id: "custom:argv",
      launchCmd: 'npx -y "my agent"',
      promptInjectionMode: "argv",
    } as const;
    await expect(
      prepareAgentLaunch(
        start(argv.id, { prompt: "hello world" }),
        "posix",
        customContext(argv),
      ),
    ).resolves.toEqual({ command: "'npx' '-y' 'my agent' 'hello world'" });

    const flag = {
      id: "custom:flag",
      launchCmd: "agent",
      promptInjectionMode: "flag-prompt",
    } as const;
    await expect(
      prepareAgentLaunch(
        start(flag.id, { prompt: "" }),
        "posix",
        customContext(flag),
      ),
    ).resolves.toEqual({ command: "'agent' '--prompt' ''" });
  });

  it("preserves a Goose base harness through the trusted session-host path", async () => {
    const custom = {
      id: "custom:goose-wrap",
      launchCmd: "goose-wrap",
      promptInjectionMode: "argv",
      baseAgent: "goose",
    } as const;
    await expect(
      prepareAgentLaunch(start(custom.id), "posix", customContext(custom)),
    ).resolves.toEqual({ command: "'goose-wrap' 'session'" });
    await expect(
      prepareAgentLaunch(
        start(custom.id, { prompt: "fix it" }),
        "posix",
        customContext(custom),
      ),
    ).resolves.toEqual({
      command: "'goose-wrap' 'run' '--interactive' '--text' 'fix it'",
    });
  });

  it.each(["posix", "pwsh", "windows-powershell", "cmd"] as const)(
    "rejects custom stdin-after-start under %s without a trusted child-readiness handshake",
    async (dialect) => {
      const stdin = {
        id: "custom:stdin",
        launchCmd: "agent --interactive",
        promptInjectionMode: "stdin-after-start",
      } as const;
      await expectFailure(
        start(stdin.id, { prompt: "hello" }),
        dialect,
        customContext(stdin),
        "unsupported-shell",
      );
    },
  );
});

describe("prepareAgentLaunch runtime trust checks", () => {
  it.each([
    [
      "wrong kind",
      { kind: "shell-command", action: "start", agentId: "claude" },
    ],
    ["unknown action", { kind: "agent", action: "branch", agentId: "claude" }],
    [
      "start carrying resume id",
      {
        kind: "agent",
        action: "start",
        agentId: "claude",
        sessionId: "session-1",
      },
    ],
    [
      "resume carrying a prompt",
      {
        kind: "agent",
        action: "resume",
        agentId: "claude",
        sessionId: "session-1",
        prompt: "x",
      },
    ],
    [
      "resume carrying a new id",
      {
        kind: "agent",
        action: "resume",
        agentId: "claude",
        sessionId: "session-1",
        newSessionId: "550e8400-e29b-41d4-a716-446655440000",
      },
    ],
    [
      "forged permission mode",
      {
        kind: "agent",
        action: "start",
        agentId: "claude",
        permissionMode: "plan & calc",
      },
    ],
    [
      "control-bearing prompt",
      { kind: "agent", action: "start", agentId: "claude", prompt: "a\nb" },
    ],
    [
      "Unicode line separator prompt",
      { kind: "agent", action: "start", agentId: "claude", prompt: "a\u2028b" },
    ],
    [
      "Unicode paragraph separator prompt",
      { kind: "agent", action: "start", agentId: "claude", prompt: "a\u2029b" },
    ],
    [
      "unsafe resume id",
      { kind: "agent", action: "resume", agentId: "claude", sessionId: "../x" },
    ],
    [
      "empty resume id",
      { kind: "agent", action: "resume", agentId: "claude", sessionId: "" },
    ],
    [
      "non-v4 minted id",
      {
        kind: "agent",
        action: "start",
        agentId: "claude",
        newSessionId: "550e8400-e29b-11d4-a716-446655440000",
      },
    ],
  ])(
    "rejects %s rather than trusting the TypeScript type",
    async (_name, forged) => {
      await expectFailure(
        forged as unknown as AgentLaunchIntent,
        "posix",
        builtinContext("claude"),
        "invalid-intent",
      );
    },
  );

  it("requires the intent to match the trusted node owner", async () => {
    await expectFailure(
      start("codex"),
      "posix",
      builtinContext("claude"),
      "agent-unavailable",
    );
  });

  it.each(["constructor", "custom:missing", "calc & echo forged"])(
    "does not preserve the renderer unknown-id executable fallback for %s",
    async (agentId) => {
      await expectFailure(
        start(agentId),
        "posix",
        builtinContext(agentId),
        "agent-unavailable",
      );
    },
  );

  it("requires an exact current custom record and rejects custom resume", async () => {
    const custom = {
      id: "custom:one",
      launchCmd: "agent",
      promptInjectionMode: "argv",
    } as const;
    await expectFailure(
      start("custom:one"),
      "posix",
      customContext({ ...custom, id: "custom:other" }),
      "agent-unavailable",
    );
    await expectFailure(
      resume(custom.id),
      "posix",
      customContext(custom),
      "agent-unavailable",
    );
  });

  it.each(["agent && calc", "agent | calc", 'agent "unterminated', "-agent"])(
    "fails closed for an unstructured custom launch command: %s",
    async (launchCmd) => {
      const custom = {
        id: "custom:unsafe",
        launchCmd,
        promptInjectionMode: "argv",
      } as const;
      await expectFailure(
        start(custom.id, { prompt: "safe prompt" }),
        "posix",
        customContext(custom),
        "agent-unavailable",
      );
    },
  );

  it("rejects a minted id for an agent that cannot mint one", async () => {
    await expectFailure(
      start("codex", {
        newSessionId: "550e8400-e29b-41d4-a716-446655440000",
      } as never),
      "posix",
      builtinContext("codex"),
      "invalid-intent",
    );
  });

  it("rejects a permission mode for agents that do not implement one", async () => {
    await expectFailure(
      start("opencode", { permissionMode: "plan" }),
      "posix",
      builtinContext("opencode"),
      "invalid-intent",
    );
    const custom = {
      id: "custom:mode",
      launchCmd: "agent",
      promptInjectionMode: "argv",
    } as const;
    await expectFailure(
      start(custom.id, { permissionMode: "manual" }),
      "posix",
      customContext(custom),
      "invalid-intent",
    );
  });

  it("rejects Unicode command separators in trusted custom config and resolver output", async () => {
    const custom = {
      id: "custom:separator",
      launchCmd: "agent\u2028calc",
      promptInjectionMode: "argv",
    } as const;
    await expectFailure(
      start(custom.id),
      "posix",
      customContext(custom),
      "agent-unavailable",
    );

    await expectFailure(
      start("claude"),
      "pwsh",
      builtinContext("claude", {
        resolveExecutableKind: async () => ({
          kind: "native",
          executable: "C:\\Trusted\\claude\u2029calc.exe",
        }),
      }),
      "agent-unavailable",
    );
  });

  it("never repeats program, argv, prompt, or resolver diagnostics in an error", async () => {
    const secret = "SENSITIVE & PROMPT %PATH% 開発";
    const custom = {
      id: "custom:secret",
      launchCmd: `secret-program && ${secret}`,
      promptInjectionMode: "argv",
    } as const;
    const parseError = await expectFailure(
      start(custom.id, { prompt: secret }),
      "posix",
      customContext(custom),
      "agent-unavailable",
    );
    expect(parseError.message).not.toContain("secret");
    expect(parseError.message).not.toContain(secret);

    const resolverError = await expectFailure(
      start("claude", { prompt: secret }),
      "pwsh",
      builtinContext("claude", {
        resolveExecutableKind: async () => {
          throw new Error(`failed secret-program ${secret}`);
        },
      }),
      "agent-unavailable",
    );
    expect(resolverError.message).not.toContain("secret");
    expect(resolverError.message).not.toContain(secret);
  });

  it("rejects a POSIX argument that exceeds the portable Git Bash/WSL byte boundary", async () => {
    await expectFailure(
      start("claude", { prompt: "開".repeat(11_000) }),
      "posix",
      builtinContext("claude"),
      "invalid-intent",
    );
  });
});

describe("PowerShell executable classification", () => {
  it("uses a trusted resolver for a bare executable and the resolved path", async () => {
    const resolveExecutableKind = vi.fn(async () => ({
      kind: "native" as const,
      executable: "C:\\Trusted Tools\\agent.exe",
    }));
    const plan = await prepareAgentLaunch(
      start("claude", { prompt: "hello" }),
      "pwsh",
      builtinContext("claude", { resolveExecutableKind }),
    );
    expect(resolveExecutableKind).toHaveBeenCalledWith("claude", "pwsh");
    expect(plan.command).toBe(
      "$ntAgent = Start-Process -FilePath 'C:\\Trusted Tools\\agent.exe' -ArgumentList 'hello' -NoNewWindow -Wait -PassThru ; $global:LASTEXITCODE = $ntAgent.ExitCode",
    );
  });

  it.each(["pwsh", "windows-powershell", "cmd"] as const)(
    "refuses a cmd/bat shim under %s instead of applying native quoting",
    async (dialect) => {
      await expectFailure(
        start("claude", { prompt: "%PATH% & calc" }),
        dialect,
        builtinContext("claude", {
          resolveExecutableKind: async () => ({
            kind: "cmd-script",
            executable: "C:\\Tools\\claude.cmd",
          }),
          windowsPowerShellPath: WINDOWS_POWERSHELL ?? undefined,
        }),
        "unsupported-shell",
      );
    },
  );

  it("requires the trusted resolver to verify explicit paths as well as bare commands", async () => {
    const custom = {
      id: "custom:ps1",
      launchCmd: "C:\\Tools\\agent.ps1",
      promptInjectionMode: "argv",
    } as const;
    await expect(
      prepareAgentLaunch(
        start(custom.id, { prompt: "x" }),
        "pwsh",
        customContext(custom, {
          resolveExecutableKind: async () => ({
            kind: "powershell-script",
            executable: "C:\\Tools\\agent.ps1",
          }),
        }),
      ),
    ).resolves.toEqual({ command: "& 'C:\\Tools\\agent.ps1' 'x'" });

    await expectFailure(
      start(custom.id),
      "pwsh",
      customContext(custom),
      "unsupported-shell",
    );
    await expectFailure(
      start("claude"),
      "pwsh",
      builtinContext("claude"),
      "unsupported-shell",
    );
  });

  it.each([
    { kind: "native" as const, executable: "C:\\Tools\\agent.cmd" },
    { kind: "powershell-script" as const, executable: "C:\\Tools\\agent.exe" },
    { kind: "native" as const, executable: "relative\\agent.exe" },
  ])(
    "rejects a mismatched or non-absolute resolver result: $kind/$executable",
    async (resolution) => {
      await expectFailure(
        start("claude"),
        "pwsh",
        builtinContext("claude", {
          resolveExecutableKind: async () => resolution,
        }),
        "agent-unavailable",
      );
    },
  );
});

describe("cmd wrapper", () => {
  it("requires a trusted absolute PowerShell executable and never falls back to cmd interpolation", async () => {
    const resolver = async (): Promise<{
      kind: "native";
      executable: string;
    }> => ({
      kind: "native",
      executable: "C:\\Tools\\agent.exe",
    });
    for (const windowsPowerShellPath of [
      undefined,
      "powershell.exe",
      "C:\\Tools\\power%PATH%shell.exe",
      "C:\\Tools\\power&shell.exe",
      "C:\\Tools\\powershell.cmd",
    ]) {
      await expectFailure(
        start("claude", { prompt: "hello" }),
        "cmd",
        builtinContext("claude", {
          resolveExecutableKind: resolver,
          windowsPowerShellPath,
        }),
        "unsupported-shell",
      );
    }
  });

  it("encodes every logical token as UTF-16LE Base64 and leaves an ASCII-only outer line", async () => {
    if (!WINDOWS_POWERSHELL) return;
    const secret = "space a'b &|<>^%! '$`\" Unicode 開発 /";
    const plan = await prepareAgentLaunch(
      start("claude", { prompt: secret }),
      "cmd",
      builtinContext("claude", {
        resolveExecutableKind: async () => ({
          kind: "native",
          executable: "C:\\Trusted Tools\\claude.exe",
        }),
        windowsPowerShellPath: WINDOWS_POWERSHELL,
      }),
    );
    expect(plan.command).toMatch(
      / -NoLogo -NoProfile -EncodedCommand [A-Za-z0-9+/]+=*$/u,
    );
    expect(plan.command).not.toContain(secret);
    expect([...plan.command].every((ch) => ch.charCodeAt(0) <= 0x7f)).toBe(
      true,
    );

    const payload = plan.command.match(
      /-EncodedCommand ([A-Za-z0-9+/]+=*)$/u,
    )?.[1];
    expect(payload).toBeTruthy();
    const decoded = Buffer.from(payload as string, "base64").toString(
      "utf16le",
    );
    expect(decoded).toContain(
      "$ntAgent = Start-Process -FilePath 'C:\\Trusted Tools\\claude.exe' -ArgumentList",
    );
    expect(decoded).toContain("\"space a''b &|<>^%! ''$`\\\" Unicode 開発 /\"");
    expect(decoded).toContain("$global:LASTEXITCODE = $ntAgent.ExitCode");
  });

  it("rejects data that cannot fit the target Windows command-line boundary", async () => {
    if (!WINDOWS_POWERSHELL) return;
    const resolver = async (): Promise<{
      kind: "native";
      executable: string;
    }> => ({
      kind: "native",
      executable: "C:\\Tools\\agent.exe",
    });
    await expectFailure(
      start("claude", { prompt: "x".repeat(4_000) }),
      "cmd",
      builtinContext("claude", {
        resolveExecutableKind: resolver,
        windowsPowerShellPath: WINDOWS_POWERSHELL,
      }),
      "invalid-intent",
    );
    await expectFailure(
      start("claude", { prompt: "x".repeat(40_000) }),
      "pwsh",
      builtinContext("claude", { resolveExecutableKind: resolver }),
      "invalid-intent",
    );
  });
});

const PROMPTS = [
  "space apostrophe ' &|<>^%!'$` double \" Unicode 開発 🧪",
  "",
  "path/",
  "trailing\\",
  "--version",
  "--",
  "resume",
  "help",
  "--dangerously-skip-permissions",
] as const;

const ARG_PRINTER =
  "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

function neutralQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function customNodeConfig(executable: string): TrustedCustomAgentLaunchConfig {
  return {
    id: "custom:argv-printer",
    launchCmd: `${neutralQuote(executable)} -e ${neutralQuote(ARG_PRINTER)} --`,
    promptInjectionMode: "argv",
  };
}

function executeWindowsPlan(
  shell: string,
  dialect: AgentLaunchDialect,
  plan: PreparedAgentLaunch,
): string[] {
  const result =
    dialect === "cmd"
      ? spawnSync(shell, ["/d", "/v:off", "/c", plan.command], {
          encoding: "utf8",
          windowsVerbatimArguments: true,
        })
      : spawnSync(shell, ["-NoLogo", "-NoProfile", "-Command", plan.command], {
          encoding: "utf8",
        });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout) as string[];
}

describe.runIf(WINDOWS)("real Windows shell argv behavior", () => {
  const windowsCases: Array<[AgentLaunchDialect, string | null]> = [
    ["pwsh", PWSH],
    ["windows-powershell", WINDOWS_POWERSHELL],
    ["cmd", process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"],
  ];

  it.each(windowsCases)(
    "%s delivers the metacharacter and Unicode matrix exactly",
    async (dialect, shell) => {
      if (!shell || !existsSync(shell)) return;
      const custom = customNodeConfig(process.execPath);
      for (const prompt of PROMPTS) {
        const plan = await prepareAgentLaunch(
          start(custom.id, { prompt }),
          dialect,
          customContext(custom, {
            resolveExecutableKind: async () => ({
              kind: "native",
              executable: process.execPath,
            }),
            windowsPowerShellPath: WINDOWS_POWERSHELL ?? undefined,
          }),
        );
        expect(executeWindowsPlan(shell, dialect, plan)).toEqual([prompt]);
      }
    },
    60_000,
  );

  it.each(windowsCases)(
    "%s delivers exact argv through a verified PowerShell-script entry point",
    async (dialect, shell) => {
      if (!shell || !existsSync(shell)) return;
      const directory = mkdtempSync(
        path.join(tmpdir(), "nodeterm-agent-launch-"),
      );
      const script = path.join(directory, "argv printer.ps1");
      writeFileSync(
        script,
        [
          "param([Parameter(ValueFromRemainingArguments=$true)][string[]] $Rest)",
          "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
          "[Console]::Write((ConvertTo-Json -Compress -InputObject @($Rest)))",
        ].join("\r\n"),
        "utf8",
      );
      try {
        const custom = {
          id: "custom:ps1-argv-printer",
          launchCmd: neutralQuote(script),
          promptInjectionMode: "argv",
        } as const;
        const combined = PROMPTS.filter(Boolean).join(" :: ");
        for (const prompt of [combined, ""]) {
          const plan = await prepareAgentLaunch(
            start(custom.id, { prompt }),
            dialect,
            customContext(custom, {
              resolveExecutableKind: async () => ({
                kind: "powershell-script",
                executable: script,
              }),
              windowsPowerShellPath: WINDOWS_POWERSHELL ?? undefined,
            }),
          );
          expect(executeWindowsPlan(shell, dialect, plan)).toEqual([prompt]);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
    30_000,
  );

  it.runIf(!!GIT_BASH)(
    "Git Bash executes the POSIX encoder with exact argv",
    async () => {
      const bashNode = process.execPath
        .replace(
          /^([A-Za-z]):[\\/]/u,
          (_all, drive: string) => `/${drive.toLowerCase()}/`,
        )
        .replace(/\\/g, "/");
      const custom = customNodeConfig(bashNode);
      for (const prompt of PROMPTS) {
        const plan = await prepareAgentLaunch(
          start(custom.id, { prompt }),
          "posix",
          customContext(custom),
        );
        const result = spawnSync(
          GIT_BASH as string,
          ["--noprofile", "--norc", "-c", plan.command],
          {
            encoding: "utf8",
          },
        );
        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([prompt]);
      }
    },
  );
});

describe.runIf(WINDOWS && WSL_DISTROS.length > 0)(
  "real WSL POSIX argv behavior",
  () => {
    it.each(WSL_DISTROS)(
      "%s delivers the metacharacter and Unicode matrix exactly",
      async (distro) => {
        const custom = {
          id: "custom:wsl-argv-printer",
          launchCmd: `/bin/sh -c ${neutralQuote('printf "%s" "$1"')} --`,
          promptInjectionMode: "argv",
        } as const;
        for (const prompt of PROMPTS) {
          const plan = await prepareAgentLaunch(
            start(custom.id, { prompt }),
            "posix",
            customContext(custom),
          );
          const result = spawnSync(
            "wsl.exe",
            ["-d", distro, "--", "/bin/sh"],
            // Feed the rendered line exactly as a terminal does. Passing it as `sh -c` argv through
            // wsl.exe would add Windows command-line parsing before the shell and test that transport
            // instead of the POSIX encoder.
            { encoding: "utf8", input: `${plan.command}\n` },
          );
          expect(result.status, result.stderr || result.stdout).toBe(0);
          expect(result.stdout).toBe(prompt);
        }
      },
      30_000,
    );
  },
);

describe.runIf(!WINDOWS)("real POSIX shell argv behavior", () => {
  it.runIf(!!GIT_BASH)(
    "delivers the metacharacter and Unicode matrix exactly",
    async () => {
      const custom = customNodeConfig(process.execPath);
      for (const prompt of PROMPTS) {
        const plan = await prepareAgentLaunch(
          start(custom.id, { prompt }),
          "posix",
          customContext(custom),
        );
        const result = spawnSync(
          GIT_BASH as string,
          ["--noprofile", "--norc", "-c", plan.command],
          {
            encoding: "utf8",
          },
        );
        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([prompt]);
      }
    },
  );
});
