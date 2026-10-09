/**
 * The run node: VS Code's "Run Without Debugging" for any `.vscode/launch.json` configuration, as
 * a canvas terminal. A terminal node carrying `data.runConfig` (NOT a new NodeKind): the run lives
 * in the node's tmux session, so it inherits everything a terminal already has.
 *
 * launch.json does not run anything by itself — each `type` belongs to a VS Code extension (a
 * debug adapter) that turns the configuration into a process. This module is the table of what
 * those extensions would run, type by type (`planLaunch`), for the `"request": "launch"` form:
 *
 *   dart       flutter run / flutter test / dart run / dart test   (Flutter: hot reload + devices)
 *   node, pwa-node, node-terminal          node / runtimeExecutable / command
 *   python, debugpy                        python program | -m module
 *   go                                     go run / go test / the built binary
 *   php                                    php program
 *   coreclr                                dotnet program.dll | program
 *   lldb, cppdbg                           the program itself
 *   chrome, msedge, pwa-chrome, pwa-msedge open `url` in a browser node
 *
 * What it deliberately does NOT do, and says so instead of guessing: debugging (breakpoints are a
 * debug-adapter protocol, not a command line), `"request": "attach"` (there is nothing to start),
 * unknown types, and the variables that need an editor or an extension (`${file}`, `${input:…}`,
 * `${command:…}` beyond the Python interpreter one, `${config:…}`).
 *
 * Every value here comes from files in a repository (launch.json, tasks.json, and the git-shared
 * `.nodeterm/project.json` that stores the node's choice), so none of it is ever pasted into a
 * shell: the host writes a launcher script whose every token is single-quoted (`buildLauncher`),
 * and only `sh '<that script>'` is typed into the node's terminal. Environment values (including an
 * `envFile`'s secrets) therefore never land in the user's shell history or scrollback.
 */
import { shellSingleQuote, shellSplit } from './shell-quote'

// ─── The node's persisted choice ─────────────────────────────────────────────────────────────

/** Persisted on a terminal node as `data.runConfig`. */
export interface RunNodeConfig {
  /** Absolute path of the workspace folder (the one holding `.vscode/`). Defaults to the project's. */
  projectDir: string
  /** Name of a configuration or compound in `<projectDir>/.vscode/launch.json`. Absent = default. */
  launchConfig?: string
  /** Flutter: `-d <id>`. Ignored when the configuration pins its own device. */
  deviceId?: string
  /** The device's display name when picked, so the bar can label it before devices load. */
  deviceName?: string
  /** Extra arguments appended to the program's arguments, shell-split and quoted per token. */
  extraArgs?: string
  /** Flutter: hot reload when a `.dart` file under `lib/` changes. Default on. */
  reloadOnSave: boolean
  /** Whether the node shows its terminal (and the extra-arguments field). Default hidden. */
  showTerminal?: boolean
  /** Flutter web runs (Chrome / Edge): show the app INSIDE the run node (the default — Flutter's
   *  web server serves it to the node's browser panel). `false` = Flutter's own Chrome window. */
  embedBrowser?: boolean
}

const MAX_PATH = 4096
const MAX_EXTRA_ARGS = 2000
const MAX_NAME = 200
/** Device ids are simulator UDIDs, `macos`, `chrome`, emulator ids, physical UDIDs — never shell. */
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/
/** Node ids become launcher/pid file names; the charset tmux session names are held to. */
export const RUN_NODE_ID = /^[A-Za-z0-9._-]{1,128}$/
export const SIMULATOR_UDID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** An absolute POSIX or Windows path with no control characters. */
export function isSafeRunDir(dir: unknown): dir is string {
  if (typeof dir !== 'string' || dir.length === 0 || dir.length > MAX_PATH) return false
  if (CONTROL.test(dir)) return false
  return dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir)
}

export function isSafeDeviceId(id: unknown): id is string {
  return typeof id === 'string' && DEVICE_ID.test(id)
}

function oneLine(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s || s.length > max || CONTROL.test(s)) return undefined
  return s
}

/**
 * Re-validate a persisted run config (git-shared, hand-editable). `undefined` = not a run node (or
 * too broken to describe one), which degrades the node to a plain terminal rather than failing.
 */
export function normalizeRunConfig(raw: unknown): RunNodeConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (!isSafeRunDir(r.projectDir)) return undefined
  const out: RunNodeConfig = { projectDir: r.projectDir, reloadOnSave: r.reloadOnSave !== false }
  const launchConfig = oneLine(r.launchConfig, MAX_NAME)
  if (launchConfig) out.launchConfig = launchConfig
  if (isSafeDeviceId(r.deviceId)) {
    out.deviceId = r.deviceId
    const deviceName = oneLine(r.deviceName, MAX_NAME)
    if (deviceName) out.deviceName = deviceName
  }
  const extraArgs = oneLine(r.extraArgs, MAX_EXTRA_ARGS)
  if (extraArgs) out.extraArgs = extraArgs
  if (r.showTerminal === true) out.showTerminal = true
  if (r.embedBrowser === false) out.embedBrowser = false
  return out
}

// ─── JSONC + the two files ───────────────────────────────────────────────────────────────────

/**
 * VS Code's launch.json / tasks.json are JSONC: `//` and `/* *\/` comments and trailing commas.
 * Strip them outside strings, then JSON.parse. Throws on anything else.
 */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else {
      out += c
      i++
    }
  }
  let cleaned = ''
  inString = false
  for (let j = 0; j < out.length; j++) {
    const c = out[j]
    if (inString) {
      cleaned += c
      if (c === '\\' && j + 1 < out.length) cleaned += out[++j]
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      cleaned += c
      continue
    }
    if (c === ',') {
      let k = j + 1
      while (k < out.length && /\s/.test(out[k])) k++
      if (out[k] === ']' || out[k] === '}') continue
    }
    cleaned += c
  }
  return JSON.parse(cleaned)
}

export type OsKey = 'osx' | 'linux' | 'windows'

export function osKeyFor(platform: string): OsKey {
  return platform === 'darwin' ? 'osx' : platform === 'win32' ? 'windows' : 'linux'
}

/** A configuration as written, with its `osx`/`linux`/`windows` block merged over it. */
export interface LaunchConfig {
  name: string
  type: string
  request: string
  raw: Record<string, unknown>
}

export interface LaunchCompound {
  name: string
  configurations: string[]
}

export interface LaunchFile {
  configs: LaunchConfig[]
  compounds: LaunchCompound[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function withOsOverride(raw: Record<string, unknown>, os: OsKey): Record<string, unknown> {
  const o = raw[os]
  return isRecord(o) ? { ...raw, ...o } : raw
}

/** Configurations and compounds, in file order. Throws on unparseable JSONC. */
export function parseLaunchFile(text: string, os: OsKey = 'osx'): LaunchFile {
  const doc = parseJsonc(text) as { configurations?: unknown; compounds?: unknown }
  const configs: LaunchConfig[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(doc?.configurations) ? doc.configurations : []) {
    if (!isRecord(item)) continue
    const raw = withOsOverride(item, os)
    const name = oneLine(raw.name, MAX_NAME)
    const type = oneLine(raw.type, MAX_NAME)
    if (!name || !type || seen.has(name)) continue
    seen.add(name)
    configs.push({ name, type, request: typeof raw.request === 'string' ? raw.request : 'launch', raw })
  }
  const compounds: LaunchCompound[] = []
  for (const item of Array.isArray(doc?.compounds) ? doc.compounds : []) {
    if (!isRecord(item)) continue
    const name = oneLine(item.name, MAX_NAME)
    if (!name || seen.has(name)) continue
    seen.add(name)
    const members = (Array.isArray(item.configurations) ? item.configurations : [])
      .map((m) => (typeof m === 'string' ? m : isRecord(m) && typeof m.name === 'string' ? m.name : null))
      .filter((m): m is string => !!m)
    compounds.push({ name, configurations: members })
  }
  return { configs, compounds }
}

/** A task from tasks.json, with its OS block merged over it. */
export interface TaskDef {
  label: string
  raw: Record<string, unknown>
}

/** Tasks in file order, keyed by `label` (or VS Code's derived `npm: <script>`). Throws on bad JSONC. */
export function parseTasksFile(text: string, os: OsKey = 'osx'): TaskDef[] {
  const doc = parseJsonc(text) as { tasks?: unknown }
  const out: TaskDef[] = []
  for (const item of Array.isArray(doc?.tasks) ? doc.tasks : []) {
    if (!isRecord(item)) continue
    const raw = withOsOverride(item, os)
    const label =
      oneLine(raw.label, MAX_NAME) ??
      (raw.type === 'npm' && typeof raw.script === 'string' ? `npm: ${raw.script}` : undefined) ??
      (typeof raw.type === 'string' && typeof raw.command === 'string' ? `${raw.type}: ${raw.command}` : undefined)
    if (label) out.push({ label, raw })
  }
  return out
}

// ─── Describing a configuration (cheap, no environment) ──────────────────────────────────────

/** What the bar needs to know about an entry before anything runs. */
export interface LaunchEntry {
  name: string
  kind: 'config' | 'compound'
  /** The VS Code `type` ('' for compounds). */
  type: string
  /** "Flutter", "Node.js", "Python", … — shown beside the name. */
  typeLabel: string
  /** False when this configuration cannot be run here; `reason` says why. */
  supported: boolean
  reason?: string
  /** Flutter runs: pick a device (unless `pinnedDevice`). */
  usesDevice: boolean
  /** Flutter `flutter run`: hot reload / hot restart / reload on save. */
  hotReload: boolean
  /** The device a Flutter configuration names itself. */
  pinnedDevice?: string
  /** Opens a URL in a browser node instead of running a process. */
  browser: boolean
  /** Compounds: the member configuration names. */
  members?: string[]
  /** The configuration's `preLaunchTask`, if any. */
  preLaunchTask?: string
}

const TYPE_LABEL: Record<string, string> = {
  dart: 'Dart',
  node: 'Node.js',
  'pwa-node': 'Node.js',
  'node-terminal': 'Node.js',
  python: 'Python',
  debugpy: 'Python',
  go: 'Go',
  php: 'PHP',
  coreclr: '.NET',
  lldb: 'Native',
  cppdbg: 'Native',
  chrome: 'Browser',
  msedge: 'Browser',
  'pwa-chrome': 'Browser',
  'pwa-msedge': 'Browser'
}

export const SUPPORTED_TYPES = Object.keys(TYPE_LABEL)

const BROWSER_TYPES = new Set(['chrome', 'msedge', 'pwa-chrome', 'pwa-msedge'])

export function typeLabel(type: string, isFlutterProject: boolean): string {
  if (type === 'dart') return isFlutterProject ? 'Flutter' : 'Dart'
  return TYPE_LABEL[type] ?? type
}

function strArray(v: unknown): string[] {
  if (typeof v === 'string') return shellSplit(v)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** Flutter's browser devices open a Chrome window of their own; its web server serves the same app
 *  to any browser and prints the address. Every other device is itself. */
export function webServerDevice(d: string): string {
  return d === 'chrome' || d === 'edge' ? 'web-server' : d
}

/** Whether a configuration names its device in its own args (as opposed to the `deviceId` field). */
function pinnedInArgs(raw: Record<string, unknown>): boolean {
  return [...strArray(raw.args), ...strArray(raw.toolArgs)].some(
    (t) => t === '-d' || t === '--device-id' || t.startsWith('-d=') || t.startsWith('--device-id=')
  )
}

/** The device a Dart configuration pins (`-d x`, `--device-id x`, `-d=x`, or `deviceId`). */
export function pinnedDevice(raw: Record<string, unknown>): string | undefined {
  const a = [...strArray(raw.args), ...strArray(raw.toolArgs)]
  for (let i = 0; i < a.length; i++) {
    const t = a[i]
    if ((t === '-d' || t === '--device-id') && a[i + 1]) return a[i + 1]
    if (t.startsWith('-d=')) return t.slice(3)
    if (t.startsWith('--device-id=')) return t.slice('--device-id='.length)
  }
  return isSafeDeviceId(raw.deviceId) ? raw.deviceId : undefined
}

/** Dart-Code runs a `program` under test/ or integration_test/ (or a *_test.dart) as a TEST. */
export function isDartTestProgram(program: string | undefined): boolean {
  if (!program) return false
  const p = program.replace(/\\/g, '/')
  return /(^|\/)(test|integration_test)\//.test(p) || p.endsWith('_test.dart')
}

const UNSUPPORTED_VAR = /\$\{(file|fileBasename|fileBasenameNoExtension|fileDirname|fileExtname|fileWorkspaceFolder|relativeFile|relativeFileDirname|lineNumber|selectedText|execPath|input:[^}]*|config:[^}]*|command:[^}]*|workspaceFolder:[^}]*)\}/

/** The first variable in `raw` that needs an editor or an extension to resolve, if any. */
export function unsupportedVariable(raw: unknown): string | undefined {
  const text = JSON.stringify(raw)
  const re = new RegExp(UNSUPPORTED_VAR.source, 'g')
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // The Python extension's interpreter is the one `${command:…}` we can answer ourselves.
    if (m[1] === 'command:python.interpreterPath') continue
    return m[0]
  }
  return undefined
}

export function describeConfig(cfg: LaunchConfig, isFlutterProject: boolean): LaunchEntry {
  const base: LaunchEntry = {
    name: cfg.name,
    kind: 'config',
    type: cfg.type,
    typeLabel: typeLabel(cfg.type, isFlutterProject),
    supported: true,
    usesDevice: false,
    hotReload: false,
    browser: BROWSER_TYPES.has(cfg.type),
    ...(str(cfg.raw.preLaunchTask) ? { preLaunchTask: str(cfg.raw.preLaunchTask) } : {})
  }
  const refuse = (reason: string): LaunchEntry => ({ ...base, supported: false, reason })
  if (cfg.request !== 'launch') {
    return refuse(`“${cfg.name}” attaches to a process that is already running — there is nothing to start.`)
  }
  if (!(cfg.type in TYPE_LABEL)) return refuse(`“${cfg.type}” configurations are not supported yet.`)
  const v = unsupportedVariable(cfg.raw)
  if (v) return refuse(`${v} needs VS Code to resolve — it cannot run here.`)
  if (cfg.type === 'dart') {
    const program = str(cfg.raw.program)
    const isTest = isDartTestProgram(program)
    const flutter = isFlutterProject || cfg.raw.flutterMode !== undefined
    if (flutter) {
      const pinned = pinnedDevice(cfg.raw)
      // A widget test runs headless; an integration test runs on a device, like the app.
      const onDevice = !isTest || /(^|\/)integration_test\//.test((program ?? '').replace(/\\/g, '/'))
      return {
        ...base,
        typeLabel: 'Flutter',
        usesDevice: onDevice,
        hotReload: !isTest,
        ...(pinned ? { pinnedDevice: pinned } : {})
      }
    }
    if (!program) return refuse(`“${cfg.name}” has no program to run.`)
    return base
  }
  if (cfg.type === 'php' && !str(cfg.raw.program)) {
    return refuse(`“${cfg.name}” listens for Xdebug — there is nothing to start. Run the app separately.`)
  }
  if (base.browser && !str(cfg.raw.url)) return refuse(`“${cfg.name}” has no url to open.`)
  return base
}

export function describeLaunchFile(file: LaunchFile, isFlutterProject: boolean): LaunchEntry[] {
  const configs = file.configs.map((c) => describeConfig(c, isFlutterProject))
  const names = new Set(file.configs.map((c) => c.name))
  const compounds = file.compounds.map((c): LaunchEntry => {
    const missing = c.configurations.filter((m) => !names.has(m))
    return {
      name: c.name,
      kind: 'compound',
      type: '',
      typeLabel: 'Compound',
      supported: missing.length === 0 && c.configurations.length > 0,
      ...(missing.length
        ? { reason: `“${c.name}” names configurations that are not in launch.json: ${missing.join(', ')}.` }
        : c.configurations.length === 0
          ? { reason: `“${c.name}” lists no configurations.` }
          : {}),
      usesDevice: false,
      hotReload: false,
      browser: false,
      members: c.configurations
    }
  })
  return [...configs, ...compounds]
}

/** The synthetic entry a Flutter checkout with no launch.json gets: plain `flutter run`. */
export const DEFAULT_FLUTTER_ENTRY = 'flutter run (lib/main.dart)'

/** Which entry a node runs: its named one, else the first supported configuration that leaves
 *  the device to the picker (VS Code's "Current device" style), else the first supported one. */
export function resolveEntry(entries: readonly LaunchEntry[], name: string | undefined): LaunchEntry | undefined {
  if (name) {
    const hit = entries.find((e) => e.name === name)
    if (hit) return hit
  }
  const runnable = entries.filter((e) => e.supported && e.kind === 'config')
  return runnable.find((e) => e.usesDevice && !e.pinnedDevice) ?? runnable[0] ?? entries[0]
}

// ─── Planning a run ──────────────────────────────────────────────────────────────────────────

export interface PlanContext {
  /** `${workspaceFolder}` — the node's projectDir. */
  workspace: string
  /** `${userHome}`. */
  home: string
  /** `${env:NAME}`, pre-resolved by the host from the user's login environment. */
  env: Readonly<Record<string, string>>
  isFlutterProject: boolean
  /** The interpreter the Python extension would pick: a workspace venv, else `python3`. */
  pythonPath: string
  /** The node's device, for Flutter runs. */
  deviceId?: string
  /** The node's extra arguments, appended to the program's own. */
  extraArgs?: string
  /** Run a Flutter browser device (chrome / edge) on Flutter's web server instead, so the app is
   *  served to the run node's browser panel rather than to a Chrome window of Flutter's own. */
  webServer?: boolean
  /** Where `flutter run` writes its pid (for hot reload / restart signals). */
  flutterPidFile: string
  tasks: readonly TaskDef[]
}

/** One preLaunchTask step: a process argv, or a shell command line (`sh -c`). */
export interface TaskStep {
  label: string
  cwd: string
  env: Record<string, string>
  argv?: string[]
  shell?: string
}

export interface ProcessPlan {
  kind: 'process'
  name: string
  cwd: string
  env: Record<string, string>
  /** Absolute path of an `envFile` to load before `env` (which wins), when the config names one. */
  envFile?: string
  /** A program argv — or, for `node-terminal`'s free-form `command`, a shell line. */
  argv?: string[]
  shell?: string
  preTasks: TaskStep[]
  /** `flutter run` (hot reload by signal), anything else is plain stop/restart. */
  hotReload: boolean
}

export interface BrowserPlan {
  kind: 'browser'
  name: string
  url: string
}

export type PlanResult = { ok: true; plan: ProcessPlan | BrowserPlan } | { ok: false; error: string }

/** Expand the variables we can answer. Throws `Error(<variable>)` on one we cannot. */
export function expandVars(s: string, ctx: PlanContext): string {
  return s.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    if (name === 'workspaceFolder' || name === 'workspaceRoot' || name === 'cwd') return ctx.workspace
    if (name === 'workspaceFolderBasename') return ctx.workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
    if (name === 'userHome') return ctx.home
    if (name === 'pathSeparator' || name === '/') return '/'
    if (name === 'command:python.interpreterPath') return ctx.pythonPath
    if (name.startsWith('env:')) return ctx.env[name.slice(4)] ?? ''
    throw new Error(whole)
  })
}

function joinPath(base: string, rel: string): string {
  if (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)) return rel
  return `${base.replace(/\/+$/, '')}/${rel.replace(/^\.\//, '')}`
}

function envRecord(v: unknown, ctx: PlanContext): Record<string, string> {
  const out: Record<string, string> = {}
  if (isRecord(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        out[k] = expandVars(String(val), ctx)
      }
    }
  } else if (Array.isArray(v)) {
    // cppdbg: `environment: [{ name, value }]`
    for (const e of v) {
      if (isRecord(e) && typeof e.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name)) {
        out[e.name] = expandVars(String(e.value ?? ''), ctx)
      }
    }
  }
  return out
}

const MAX_TASK_DEPTH = 8

/** The steps a `preLaunchTask` (and its `dependsOn`) runs, in order. Throws Error(reason). */
export function planTask(label: string, ctx: PlanContext, depth = 0, seen = new Set<string>()): TaskStep[] {
  if (depth > MAX_TASK_DEPTH || seen.has(label)) throw new Error(`Task “${label}” depends on itself.`)
  seen.add(label)
  const task =
    label === '${defaultBuildTask}'
      ? ctx.tasks.find((t) => {
          const g = t.raw.group
          return isRecord(g) && g.kind === 'build' && g.isDefault === true
        })
      : ctx.tasks.find((t) => t.label === label)
  if (!task) throw new Error(`Task “${label}” is not in .vscode/tasks.json.`)
  const t = task.raw
  const steps: TaskStep[] = []
  const deps = typeof t.dependsOn === 'string' ? [t.dependsOn] : strArray(t.dependsOn)
  for (const d of deps) steps.push(...planTask(d, ctx, depth + 1, seen))
  if (t.isBackground === true) {
    throw new Error(`Task “${task.label}” runs in the background (a watcher) — start it separately, then run.`)
  }
  const options = isRecord(t.options) ? t.options : {}
  const cwd = joinPath(ctx.workspace, expandVars(str(options.cwd) ?? ctx.workspace, ctx))
  const env = envRecord(options.env, ctx)
  const type = typeof t.type === 'string' ? t.type : 'process'
  const command = str(t.command) ? expandVars(t.command as string, ctx) : undefined
  const args = strArray(t.args).map((a) => expandVars(a, ctx))
  const step = (s: Omit<TaskStep, 'label' | 'cwd' | 'env'>): TaskStep => ({ label: task.label, cwd, env, ...s })
  // A task that only gathers others (`dependsOn` and nothing to run) contributes just those.
  if (deps.length && !command && type !== 'npm' && type !== 'typescript') return steps
  switch (type) {
    case 'shell':
      if (!command) throw new Error(`Task “${task.label}” has no command.`)
      steps.push(step({ shell: [command, ...args.map(shellSingleQuote)].join(' ') }))
      break
    case 'process':
    case 'dart':
    case 'flutter':
      // Dart-Code's tasks carry the tool as `command` ('dart' / 'flutter'), like a process task.
      steps.push(step({ argv: [command ?? type, ...args] }))
      break
    case 'npm': {
      const script = str(t.script)
      if (!script) throw new Error(`Task “${task.label}” has no npm script.`)
      const at = str(t.path) ? joinPath(ctx.workspace, expandVars(t.path as string, ctx)) : cwd
      steps.push({ label: task.label, cwd: at, env, argv: ['npm', 'run', script, ...args] })
      break
    }
    case 'typescript': {
      if (t.option === 'watch') throw new Error(`Task “${task.label}” is a tsc watch — start it separately, then run.`)
      steps.push(step({ argv: ['npx', 'tsc', '-p', expandVars(str(t.tsconfig) ?? 'tsconfig.json', ctx)] }))
      break
    }
    case 'cargo':
      steps.push(step({ argv: ['cargo', command ?? 'build', ...args] }))
      break
    default:
      throw new Error(`Task “${task.label}” is a “${type}” task, which is not supported yet.`)
  }
  return steps
}

/** Turn one launch configuration into what the host runs. Pure; every refusal is a sentence. */
export function planLaunch(cfg: LaunchConfig, ctx: PlanContext): PlanResult {
  const entry = describeConfig(cfg, ctx.isFlutterProject)
  if (!entry.supported) return { ok: false, error: entry.reason ?? 'Not supported.' }
  try {
    const raw = cfg.raw
    const x = (s: string) => expandVars(s, ctx)
    if (entry.browser) return { ok: true, plan: { kind: 'browser', name: cfg.name, url: x(str(raw.url) as string) } }

    const cwd = joinPath(ctx.workspace, x(str(raw.cwd) ?? ctx.workspace))
    const env = envRecord(raw.env ?? raw.environment, ctx)
    const envFile = str(raw.envFile) ? joinPath(ctx.workspace, x(raw.envFile as string)) : undefined
    const args = strArray(raw.args).map(x)
    const extra = ctx.extraArgs ? shellSplit(ctx.extraArgs) : []
    const preTasks = str(raw.preLaunchTask) ? planTask(x(raw.preLaunchTask as string), ctx) : []
    const proc = (argv: string[], hotReload = false): PlanResult => ({
      ok: true,
      plan: {
        kind: 'process',
        name: cfg.name,
        cwd,
        env,
        ...(envFile ? { envFile } : {}),
        argv,
        preTasks,
        hotReload
      }
    })

    switch (cfg.type) {
      case 'dart': {
        const program = str(raw.program) ? x(raw.program as string) : undefined
        const toolArgs = strArray(raw.toolArgs).map(x)
        const isTest = isDartTestProgram(program)
        if (entry.typeLabel === 'Flutter') {
          // Dart-Code passes a Flutter config's `args` to `flutter run` too (the legacy behavior a
          // config like `"args": ["--flavor", "dev"]` relies on), after `toolArgs`.
          // The device: the node's pick, or the one the configuration names — in its args (rewritten
          // in place) or as Dart-Code's `deviceId` field, which Dart-Code passes as `-d`.
          const web = (d: string) => (ctx.webServer ? webServerDevice(d) : d)
          let device: string[] = []
          if (!entry.pinnedDevice && entry.usesDevice && ctx.deviceId) device = ['-d', web(ctx.deviceId)]
          else if (entry.pinnedDevice && !pinnedInArgs(raw)) device = ['-d', web(entry.pinnedDevice)]
          if (ctx.webServer) {
            for (const list of [args, toolArgs]) {
              for (let i = 0; i < list.length; i++) {
                const t = list[i]
                if ((t === '-d' || t === '--device-id') && list[i + 1]) list[i + 1] = web(list[i + 1])
                else if (t.startsWith('-d=')) list[i] = `-d=${web(t.slice(3))}`
                else if (t.startsWith('--device-id=')) list[i] = `--device-id=${web(t.slice('--device-id='.length))}`
              }
            }
          }
          const mode = raw.flutterMode === 'profile' ? ['--profile'] : raw.flutterMode === 'release' ? ['--release'] : []
          if (isTest) return proc(['flutter', 'test', ...toolArgs, ...args, ...device, ...(program ? [program] : []), ...extra])
          return proc(
            [
              'flutter', 'run',
              ...(program ? ['-t', program] : []),
              ...toolArgs, ...args, ...mode, ...device,
              '--pid-file', ctx.flutterPidFile,
              ...extra
            ],
            true
          )
        }
        if (isTest) return proc(['dart', 'test', ...toolArgs, program as string, ...args, ...extra])
        return proc(['dart', 'run', ...toolArgs, program as string, ...args, ...extra])
      }
      case 'node':
      case 'pwa-node': {
        const runtime = str(raw.runtimeExecutable) ? x(raw.runtimeExecutable as string) : 'node'
        const runtimeArgs = strArray(raw.runtimeArgs).map(x)
        const program = str(raw.program) ? x(raw.program as string) : undefined
        if (!program && runtime === 'node' && runtimeArgs.length === 0) {
          return { ok: false, error: `“${cfg.name}” has neither a program nor a runtime command.` }
        }
        return proc([runtime, ...runtimeArgs, ...(program ? [program] : []), ...args, ...extra])
      }
      case 'node-terminal': {
        const command = str(raw.command)
        if (!command) return { ok: false, error: `“${cfg.name}” has no command.` }
        // A free-form command line the user wrote for a shell — it runs in one (sh -c), like VS Code.
        const line = [x(command), ...extra.map(shellSingleQuote)].join(' ')
        return { ok: true, plan: { kind: 'process', name: cfg.name, cwd, env, ...(envFile ? { envFile } : {}), shell: line, preTasks, hotReload: false } }
      }
      case 'python':
      case 'debugpy': {
        const python = str(raw.python) ? x(raw.python as string) : str(raw.pythonPath) ? x(raw.pythonPath as string) : ctx.pythonPath
        const pythonArgs = strArray(raw.pythonArgs).map(x)
        if (str(raw.module)) return proc([python, ...pythonArgs, '-m', x(raw.module as string), ...args, ...extra])
        if (str(raw.program)) return proc([python, ...pythonArgs, x(raw.program as string), ...args, ...extra])
        return { ok: false, error: `“${cfg.name}” has neither a program nor a module.` }
      }
      case 'go': {
        const program = str(raw.program) ? x(raw.program as string) : ctx.workspace
        const buildFlags = strArray(raw.buildFlags).map(x)
        if (raw.mode === 'test') return proc(['go', 'test', ...buildFlags, program, ...args, ...extra])
        if (raw.mode === 'exec') return proc([program, ...args, ...extra])
        return proc(['go', 'run', ...buildFlags, program, ...args, ...extra])
      }
      case 'php': {
        const runtime = str(raw.runtimeExecutable) ? x(raw.runtimeExecutable as string) : 'php'
        return proc([runtime, ...strArray(raw.runtimeArgs).map(x), x(raw.program as string), ...args, ...extra])
      }
      case 'coreclr': {
        const program = str(raw.program) ? x(raw.program as string) : undefined
        if (!program) return { ok: false, error: `“${cfg.name}” has no program.` }
        return proc(program.endsWith('.dll') ? ['dotnet', program, ...args, ...extra] : [program, ...args, ...extra])
      }
      case 'lldb':
      case 'cppdbg': {
        const program = str(raw.program) ? x(raw.program as string) : undefined
        if (!program) return { ok: false, error: `“${cfg.name}” has no program.` }
        return proc([program, ...args, ...extra])
      }
      default:
        return { ok: false, error: `“${cfg.type}” configurations are not supported yet.` }
    }
  } catch (e) {
    const msg = (e as Error).message
    return { ok: false, error: msg.startsWith('${') ? `${msg} needs VS Code to resolve — it cannot run here.` : msg }
  }
}

/** The plan for a Flutter checkout with no launch.json: `flutter run` on the chosen device. */
export function defaultFlutterConfig(): LaunchConfig {
  return { name: DEFAULT_FLUTTER_ENTRY, type: 'dart', request: 'launch', raw: { name: DEFAULT_FLUTTER_ENTRY, type: 'dart' } }
}

// ─── The launcher script ─────────────────────────────────────────────────────────────────────

/** Parse a dotenv file: `KEY=value`, `export KEY=value`, quotes, `#` comments. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/.exec(line)
    if (!m) continue
    let v = (m[2] ?? '').trim()
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      const dq = v.startsWith('"')
      v = v.slice(1, -1)
      if (dq) v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    } else {
      v = v.replace(/\s+#.*$/, '')
    }
    out[m[1]] = v
  }
  return out
}

export interface LauncherPaths {
  /** Written with the launcher's own pid while it runs; removed when it ends. */
  pidFile: string
  /** Written with the exit status when the run ends. */
  exitFile: string
}

function exports(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `export ${k}=${shellSingleQuote(v)}`)
}

function cmdLine(argv: string[] | undefined, shell: string | undefined): string {
  return argv ? argv.map(shellSingleQuote).join(' ') : `sh -c ${shellSingleQuote(shell ?? '')}`
}

/** What the launcher prints before it runs, so the terminal says what it is doing. Env values are
 *  never printed (an envFile is often where the secrets live). */
export function displayCommand(plan: ProcessPlan): string {
  return plan.argv ? plan.argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : shellSingleQuote(a))).join(' ') : (plan.shell ?? '')
}

/**
 * The POSIX sh launcher the node's terminal runs (`sh '<path>'`). Every value is single-quoted.
 *
 * - It records its own pid (the run's status), and its exit status when the run ends.
 * - It traps INT/TERM with a no-op HANDLER (never `''`, which children would inherit as "ignore"):
 *   Ctrl+C / Stop interrupts the program, and the launcher survives to record the status.
 * - preLaunchTask steps run first, each in a subshell with its own cwd/env; a failing task stops
 *   the run, like VS Code.
 */
export function buildLauncher(plan: ProcessPlan, envFileVars: Record<string, string>, paths: LauncherPaths): string {
  const q = shellSingleQuote
  const lines: string[] = [
    '#!/bin/sh',
    `# nodeterm run configuration: ${plan.name.replace(/[\r\n]/g, ' ')}`,
    `echo $$ > ${q(paths.pidFile)}`,
    `rm -f ${q(paths.exitFile)}`,
    "trap ':' INT TERM",
    `nt_end() { rm -f ${q(paths.pidFile)}; echo "$1" > ${q(paths.exitFile)}; exit "$1"; }`
  ]
  for (const t of plan.preTasks) {
    lines.push(
      `printf '\\033[2m▶ task: %s\\033[0m\\n' ${q(t.label)}`,
      `( cd ${q(t.cwd)} || exit 1`,
      ...exports(t.env).map((l) => `  ${l}`),
      `  ${cmdLine(t.argv, t.shell)}`,
      ')',
      'nt_rc=$?',
      `if [ "$nt_rc" -ne 0 ]; then printf '\\033[31mTask %s failed (exit %s).\\033[0m\\n' ${q(t.label)} "$nt_rc"; nt_end "$nt_rc"; fi`
    )
  }
  lines.push(
    `cd ${q(plan.cwd)} || nt_end 1`,
    ...exports({ ...envFileVars, ...plan.env }),
    `printf '\\033[2m▶ %s\\033[0m\\n' ${q(displayCommand(plan))}`,
    cmdLine(plan.argv, plan.shell),
    'nt_end $?'
  )
  return lines.join('\n') + '\n'
}

// ─── Presentation ────────────────────────────────────────────────────────────────────────────

/** Last path segment, for titles and the folder picker. */
export function runDirLabel(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/)
  const last = parts[parts.length - 1] || dir
  const parent = parts[parts.length - 2]
  return parent && parent.endsWith('.worktrees') ? `${parent.replace(/\.worktrees$/, '')} · ${last}` : last
}

/** The node title while it is still ours to set (`titleAuto`). */
export function runNodeTitle(dir: string, configName?: string): string {
  return configName ? `${configName} · ${runDirLabel(dir)}` : `Run · ${runDirLabel(dir)}`
}

/** Which other run nodes already use `deviceId` — for the "already in use" warning. */
export function deviceClaims(
  nodes: ReadonlyArray<{ id: string; title?: string; runConfig?: Pick<RunNodeConfig, 'deviceId'> }>,
  selfId: string,
  deviceId: string | undefined
): string[] {
  if (!deviceId) return []
  return nodes.filter((n) => n.id !== selfId && n.runConfig?.deviceId === deviceId).map((n) => n.title || n.id)
}

// ─── Host API ────────────────────────────────────────────────────────────────────────────────

export type RunDeviceKind = 'simulator' | 'emulator' | 'device' | 'desktop' | 'web'

export interface RunDevice {
  id: string
  name: string
  kind: RunDeviceKind
  /** iOS simulators only. */
  state?: 'booted' | 'shutdown'
  /** "iOS 27.1" for a simulator, the target platform otherwise. */
  platform?: string
}

export interface RunDevicesResult {
  devices: RunDevice[]
  error?: string
}

export interface RunEntriesResult {
  /** Whether the folder has a readable `.vscode/launch.json`. */
  found: boolean
  entries: LaunchEntry[]
  /** Set when launch.json exists but could not be parsed. */
  error?: string
  isFlutterProject: boolean
}

export type RunStartResult =
  | { ok: true; kind: 'process'; command: string; hotReload: boolean }
  | { ok: true; kind: 'browser'; url: string }
  | { ok: true; kind: 'compound'; members: string[] }
  | { ok: false; error: string }

export interface RunStatus {
  running: boolean
  /** The last run's exit status, when it ended (null while running / unknown). */
  exitCode: number | null
}

export interface RunConfigApi {
  /** The configurations (and compounds) in `<dir>/.vscode/launch.json`, described. */
  entries(dir: string): Promise<RunEntriesResult>
  /** iOS simulators plus `flutter devices`. `refresh` bypasses the short cache. */
  devices(refresh?: boolean): Promise<RunDevicesResult>
  /** Boot an iOS simulator (no-op when already booted) and open Simulator.app. */
  bootDevice(udid: string): Promise<boolean>
  /** Folders near `dir` that have a launch.json or are Flutter checkouts. */
  discoverProjects(dir: string): Promise<string[]>
  /** Prepare a run: write the launcher and return the line to type (or a URL / compound members). */
  start(nodeId: string, config: RunNodeConfig): Promise<RunStartResult>
  status(nodeId: string): Promise<RunStatus>
  /** Interrupt the run (SIGINT, or SIGTERM when `force`). False when nothing is running. */
  stop(nodeId: string, force?: boolean): Promise<boolean>
  /** Flutter: hot reload (SIGUSR1) / hot restart (SIGUSR2). */
  signal(nodeId: string, kind: 'reload' | 'restart'): Promise<boolean>
  /** Flutter: start (dir) or stop (null) reload-on-save. */
  watch(nodeId: string, dir: string | null): Promise<void>
}
