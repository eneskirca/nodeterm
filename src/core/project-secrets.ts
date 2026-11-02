/**
 * Project secrets — the core half (docs/project-secrets.md; shapes in @shared/project-secrets).
 *
 * The ONE holder of secret VALUES in Nodeterm. Rules, each with its source (the design follows
 * established practice and invents none):
 *  - Fetch = the askpass protocol (git `GIT_ASKPASS`, ssh `SSH_ASKPASS`): run the declared program,
 *    read the value from its standard output, once. No shell (`directExecutableInvocation` for a
 *    Windows `.cmd` shim, which escapes every token), bounded time and output.
 *  - Memory only (git `credential-cache`: "kept in memory … instead of being written to a file"),
 *    as `Buffer`s that are zeroed when dropped (OWASP Secrets Management, "zero out" memory after
 *    use; prefer overwritable types to immutable strings). A JS string exists only transiently, while
 *    one spawn's environment is built — node-pty and child_process take strings.
 *  - Never logged (OWASP §8.3, CWE-532): no function here logs, and errors name the variable and
 *    the exit code, never the command's output.
 *  - No value on any argv (CWE-214): values reach a process only through its environment.
 *  - No copy on disk in any form, encrypted or not (stricter than CWE-312's mitigations and than
 *    Doppler's encrypted fallback file, which is the one source that persists): nothing here writes.
 *  - One fetch per human authorization (rate limits: OWASP §4.4): nothing here refetches by itself.
 *  - A declaration with no command is PASTED: the person types the value into a small window main
 *    opens for it (`deps.promptValue`); the canvas window never holds it.
 *
 * Who may receive a value is decided in `spawnEnv` and nowhere else.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process'
import path from 'path'
import {
  SECRET_FETCH_TIMEOUT_MS,
  SECRET_REDACTION_MARKER,
  SECRET_REDACTION_MIN_LENGTH,
  SECRET_STDERR_SHOWN_MAX,
  SECRET_STDOUT_MAX_BYTES,
  SECRET_VALUE_MAX_BYTES,
  isValidSecretName,
  secretDeclKey,
  secretInput,
  type CrossProjectSecretsGate,
  type CrossProjectSecretsPolicy,
  type ProjectSecretDecl,
  type ProjectSecretStatus,
  type ProjectSecretsAuthorizeResult,
  type ProjectSecretsPasteResult,
  type ProjectSecretsUnsupported,
  type ProjectSecretsView
} from '../shared/project-secrets'
import { directExecutableInvocation, findExecutableSync } from './exec-path'

// ---------------------------------------------------------------------------------------------
// Fetch runner
// ---------------------------------------------------------------------------------------------

export type SecretFetchResult =
  | { ok: true; value: Buffer }
  | { ok: false; error: string; exitCode?: number | null; stderr?: string }

export interface SecretFetchDeps {
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess
  /** Resolve a bare program name to an executable path (PATH, PATHEXT on Windows). */
  resolve?: (bin: string) => string | null
  platform?: NodeJS.Platform
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/** A program named with a path separator is resolved against the project folder (like a shell
 *  would from that directory); a bare name against PATH. */
function resolveProgram(argv0: string, cwd: string, deps: SecretFetchDeps): string | null {
  if (/[\\/]/.test(argv0)) return path.resolve(cwd, argv0)
  return (deps.resolve ?? ((b) => findExecutableSync(b)))(argv0)
}

/** Strip exactly ONE trailing line ending (`\n` or `\r\n`), the askpass convention. */
export function stripOneLineEnding(buf: Buffer): Buffer {
  let end = buf.length
  if (end > 0 && buf[end - 1] === 0x0a) {
    end--
    if (end > 0 && buf[end - 1] === 0x0d) end--
  }
  return buf.subarray(0, end)
}

/** Why a candidate value is unusable as an environment value, or null when it is fine. `from`
 *  only words the message: a fetched value was printed, a pasted one was typed. */
export function valueProblem(value: Buffer, from: 'command' | 'paste' = 'command'): string | null {
  if (value.length === 0) return from === 'paste' ? 'the value is empty' : 'the command printed nothing'
  if (value.length > SECRET_VALUE_MAX_BYTES) return `the value is longer than ${SECRET_VALUE_MAX_BYTES} bytes`
  for (const byte of value) {
    if (byte === 0x0a || byte === 0x0d) {
      return from === 'paste' ? 'the value is more than one line' : 'the command printed more than one line'
    }
    if (byte === 0x00) return 'the value contains a NUL byte'
  }
  // An environment value is text; refuse bytes that are not valid UTF-8 rather than mangle them.
  if (!isUtf8(value)) return 'the value is not valid UTF-8 text'
  // A typed value: Unicode line and paragraph separators (and NEL) are line breaks too. No secret
  // contains one, and a paste that carries one was more than one line where it was copied.
  if (from === 'paste' && /[\u0085\u2028\u2029\v\f]/.test(value.toString('utf8'))) {
    return 'the value is more than one line'
  }
  return null
}

function isUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

/**
 * A pasted value as it will be held: line endings at either end removed (copying a token often
 * brings a trailing newline); every other character is kept, spaces included. Returns a NEW buffer;
 * the caller wipes the input.
 */
export function normalizePasted(raw: Buffer): Buffer {
  let start = 0
  let end = raw.length
  while (start < end && (raw[start] === 0x0a || raw[start] === 0x0d)) start++
  while (end > start && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d)) end--
  return Buffer.from(raw.subarray(start, end))
}

/** Zero a buffer in place. `Buffer.fill` writes the bytes; the GC frees the memory later. */
function wipe(buf: Buffer | null | undefined): void {
  if (buf) buf.fill(0)
}

/**
 * Run one declared fetch command and return its value. NEVER THROWS. The returned error text is
 * safe to show and to log: it never contains anything the command printed to standard output.
 */
export function runSecretCommand(
  command: string[],
  cwd: string,
  deps: SecretFetchDeps = {}
): Promise<SecretFetchResult> {
  return new Promise((resolve) => {
    const platform = deps.platform ?? process.platform
    const resolved = resolveProgram(command[0], cwd, deps)
    if (!resolved) {
      resolve({ ok: false, error: `program not found: ${command[0]}` })
      return
    }
    const invocation = directExecutableInvocation(resolved, command.slice(1), { platform })
    if (!invocation) {
      resolve({
        ok: false,
        error:
          platform === 'win32'
            ? 'this program cannot be run without a shell (.bat and .ps1 files, or arguments with line breaks); declare its interpreter instead'
            : 'this command cannot be run'
      })
      return
    }
    let child: ChildProcess
    try {
      child = (deps.spawn ?? nodeSpawn)(invocation.executable, invocation.args, {
        cwd,
        env: { ...(deps.env ?? process.env) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        ...(invocation.options ?? {})
      })
    } catch (err) {
      resolve({ ok: false, error: `could not start the program (${errCode(err)})` })
      return
    }
    const out: Buffer[] = []
    let outBytes = 0
    let overflow = false
    let errText = ''
    let settled = false
    const finish = (r: SecretFetchResult): void => {
      if (settled) {
        if (r.ok) wipe(r.value)
        return
      }
      settled = true
      clearTimeout(timer)
      for (const chunk of out) wipe(chunk)
      out.length = 0
      resolve(r)
    }
    const timeoutMs = deps.timeoutMs ?? SECRET_FETCH_TIMEOUT_MS
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: `the command did not finish within ${Math.max(1, Math.round(timeoutMs / 1000))} s`, stderr: errText || undefined })
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) {
        wipe(chunk)
        return
      }
      outBytes += chunk.length
      if (outBytes > SECRET_STDOUT_MAX_BYTES) {
        overflow = true
        wipe(chunk)
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        return
      }
      out.push(Buffer.from(chunk))
      wipe(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errText.length < SECRET_STDERR_SHOWN_MAX) {
        errText = (errText + chunk.toString('utf8')).slice(0, SECRET_STDERR_SHOWN_MAX)
      }
    })
    child.on('error', (err) => finish({ ok: false, error: `could not start the program (${errCode(err)})` }))
    child.on('close', (code) => {
      if (overflow) {
        finish({ ok: false, error: `the command printed more than ${SECRET_STDOUT_MAX_BYTES} bytes`, exitCode: code })
        return
      }
      if (code !== 0) {
        finish({ ok: false, error: `the command exited with code ${code}`, exitCode: code, stderr: errText || undefined })
        return
      }
      const joined = Buffer.concat(out)
      const value = Buffer.from(stripOneLineEnding(joined))
      wipe(joined)
      const problem = valueProblem(value)
      if (problem) {
        wipe(value)
        finish({ ok: false, error: problem, exitCode: code })
        return
      }
      finish({ ok: true, value })
    })
  })
}

function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'error'
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export interface DeclaredSecret {
  decl: ProjectSecretDecl
  source: 'local' | 'shared'
}

export type DeclarationsRead =
  | { kind: 'ok'; cwd: string; secrets: DeclaredSecret[] }
  | { kind: 'unavailable'; reason: ProjectSecretsUnsupported }

export interface ProjectSecretsDeps {
  /** The project's declarations and folder, from this process's own index + settings read. */
  readDeclarations(projectId: string): Promise<DeclarationsRead>
  /** The human confirmation (desktop: a native dialog in main). Resolves true only on "Fetch". */
  confirm(projectId: string, secrets: DeclaredSecret[]): Promise<boolean>
  /**
   * The person types one value (desktop: a small window main opens). `check` answers why a
   * candidate is refused (shown in that window, which stays open) or null to accept it. Resolves the
   * accepted value, or null when the person cancels. Absent = pasting is not offered.
   */
  promptValue?(
    projectId: string,
    secret: DeclaredSecret,
    check: (value: Buffer) => string | null,
    replacing: boolean
  ): Promise<Buffer | null>
  /** The machine-local cross-project policy, read live. */
  crossProjectPolicy(): CrossProjectSecretsPolicy
  run?: (command: string[], cwd: string) => Promise<SecretFetchResult>
}

interface Held {
  key: string
  buf: Buffer
}

interface Failure {
  key: string
  error: string
  exitCode?: number | null
  stderr?: string
}

/** What `spawnEnv` needs to know about one spawn. */
export interface SecretSpawnInput {
  /** The owning project (`PtyCreateOptions.ownerProjectId`). */
  projectId?: string
  /** The project's CURRENT declarations, read with the spawn's other project overrides. */
  declarations?: ProjectSecretDecl[]
  agentId?: string
  nodeId?: string
  /** The spawn was asked for by this machine's own app (main window, or a headless start it
   *  asked for) — never a relay peer, a phone, a hosted teammate or a watcher. */
  ownerClient: boolean
  /** An SSH node: refused (a value would have to travel to the host). */
  remote: boolean
  /** The node was opened in this project by an agent of another project. */
  crossProject: boolean
}

export class ProjectSecretsService {
  private held = new Map<string, Map<string, Held>>()
  private failures = new Map<string, Map<string, Failure>>()
  /** The folder each project's values were fetched or pasted for: a re-bound folder drops them. */
  private heldCwd = new Map<string, string>()
  private inFlight = new Set<string>()
  /** `${projectId}\0${nodeId}` → the person's answer for a cross-project node, this app run. */
  private crossDecisions = new Map<string, boolean>()
  private listeners = new Set<(projectId: string) => void>()

  constructor(private readonly deps: ProjectSecretsDeps) {}

  onChanged(listener: (projectId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(projectId: string): void {
    for (const l of this.listeners) {
      try {
        l(projectId)
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  private viewFor(projectId: string, read: DeclarationsRead): ProjectSecretsView {
    if (read.kind === 'unavailable') return { unavailable: read.reason, secrets: [] }
    const held = this.held.get(projectId)
    const failures = this.failures.get(projectId)
    const secrets: ProjectSecretStatus[] = read.secrets.map(({ decl, source }) => {
      const key = secretDeclKey(decl)
      const base = {
        env: decl.env,
        input: secretInput(decl),
        ...(decl.command ? { command: [...decl.command] } : {}),
        source
      }
      const h = held?.get(decl.env)
      if (h) return { ...base, state: h.key === key ? 'available' : 'declaration-changed' }
      const f = failures?.get(decl.env)
      if (f && f.key === key) {
        return {
          ...base,
          state: 'failed',
          error: f.error,
          ...(f.exitCode !== undefined ? { exitCode: f.exitCode } : {}),
          ...(f.stderr ? { stderr: f.stderr } : {})
        }
      }
      return { ...base, state: 'not-fetched' }
    })
    return { secrets }
  }

  async status(projectId: string): Promise<ProjectSecretsView> {
    return this.viewFor(projectId, await this.safeRead(projectId))
  }

  private async safeRead(projectId: string): Promise<DeclarationsRead> {
    try {
      return await this.deps.readDeclarations(projectId)
    } catch {
      return { kind: 'unavailable', reason: 'unknown-project' }
    }
  }

  /**
   * The ONLY path that runs a fetch command. Called from the desktop's authorize IPC, which only
   * the person's click in the Secrets dialog reaches; `confirm` then asks again natively.
   */
  async authorize(projectId: string): Promise<ProjectSecretsAuthorizeResult> {
    const read = await this.safeRead(projectId)
    if (read.kind === 'unavailable') {
      return { kind: 'refused', reason: read.reason, view: this.viewFor(projectId, read) }
    }
    const fetched = read.secrets.filter((s) => s.decl.command)
    if (fetched.length === 0) {
      return { kind: 'refused', reason: 'nothing-declared', view: this.viewFor(projectId, read) }
    }
    if (this.inFlight.has(projectId)) {
      return { kind: 'refused', reason: 'busy', view: this.viewFor(projectId, read) }
    }
    this.inFlight.add(projectId)
    try {
      let confirmed = false
      try {
        confirmed = await this.deps.confirm(projectId, fetched)
      } catch {
        confirmed = false
      }
      if (!confirmed) return { kind: 'cancelled', view: this.viewFor(projectId, read) }
      // Re-authorization replaces every FETCHED value: what the person just approved is the whole
      // set of commands. A pasted value is kept while its declaration still asks for a paste.
      const held = this.takePasted(projectId, read.secrets, read.cwd)
      this.dropProject(projectId, false)
      const failures = new Map<string, Failure>()
      const run = this.deps.run ?? ((c: string[], cwd: string) => runSecretCommand(c, cwd))
      // Sequentially: a secret manager's own approval prompts then appear one at a time.
      for (const { decl } of fetched) {
        const key = secretDeclKey(decl)
        let r: SecretFetchResult
        try {
          r = await run(decl.command!, read.cwd)
        } catch {
          r = { ok: false, error: 'the command could not be run' }
        }
        if (r.ok) held.set(decl.env, { key, buf: r.value })
        else failures.set(decl.env, { key, error: r.error, exitCode: r.exitCode, stderr: r.stderr })
      }
      if (held.size) {
        this.held.set(projectId, held)
        this.heldCwd.set(projectId, read.cwd)
      }
      if (failures.size) this.failures.set(projectId, failures)
      this.emit(projectId)
      return { kind: 'done', view: this.viewFor(projectId, read) }
    } finally {
      this.inFlight.delete(projectId)
    }
  }

  /** The held pasted values whose declaration still asks for a paste, at the same folder, moved OUT
   *  of the project's map (so a following `dropProject` does not wipe them). */
  private takePasted(projectId: string, secrets: DeclaredSecret[], cwd: string): Map<string, Held> {
    const out = new Map<string, Held>()
    const held = this.held.get(projectId)
    if (!held || this.heldCwd.get(projectId) !== cwd) return out
    for (const { decl } of secrets) {
      if (decl.command) continue
      const h = held.get(decl.env)
      if (h && h.key === secretDeclKey(decl)) {
        out.set(decl.env, h)
        held.delete(decl.env)
      }
    }
    return out
  }

  /**
   * The ONLY path that takes a pasted value: the desktop's paste IPC (the person's click in the
   * Secrets dialog) asks `deps.promptValue`, i.e. the person types it into main's own window.
   */
  async paste(projectId: string, env: string): Promise<ProjectSecretsPasteResult> {
    const read = await this.safeRead(projectId)
    if (read.kind === 'unavailable') {
      return { kind: 'refused', reason: read.reason, view: this.viewFor(projectId, read) }
    }
    const secret = read.secrets.find((s) => s.decl.env === env && !s.decl.command)
    if (!secret || !this.deps.promptValue) {
      return { kind: 'refused', reason: 'not-pasted', view: this.viewFor(projectId, read) }
    }
    if (this.inFlight.has(projectId)) {
      return { kind: 'refused', reason: 'busy', view: this.viewFor(projectId, read) }
    }
    this.inFlight.add(projectId)
    try {
      let value: Buffer | null = null
      try {
        const replacing = this.held.get(projectId)?.has(env) === true
        value = await this.deps.promptValue(projectId, secret, (v) => valueProblem(v, 'paste'), replacing)
      } catch {
        value = null
      }
      // The window already refused a bad value; checked again so no caller can skip it.
      if (value && valueProblem(value, 'paste')) {
        wipe(value)
        value = null
      }
      if (!value) return { kind: 'cancelled', view: this.viewFor(projectId, read) }
      // Values held for another folder go first (the project was re-bound since).
      const heldAt = this.heldCwd.get(projectId)
      if (heldAt !== undefined && heldAt !== read.cwd) this.dropProject(projectId, false)
      let held = this.held.get(projectId)
      if (!held) {
        held = new Map()
        this.held.set(projectId, held)
      }
      wipe(held.get(env)?.buf)
      held.set(env, { key: secretDeclKey(secret.decl), buf: value })
      this.heldCwd.set(projectId, read.cwd)
      this.failures.get(projectId)?.delete(env)
      this.emit(projectId)
      return { kind: 'done', view: this.viewFor(projectId, read) }
    } finally {
      this.inFlight.delete(projectId)
    }
  }

  private dropProject(projectId: string, notify: boolean): void {
    const held = this.held.get(projectId)
    if (held) for (const h of held.values()) wipe(h.buf)
    const had = this.held.delete(projectId) || this.failures.delete(projectId)
    this.failures.delete(projectId)
    this.heldCwd.delete(projectId)
    for (const k of [...this.crossDecisions.keys()]) {
      if (k.startsWith(projectId + '\0')) this.crossDecisions.delete(k)
    }
    if (notify && had) this.emit(projectId)
  }

  /** Explicit Clear. Running agents keep what they were started with. */
  async clear(projectId: string): Promise<ProjectSecretsView> {
    this.dropProject(projectId, true)
    return this.status(projectId)
  }

  /**
   * Keep only the projects still open here, at the folder their values were taken for. Called
   * by the shell after workspace writes: closing, deleting or re-binding a project drops its values.
   */
  retainProjects(open: ReadonlyMap<string, string | undefined>): void {
    for (const projectId of [...new Set([...this.held.keys(), ...this.failures.keys()])]) {
      const cwd = open.get(projectId)
      const heldAt = this.heldCwd.get(projectId)
      if (!open.has(projectId) || (heldAt !== undefined && cwd !== heldAt)) this.dropProject(projectId, true)
    }
  }

  /** App quit: zero every value. */
  dispose(): void {
    for (const projectId of [...this.held.keys()]) this.dropProject(projectId, false)
    this.failures.clear()
    this.crossDecisions.clear()
  }

  private heldNames(projectId: string): string[] {
    return [...(this.held.get(projectId)?.keys() ?? [])]
  }

  async crossProjectGate(projectId: string, nodeId: string): Promise<CrossProjectSecretsGate> {
    if (this.deps.crossProjectPolicy() !== 'ask') return { kind: 'proceed' }
    if (this.crossDecisions.has(projectId + '\0' + nodeId)) return { kind: 'proceed' }
    const names = this.heldNames(projectId)
    // Nothing held: nothing to give, so nothing to ask. The node starts without secrets.
    if (names.length === 0) return { kind: 'proceed' }
    return { kind: 'ask', names }
  }

  decideCrossProject(projectId: string, nodeId: string, grant: boolean): void {
    if (!projectId || !nodeId) return
    this.crossDecisions.set(projectId + '\0' + nodeId, grant === true)
  }

  /**
   * The environment one spawn receives from its project's secrets. Synchronous (the spawn is).
   * Every refusal answers `{}`: values go only to an AGENT node, of the declaring project, spawned
   * locally for this machine's own app, for the exact declaration the person authorized, and — for
   * a node another project's agent opened — only as the cross-project policy allows.
   */
  spawnEnv(input: SecretSpawnInput): Record<string, string> {
    const projectId = input.projectId
    if (!projectId || !input.ownerClient || input.remote || !input.agentId) return {}
    const decls = input.declarations
    if (!decls?.length) return {}
    const held = this.held.get(projectId)
    if (!held?.size) return {}
    if (input.crossProject) {
      const policy = this.deps.crossProjectPolicy()
      if (policy === 'deny') return {}
      if (policy === 'ask' && this.crossDecisions.get(projectId + '\0' + (input.nodeId ?? '')) !== true) return {}
    }
    const out: Record<string, string> = {}
    for (const decl of decls) {
      if (!isValidSecretName(decl.env)) continue
      const h = held.get(decl.env)
      if (!h || h.key !== secretDeclKey(decl)) continue
      out[decl.env] = h.buf.toString('utf8')
    }
    return out
  }

  /** Every held value long enough to be worth concealing, longest first (so a value that contains
   *  another is replaced whole). Used by `redact`; the strings are transient. */
  private redactable(): string[] {
    const values: string[] = []
    for (const project of this.held.values()) {
      for (const h of project.values()) {
        if (h.buf.length >= SECRET_REDACTION_MIN_LENGTH) values.push(h.buf.toString('utf8'))
      }
    }
    return values.sort((a, b) => b.length - a.length)
  }

  /**
   * Replace every held value in text Nodeterm is about to WRITE (scrollback snapshots). A value
   * printed while it is not held (after an app restart) or split by a line wrap is not caught.
   */
  redact(text: string): string {
    if (!text) return text
    const values = this.redactable()
    if (values.length === 0) return text
    let out = text
    for (const v of values) if (out.includes(v)) out = out.split(v).join(SECRET_REDACTION_MARKER)
    return out
  }

  /** True while any value is held (lets a caller skip work). */
  holdsAny(): boolean {
    for (const p of this.held.values()) if (p.size) return true
    return false
  }
}
