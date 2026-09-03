import path from "node:path";
import type { AgentLaunchIntent, CustomAgent } from "../shared/types";
import {
  AGENT_CONFIG,
  agentLaunchProgram,
  canResume,
  hasPermissionMode,
  isPermissionMode,
  mintsSessionId,
  type AgentConfig,
  type AgentId,
  type BuiltinAgentId,
  type PromptInjectionMode,
} from "../shared/agents/config";
import { approvalFlags } from "../shared/agents/approval-mode";

/** The parser that owns a live local Windows-profile terminal. */
export type AgentLaunchDialect =
  "posix" | "pwsh" | "windows-powershell" | "cmd";

/**
 * How PowerShell must invoke the resolved agent entry point. A `.cmd`/`.bat` shim is deliberately
 * distinct: forwarding arbitrary Unicode/metacharacter-bearing argv through another cmd parser is
 * not lossless, so the planner refuses it instead of pretending native quoting applies.
 */
export type AgentLaunchExecutableKind =
  "native" | "powershell-script" | "cmd-script";

export interface AgentLaunchExecutableResolution {
  kind: AgentLaunchExecutableKind;
  /** Trusted currently-existing absolute path returned by the core resolver. */
  executable: string;
}

export type AgentLaunchExecutableKindResolver = (
  executable: string,
  dialect: Exclude<AgentLaunchDialect, "posix">,
) => Promise<AgentLaunchExecutableResolution | null>;

/** The one current custom-agent record selected from machine-local settings. */
export type TrustedCustomAgentLaunchConfig = Pick<
  CustomAgent,
  "id" | "launchCmd" | "promptInjectionMode" | "baseAgent"
>;

/**
 * Host-authoritative facts. None may be populated from a project file, canvas mutation, or relay
 * peer. In particular, the intent carries no executable and cannot select a different node owner.
 */
export interface AgentLaunchTrustedContext {
  expectedAgentId: AgentId;
  customAgent?: TrustedCustomAgentLaunchConfig;
  sharedIdentityAvailable: boolean;
  resolveExecutableKind?: AgentLaunchExecutableKindResolver;
  /** Trusted absolute Windows PowerShell executable used only as cmd's ASCII-safe wrapper. */
  windowsPowerShellPath?: string;
}

/** Core-private launch material. It must never cross the renderer/preload/relay boundary. */
export interface PreparedAgentLaunch {
  command: string;
  /** Literal follow-up data for an agent whose configured prompt mode is stdin-after-start. */
  stdinAfterStart?: string;
}

export type AgentLaunchPreparationErrorCode =
  "invalid-intent" | "agent-unavailable" | "unsupported-shell";

const SAFE_ERROR_MESSAGES: Record<AgentLaunchPreparationErrorCode, string> = {
  "invalid-intent": "The agent launch request is invalid.",
  "agent-unavailable": "The configured agent is unavailable on this machine.",
  "unsupported-shell":
    "This terminal shell cannot safely launch the configured agent.",
};

/** An error whose code and copy are safe to surface; it never embeds launch material. */
export class AgentLaunchPreparationError extends Error {
  readonly code: AgentLaunchPreparationErrorCode;

  constructor(code: AgentLaunchPreparationErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "AgentLaunchPreparationError";
    this.code = code;
  }
}

interface LogicalAgentLaunch {
  executable: string;
  args: string[];
  stdinAfterStart?: string;
}

interface ResolvedAgentConfig {
  id: AgentId;
  launchCmd: string;
  launchArgs?: readonly string[];
  promptLaunchArgs?: readonly string[];
  promptInjectionMode: PromptInjectionMode;
  promptFlag?: string;
  argvPromptSeparator?: string;
  builtin: boolean;
}

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SAFE_NEW_SESSION_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// PowerShell and POSIX parsers also treat Unicode line/paragraph separators as command boundaries
// in contexts where JavaScript's Cc category does not catch them.
const FORBIDDEN_INLINE_CHARACTER = /[\p{Cc}\u2028\u2029]/u;
const MAX_PROMPT_LENGTH = 128 * 1024;
const MAX_LAUNCH_COMMAND_LENGTH = 32 * 1024;
// `posix` is shared by WSL and Git Bash. The latter ultimately launches a Windows process, so use
// the smaller portable byte budget instead of Linux's larger MAX_ARG_STRLEN and fail closed when
// the environment-specific transport cannot be distinguished here.
const MAX_PORTABLE_POSIX_ARGUMENT_BYTES = 30_000;
const MAX_PORTABLE_POSIX_COMMAND_BYTES = 32_000;
// CreateProcessW caps one native command line at 32,767 UTF-16 code units; cmd.exe caps one
// interactive line at 8,191. Leave a small fixed margin for implementation-added framing/NUL.
const MAX_WINDOWS_COMMAND_LINE = 32_700;
const MAX_CMD_INTERACTIVE_LINE = 8_100;
const START_FIELDS = new Set([
  "kind",
  "action",
  "agentId",
  "prompt",
  "permissionMode",
  "newSessionId",
]);
const RESUME_FIELDS = new Set([
  "kind",
  "action",
  "agentId",
  "sessionId",
  "permissionMode",
]);

function fail(code: AgentLaunchPreparationErrorCode): never {
  throw new AgentLaunchPreparationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyOwnFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    !FORBIDDEN_INLINE_CHARACTER.test(value)
  );
}

function validateIntentRuntime(
  intent: AgentLaunchIntent,
  expectedAgentId: AgentId,
): void {
  if (!isRecord(intent)) fail("invalid-intent");
  if (intent.kind !== "agent") fail("invalid-intent");
  if (
    typeof intent.agentId !== "string" ||
    !intent.agentId ||
    intent.agentId !== expectedAgentId
  )
    fail("agent-unavailable");
  if (FORBIDDEN_INLINE_CHARACTER.test(intent.agentId))
    fail("agent-unavailable");
  if (
    intent.permissionMode !== undefined &&
    !isPermissionMode(intent.permissionMode)
  )
    fail("invalid-intent");

  if (intent.action === "start") {
    if (!hasOnlyOwnFields(intent, START_FIELDS)) fail("invalid-intent");
    if (
      intent.prompt !== undefined &&
      !safeText(intent.prompt, MAX_PROMPT_LENGTH)
    )
      fail("invalid-intent");
    if (
      intent.newSessionId !== undefined &&
      (typeof intent.newSessionId !== "string" ||
        !SAFE_NEW_SESSION_UUID_V4.test(intent.newSessionId))
    )
      fail("invalid-intent");
    return;
  }

  if (intent.action === "resume") {
    if (!hasOnlyOwnFields(intent, RESUME_FIELDS)) fail("invalid-intent");
    if (
      typeof intent.sessionId !== "string" ||
      !SAFE_SESSION_ID.test(intent.sessionId)
    )
      fail("invalid-intent");
    return;
  }

  fail("invalid-intent");
}

function isBuiltinAgentId(id: AgentId): id is BuiltinAgentId {
  return Object.hasOwn(AGENT_CONFIG, id);
}

function validPromptMode(value: unknown): value is PromptInjectionMode {
  return (
    value === "argv" ||
    value === "flag-prompt" ||
    value === "flag-interactive" ||
    value === "stdin-after-start"
  );
}

function resolveTrustedAgentConfig(
  intent: AgentLaunchIntent,
  context: AgentLaunchTrustedContext,
): ResolvedAgentConfig {
  if (isBuiltinAgentId(intent.agentId)) {
    const config: AgentConfig = AGENT_CONFIG[intent.agentId];
    return {
      id: intent.agentId,
      launchCmd: config.launchCmd,
      launchArgs: config.launchArgs,
      promptLaunchArgs: config.promptLaunchArgs,
      promptInjectionMode: config.promptInjectionMode,
      promptFlag: config.promptFlag,
      argvPromptSeparator: config.argvPromptSeparator,
      builtin: true,
    };
  }

  const custom = context.customAgent;
  const base = custom?.baseAgent ? AGENT_CONFIG[custom.baseAgent] : undefined;
  const promptInjectionMode = base?.promptInjectionMode ?? custom?.promptInjectionMode;
  if (
    !custom ||
    typeof custom.id !== "string" ||
    custom.id !== intent.agentId ||
    custom.id !== context.expectedAgentId ||
    !safeText(custom.launchCmd, MAX_LAUNCH_COMMAND_LENGTH) ||
    !custom.launchCmd.trim() ||
    !validPromptMode(promptInjectionMode)
  )
    fail("agent-unavailable");

  return {
    id: intent.agentId,
    launchCmd: custom.launchCmd,
    launchArgs: base?.launchArgs,
    promptLaunchArgs: base?.promptLaunchArgs,
    promptInjectionMode,
    promptFlag: base?.promptFlag,
    argvPromptSeparator: base?.argvPromptSeparator,
    builtin: false,
  };
}

/**
 * A deliberately small shell-neutral argv grammar for the machine-local custom launch field.
 * Quotes group literal text; backslash escapes whitespace/quotes/backslash. Unquoted shell
 * operators are refused because silently turning a shell fragment into argv changes its meaning.
 */
function parseTrustedLaunchCommand(source: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;

  const push = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (ch === "\\") {
        const next = source[i + 1];
        if (next === quote || next === "\\") {
          token += next;
          tokenStarted = true;
          i++;
          continue;
        }
      }
      token += ch;
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(ch)) {
      push();
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (ch === "\\") {
      const next = source[i + 1];
      if (
        next &&
        (/\s/u.test(next) || next === "'" || next === '"' || next === "\\")
      ) {
        token += next;
        tokenStarted = true;
        i++;
        continue;
      }
      token += ch;
      tokenStarted = true;
      continue;
    }
    if (";&|<>()$`\r\n".includes(ch)) fail("agent-unavailable");
    token += ch;
    tokenStarted = true;
  }

  if (quote) fail("agent-unavailable");
  push();
  if (!tokens.length || !tokens[0] || tokens[0].startsWith("-"))
    fail("agent-unavailable");
  return tokens;
}

function logicalLaunch(
  intent: AgentLaunchIntent,
  config: ResolvedAgentConfig,
  context: AgentLaunchTrustedContext,
): LogicalAgentLaunch {
  const parsed = parseTrustedLaunchCommand(config.launchCmd);
  let executable = parsed[0];
  const harnessArgs =
    intent.action === "start" && Object.hasOwn(intent, "prompt")
      ? config.promptLaunchArgs ?? config.launchArgs ?? []
      : config.launchArgs ?? [];
  const baseArgs = [...parsed.slice(1), ...harnessArgs];
  if (config.builtin)
    executable = agentLaunchProgram(
      config.id,
      executable,
      context.sharedIdentityAvailable,
    );

  if (intent.permissionMode !== undefined && !hasPermissionMode(config.id))
    fail("invalid-intent");
  const modeFlags = intent.permissionMode
    ? approvalFlags(config.id, intent.permissionMode)
    : [];

  if (intent.action === "resume") {
    if (!config.builtin || !canResume(config.id)) fail("agent-unavailable");
    const resumeArgs =
      config.id === "codex"
        ? ["resume", intent.sessionId]
        : config.id === "opencode"
          ? ["--session", intent.sessionId]
          : ["--resume", intent.sessionId];
    return { executable, args: [...baseArgs, ...resumeArgs, ...modeFlags] };
  }

  const sessionArgs: string[] = [];
  if (intent.newSessionId !== undefined) {
    if (!mintsSessionId(config.id)) fail("invalid-intent");
    sessionArgs.push("--session-id", intent.newSessionId);
  }

  const hasPrompt = Object.hasOwn(intent, "prompt");
  const prompt = hasPrompt ? (intent.prompt ?? "") : undefined;
  // Gemini's existing creation contract is a positional prompt even though its capability
  // metadata describes a possible stdin transport. Changing that would require a measured child
  // readiness handshake; the generic terminal prompt is not evidence that Gemini is ready.
  const promptInjectionMode =
    config.builtin && config.id === "gemini"
      ? "argv"
      : config.promptInjectionMode;
  if (promptInjectionMode === "stdin-after-start") {
    return {
      executable,
      args: [...baseArgs, ...modeFlags, ...sessionArgs],
      ...(hasPrompt ? { stdinAfterStart: prompt } : {}),
    };
  }

  if (promptInjectionMode === "flag-prompt" || promptInjectionMode === "flag-interactive") {
    const promptFlag = config.promptFlag ??
      (promptInjectionMode === "flag-interactive" ? "--interactive" : "--prompt");
    return {
      executable,
      args: [
        ...baseArgs,
        ...(hasPrompt ? [promptFlag, prompt as string] : []),
        ...modeFlags,
        ...sessionArgs,
      ],
    };
  }

  if (hasPrompt && config.argvPromptSeparator) {
    return {
      executable,
      args: [
        ...baseArgs,
        ...modeFlags,
        ...sessionArgs,
        config.argvPromptSeparator,
        prompt as string,
      ],
    };
  }

  return {
    executable,
    args: [
      ...baseArgs,
      ...(hasPrompt ? [prompt as string] : []),
      ...modeFlags,
      ...sessionArgs,
    ],
  };
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function explicitExecutableKind(
  executable: string,
): AgentLaunchExecutableKind | null {
  const lower = executable.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".com")) return "native";
  if (lower.endsWith(".ps1")) return "powershell-script";
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) return "cmd-script";
  return null;
}

function validateResolvedExecutable(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !!value &&
    !FORBIDDEN_INLINE_CHARACTER.test(value)
  );
}

async function resolveWindowsExecutable(
  executable: string,
  dialect: Exclude<AgentLaunchDialect, "posix">,
  resolver: AgentLaunchExecutableKindResolver | undefined,
): Promise<{ executable: string; kind: AgentLaunchExecutableKind }> {
  if (!resolver) fail("unsupported-shell");

  let resolution: AgentLaunchExecutableResolution | null;
  try {
    resolution = await resolver(executable, dialect);
  } catch {
    fail("agent-unavailable");
  }
  if (!resolution) fail("agent-unavailable");
  if (
    resolution.kind !== "native" &&
    resolution.kind !== "powershell-script" &&
    resolution.kind !== "cmd-script"
  )
    fail("agent-unavailable");
  const resolved = resolution.executable;
  if (
    !validateResolvedExecutable(resolved) ||
    !path.win32.isAbsolute(resolved) ||
    !/^[A-Za-z]:[\\/]/.test(resolved)
  )
    fail("agent-unavailable");
  // The resolver also proves current existence. Its kind must agree with the actual resolved
  // suffix so a forged/stale "native" answer cannot route a .cmd shim through native quoting.
  if (explicitExecutableKind(resolved) !== resolution.kind)
    fail("agent-unavailable");
  return { executable: resolved, kind: resolution.kind };
}

/** Microsoft CRT/CommandLineToArgvW quoting for one native-process argument. */
function windowsNativeArg(value: string): string {
  if (value && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function powershellInvocation(
  executable: string,
  kind: AgentLaunchExecutableKind,
  args: string[],
): string {
  // A batch shim introduces a second cmd parse. `%`, `!`, quotes and Unicode cannot all be carried
  // losslessly through it as arbitrary argv, so require the trusted resolver to choose a native or
  // PowerShell-script entry point (npm installations normally provide the sibling `.ps1` shim).
  if (kind === "cmd-script") fail("unsupported-shell");
  if (kind === "powershell-script")
    return [
      "&",
      powershellQuote(executable),
      ...args.map(powershellQuote),
    ].join(" ");

  // Windows PowerShell 5.1's native-command marshaller loses embedded quotes before a program's
  // CRT parser sees them. Give Start-Process one already-quoted command-line string instead; it
  // inherits the ConPTY handles with -NoNewWindow and waits so the interactive shell remains the
  // agent's parent for the whole TUI lifetime.
  const argumentLine = args.map(windowsNativeArg).join(" ");
  if (executable.length + argumentLine.length + 2 > MAX_WINDOWS_COMMAND_LINE)
    fail("invalid-intent");
  return [
    `$ntAgent = Start-Process -FilePath ${powershellQuote(executable)}`,
    ...(args.length ? [`-ArgumentList ${powershellQuote(argumentLine)}`] : []),
    "-NoNewWindow -Wait -PassThru",
    "; $global:LASTEXITCODE = $ntAgent.ExitCode",
  ].join(" ");
}

function trustedWindowsPowerShellPath(value: string | undefined): string {
  if (
    !value ||
    !path.win32.isAbsolute(value) ||
    !/^[A-Za-z]:[\\/]/.test(value) ||
    FORBIDDEN_INLINE_CHARACTER.test(value) ||
    /["&|<>^%!]/.test(value) ||
    !value.toLowerCase().endsWith(".exe")
  )
    fail("unsupported-shell");
  return value;
}

function encodedPowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Validate a semantic request, resolve only trusted host configuration, and encode it for the
 * concrete live profile dialect. The returned command is core-private launch material.
 */
export async function prepareAgentLaunch(
  intent: AgentLaunchIntent,
  dialect: AgentLaunchDialect,
  context: AgentLaunchTrustedContext,
): Promise<PreparedAgentLaunch> {
  validateIntentRuntime(intent, context.expectedAgentId);
  const config = resolveTrustedAgentConfig(intent, context);
  // A custom process has no trusted readiness signal. Writing its prompt after a timer or generic
  // shell-output probe can race the child, leak text into the parent shell, or lose it on exit.
  if (!config.builtin && config.promptInjectionMode === "stdin-after-start")
    fail("unsupported-shell");
  const logical = logicalLaunch(intent, config, context);

  if (dialect === "posix") {
    const tokens = [logical.executable, ...logical.args];
    if (
      tokens.some(
        (token) =>
          Buffer.byteLength(token, "utf8") > MAX_PORTABLE_POSIX_ARGUMENT_BYTES,
      )
    )
      fail("invalid-intent");
    const command = tokens.map(posixQuote).join(" ");
    if (Buffer.byteLength(command, "utf8") > MAX_PORTABLE_POSIX_COMMAND_BYTES)
      fail("invalid-intent");
    return {
      command,
      ...(logical.stdinAfterStart !== undefined
        ? { stdinAfterStart: logical.stdinAfterStart }
        : {}),
    };
  }

  if (
    dialect !== "pwsh" &&
    dialect !== "windows-powershell" &&
    dialect !== "cmd"
  )
    fail("unsupported-shell");
  const resolved = await resolveWindowsExecutable(
    logical.executable,
    dialect,
    context.resolveExecutableKind,
  );
  const script = powershellInvocation(
    resolved.executable,
    resolved.kind,
    logical.args,
  );
  if (script.length > MAX_WINDOWS_COMMAND_LINE) fail("invalid-intent");

  if (dialect === "cmd") {
    const wrapper = trustedWindowsPowerShellPath(context.windowsPowerShellPath);
    const command = `"${wrapper}" -NoLogo -NoProfile -EncodedCommand ${encodedPowerShellCommand(script)}`;
    if (command.length > MAX_CMD_INTERACTIVE_LINE) fail("invalid-intent");
    return {
      command,
      ...(logical.stdinAfterStart !== undefined
        ? { stdinAfterStart: logical.stdinAfterStart }
        : {}),
    };
  }

  return {
    command: script,
    ...(logical.stdinAfterStart !== undefined
      ? { stdinAfterStart: logical.stdinAfterStart }
      : {}),
  };
}
