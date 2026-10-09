import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FLUTTER_ENTRY,
  buildLauncher,
  defaultFlutterConfig,
  describeConfig,
  describeLaunchFile,
  deviceClaims,
  normalizeRunConfig,
  parseEnvFile,
  parseJsonc,
  parseLaunchFile,
  parseTasksFile,
  planLaunch,
  planTask,
  resolveEntry,
  runDirLabel,
  runNodeTitle,
  type LaunchConfig,
  type PlanContext,
  type ProcessPlan
} from './run-config'

const WS = '/Users/me/dev/app'

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  workspace: WS,
  home: '/Users/me',
  env: { API_URL: 'http://localhost:8081' },
  isFlutterProject: false,
  pythonPath: 'python3',
  flutterPidFile: '/data/run/n.flutter.pid',
  tasks: [],
  ...over
})

const cfg = (raw: Record<string, unknown>): LaunchConfig => ({
  name: String(raw.name ?? 'cfg'),
  type: String(raw.type),
  request: String(raw.request ?? 'launch'),
  raw: { name: 'cfg', request: 'launch', ...raw }
})

function proc(raw: Record<string, unknown>, c: Partial<PlanContext> = {}): ProcessPlan {
  const r = planLaunch(cfg(raw), ctx(c))
  if (!r.ok) throw new Error(r.error)
  if (r.plan.kind !== 'process') throw new Error('not a process plan')
  return r.plan
}

function refusal(raw: Record<string, unknown>, c: Partial<PlanContext> = {}): string {
  const r = planLaunch(cfg(raw), ctx(c))
  if (r.ok) throw new Error('expected a refusal')
  return r.error
}

describe('parsing', () => {
  it('reads JSONC (comments, trailing commas) without touching strings', () => {
    expect(parseJsonc('{"a": "http://x//y", "b": "/* no */", "c": ",]", // c\n}')).toEqual({
      a: 'http://x//y',
      b: '/* no */',
      c: ',]'
    })
  })

  it('reads configurations of every type, compounds, and the OS block', () => {
    const file = parseLaunchFile(
      `{
        "configurations": [
          { "name": "App", "type": "dart", "request": "launch", "program": "lib/main.dart", "args": ["--flavor", "dev",], },
          { "name": "API", "type": "node", "request": "launch", "program": "server.js", "osx": { "args": ["--mac"] } },
          // nameless: dropped
          { "type": "python" },
        ],
        "compounds": [ { "name": "Both", "configurations": ["App", "API"] } ]
      }`,
      'osx'
    )
    expect(file.configs.map((c) => [c.name, c.type])).toEqual([
      ['App', 'dart'],
      ['API', 'node']
    ])
    expect(file.configs[1].raw.args).toEqual(['--mac'])
    expect(file.compounds).toEqual([{ name: 'Both', configurations: ['App', 'API'] }])
  })

  it('reads tasks by label, deriving npm labels like VS Code', () => {
    const tasks = parseTasksFile(
      '{ "tasks": [ { "label": "build", "type": "shell", "command": "make" }, { "type": "npm", "script": "lint" } ] }'
    )
    expect(tasks.map((t) => t.label)).toEqual(['build', 'npm: lint'])
  })
})

describe('describeConfig', () => {
  it('refuses attach, unknown types and editor-only variables, with the reason', () => {
    expect(describeConfig(cfg({ type: 'node', request: 'attach', port: 9229 }), false)).toMatchObject({
      supported: false,
      reason: expect.stringMatching(/attaches/)
    })
    expect(describeConfig(cfg({ type: 'java', mainClass: 'App' }), false)).toMatchObject({
      supported: false,
      reason: '“java” configurations are not supported yet.'
    })
    expect(describeConfig(cfg({ type: 'python', program: '${file}' }), false)).toMatchObject({
      supported: false,
      reason: '${file} needs VS Code to resolve — it cannot run here.'
    })
    expect(describeConfig(cfg({ type: 'php', port: 9003 }), false)).toMatchObject({
      supported: false,
      reason: expect.stringMatching(/Xdebug/)
    })
  })

  it('lets the Python interpreter command through — we can answer that one', () => {
    expect(describeConfig(cfg({ type: 'python', program: 'a.py', python: '${command:python.interpreterPath}' }), false).supported).toBe(true)
  })

  it('knows a Flutter run (device + hot reload) from a Flutter test', () => {
    expect(describeConfig(cfg({ type: 'dart', program: 'lib/main.dart' }), true)).toMatchObject({
      typeLabel: 'Flutter', usesDevice: true, hotReload: true
    })
    expect(describeConfig(cfg({ type: 'dart', program: 'integration_test/auth_test.dart' }), true)).toMatchObject({
      usesDevice: true, hotReload: false
    })
    expect(describeConfig(cfg({ type: 'dart', program: 'test/widget_test.dart' }), true)).toMatchObject({
      usesDevice: false, hotReload: false
    })
    expect(describeConfig(cfg({ type: 'dart', program: 'lib/main.dart', args: ['-d', 'chrome'] }), true).pinnedDevice).toBe('chrome')
  })

  it('marks a compound that names a missing configuration', () => {
    const entries = describeLaunchFile(
      { configs: [cfg({ name: 'A', type: 'node', program: 'a.js' })], compounds: [{ name: 'AB', configurations: ['A', 'B'] }] },
      false
    )
    expect(entries[1]).toMatchObject({ kind: 'compound', supported: false, reason: expect.stringMatching(/: B\.$/) })
  })
})

describe('resolveEntry', () => {
  const entries = describeLaunchFile(
    {
      configs: [
        cfg({ name: 'Web', type: 'dart', program: 'lib/main.dart', args: ['-d', 'chrome'] }),
        cfg({ name: 'Device', type: 'dart', program: 'lib/main.dart' }),
        cfg({ name: 'Attach', type: 'dart', request: 'attach' })
      ],
      compounds: []
    },
    true
  )
  it('prefers the named entry, else the first that leaves the device to the picker', () => {
    expect(resolveEntry(entries, 'Web')?.name).toBe('Web')
    expect(resolveEntry(entries, undefined)?.name).toBe('Device')
    expect(resolveEntry(entries, 'Gone')?.name).toBe('Device')
  })
})

describe('planLaunch — one row per type', () => {
  it('dart (Flutter): flutter run with target, args, mode, device, pid file and extra args', () => {
    const p = proc(
      { type: 'dart', program: 'lib/main_dev.dart', args: ['--flavor', 'dev'], flutterMode: 'profile' },
      { isFlutterProject: true, deviceId: 'SIM-1', extraArgs: '--dart-define=A=1' }
    )
    expect(p.argv).toEqual([
      'flutter', 'run', '-t', 'lib/main_dev.dart', '--flavor', 'dev', '--profile', '-d', 'SIM-1',
      '--pid-file', '/data/run/n.flutter.pid', '--dart-define=A=1'
    ])
    expect(p.hotReload).toBe(true)
  })

  it('dart (Flutter): a configuration that pins its device wins over the picker', () => {
    const p = proc({ type: 'dart', program: 'lib/main.dart', args: ['-d', 'chrome'] }, { isFlutterProject: true, deviceId: 'SIM-1' })
    expect(p.argv).not.toContain('SIM-1')
  })

  it('dart (Flutter): a Chrome device runs on the web server, wherever the device is named', () => {
    const web = { isFlutterProject: true, webServer: true }
    // picked
    expect(proc({ type: 'dart', program: 'lib/main.dart' }, { ...web, deviceId: 'chrome' }).argv).toEqual([
      'flutter', 'run', '-t', 'lib/main.dart', '-d', 'web-server', '--pid-file', '/data/run/n.flutter.pid'
    ])
    // pinned in args, every spelling
    expect(proc({ type: 'dart', program: 'lib/main.dart', args: ['-d', 'chrome'] }, web).argv).toContain('web-server')
    expect(proc({ type: 'dart', program: 'lib/main.dart', args: ['-d=edge'] }, web).argv).toContain('-d=web-server')
    expect(proc({ type: 'dart', program: 'lib/main.dart', toolArgs: ['--device-id', 'chrome'] }, web).argv).not.toContain('chrome')
    // pinned as Dart-Code's deviceId field: passed as -d at all (it used to be dropped), swapped
    expect(proc({ type: 'dart', program: 'lib/main.dart', deviceId: 'chrome' }, web).argv).toEqual([
      'flutter', 'run', '-t', 'lib/main.dart', '-d', 'web-server', '--pid-file', '/data/run/n.flutter.pid'
    ])
    // phones and desktops are untouched
    expect(proc({ type: 'dart', program: 'lib/main.dart' }, { ...web, deviceId: 'SIM-1' }).argv).toContain('SIM-1')
  })

  it('dart (Flutter): with the panel off, Chrome stays Chrome — and a deviceId field is still passed', () => {
    expect(proc({ type: 'dart', program: 'lib/main.dart' }, { isFlutterProject: true, deviceId: 'chrome' }).argv).toContain('chrome')
    expect(proc({ type: 'dart', program: 'lib/main.dart', deviceId: 'macos' }, { isFlutterProject: true }).argv).toEqual([
      'flutter', 'run', '-t', 'lib/main.dart', '-d', 'macos', '--pid-file', '/data/run/n.flutter.pid'
    ])
  })

  it('dart (Flutter): integration tests run with flutter test on the device', () => {
    const p = proc({ type: 'dart', program: 'integration_test/auth_test.dart' }, { isFlutterProject: true, deviceId: 'SIM-1' })
    expect(p.argv).toEqual(['flutter', 'test', '-d', 'SIM-1', 'integration_test/auth_test.dart'])
    expect(p.hotReload).toBe(false)
  })

  it('dart (no launch.json): plain flutter run', () => {
    const r = planLaunch(defaultFlutterConfig(), ctx({ isFlutterProject: true, deviceId: 'macos' }))
    expect(r.ok && r.plan.kind === 'process' && r.plan.argv).toEqual(['flutter', 'run', '-d', 'macos', '--pid-file', '/data/run/n.flutter.pid'])
    expect(DEFAULT_FLUTTER_ENTRY).toMatch(/flutter run/)
  })

  it('dart (plain): dart run / dart test', () => {
    expect(proc({ type: 'dart', program: 'bin/cli.dart', args: ['x'] }).argv).toEqual(['dart', 'run', 'bin/cli.dart', 'x'])
    expect(proc({ type: 'dart', program: 'test/a_test.dart' }).argv).toEqual(['dart', 'test', 'test/a_test.dart'])
  })

  it('node: program with runtime args, env and envFile; ${env:} resolved', () => {
    const p = proc({
      type: 'node',
      program: '${workspaceFolder}/server.js',
      runtimeArgs: ['--inspect=0'],
      args: '--port 3000',
      cwd: '${workspaceFolder}/api',
      env: { API: '${env:API_URL}', N: 3 },
      envFile: '${workspaceFolder}/.env'
    })
    expect(p.argv).toEqual(['node', '--inspect=0', `${WS}/server.js`, '--port', '3000'])
    expect(p.cwd).toBe(`${WS}/api`)
    expect(p.env).toEqual({ API: 'http://localhost:8081', N: '3' })
    expect(p.envFile).toBe(`${WS}/.env`)
  })

  it('node: npm-style runtimeExecutable with no program', () => {
    expect(proc({ type: 'pwa-node', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'] }).argv).toEqual(['npm', 'run', 'dev'])
    expect(refusal({ type: 'node' })).toMatch(/neither a program nor a runtime/)
  })

  it('node-terminal: its command runs in a shell, like VS Code', () => {
    expect(proc({ type: 'node-terminal', command: 'npm run dev -- --open' }).shell).toBe('npm run dev -- --open')
  })

  it('python / debugpy: program, module, interpreter override and workspace venv', () => {
    expect(proc({ type: 'python', program: 'main.py', args: ['-v'] }, { pythonPath: `${WS}/.venv/bin/python` }).argv).toEqual([
      `${WS}/.venv/bin/python`, 'main.py', '-v'
    ])
    expect(proc({ type: 'debugpy', module: 'flask', args: ['run'], python: '/usr/bin/python3' }).argv).toEqual([
      '/usr/bin/python3', '-m', 'flask', 'run'
    ])
    expect(proc({ type: 'python', program: 'a.py', python: '${command:python.interpreterPath}' }, { pythonPath: '/venv/python' }).argv?.[0]).toBe('/venv/python')
  })

  it('go: run / test / exec', () => {
    expect(proc({ type: 'go', program: '${workspaceFolder}/cmd/api', buildFlags: '-tags dev' }).argv).toEqual([
      'go', 'run', '-tags', 'dev', `${WS}/cmd/api`
    ])
    expect(proc({ type: 'go', mode: 'test', program: './pkg' }).argv).toEqual(['go', 'test', './pkg'])
    expect(proc({ type: 'go', mode: 'exec', program: './bin/api' }).argv).toEqual(['./bin/api'])
  })

  it('php, coreclr, lldb, cppdbg', () => {
    expect(proc({ type: 'php', program: 'bin/console', args: ['app:sync'] }).argv).toEqual(['php', 'bin/console', 'app:sync'])
    expect(proc({ type: 'coreclr', program: 'bin/Debug/App.dll' }).argv).toEqual(['dotnet', 'bin/Debug/App.dll'])
    expect(proc({ type: 'lldb', program: './build/app', args: ['--x'] }).argv).toEqual(['./build/app', '--x'])
    expect(proc({ type: 'cppdbg', program: './a.out', environment: [{ name: 'K', value: 'v' }] }).env).toEqual({ K: 'v' })
  })

  it('chrome / msedge: open the url in a browser node', () => {
    const r = planLaunch(cfg({ type: 'chrome', url: 'http://localhost:${env:PORT}' }), ctx({ env: { PORT: '5173' } }))
    expect(r).toEqual({ ok: true, plan: { kind: 'browser', name: 'cfg', url: 'http://localhost:5173' } })
  })
})

describe('preLaunchTask', () => {
  const tasks = parseTasksFile(`{
    "tasks": [
      { "label": "codegen", "type": "dart", "command": "dart", "args": ["run", "build_runner", "build"] },
      { "label": "deps", "type": "shell", "command": "npm ci", "options": { "cwd": "\${workspaceFolder}/web", "env": { "CI": "1" } } },
      { "label": "all", "dependsOn": ["deps", "codegen"] },
      { "label": "lint", "type": "npm", "script": "lint" },
      { "label": "watch", "type": "shell", "command": "tsc -w", "isBackground": true },
      { "label": "loop", "type": "shell", "command": "x", "dependsOn": "loop" },
      { "label": "default", "type": "process", "command": "make", "group": { "kind": "build", "isDefault": true } },
      { "label": "gulp", "type": "gulp", "task": "x" }
    ]
  }`)
  const c = ctx({ tasks })

  it('runs Dart-Code tasks as their own command, shell tasks via sh, npm via npm run', () => {
    expect(planTask('codegen', c)).toEqual([{ label: 'codegen', cwd: WS, env: {}, argv: ['dart', 'run', 'build_runner', 'build'] }])
    expect(planTask('deps', c)).toEqual([{ label: 'deps', cwd: `${WS}/web`, env: { CI: '1' }, shell: 'npm ci' }])
    expect(planTask('lint', c)).toEqual([{ label: 'lint', cwd: WS, env: {}, argv: ['npm', 'run', 'lint'] }])
  })

  it('runs dependsOn first, in order', () => {
    expect(planTask('all', c).map((s) => s.label)).toEqual(['deps', 'codegen'])
  })

  it('resolves ${defaultBuildTask}', () => {
    expect(planTask('${defaultBuildTask}', c)[0].argv).toEqual(['make'])
  })

  it('refuses background, unknown, missing and self-dependent tasks with a reason', () => {
    expect(() => planTask('watch', c)).toThrow(/background/)
    expect(() => planTask('gulp', c)).toThrow(/“gulp” task/)
    expect(() => planTask('nope', c)).toThrow(/not in .vscode\/tasks.json/)
    expect(() => planTask('loop', c)).toThrow(/depends on itself/)
  })

  it('a configuration carries its preLaunchTask steps', () => {
    expect(proc({ type: 'node', program: 'a.js', preLaunchTask: 'all' }, { tasks }).preTasks).toHaveLength(2)
    expect(refusal({ type: 'node', program: 'a.js', preLaunchTask: 'watch' }, { tasks })).toMatch(/background/)
  })
})

describe('buildLauncher', () => {
  const paths = { pidFile: '/d/n.pid', exitFile: '/d/n.exit' }

  it('quotes every value, so no field can become a second shell command', () => {
    const p = proc({
      type: 'node',
      program: "x'; rm -rf ~; echo '",
      args: ['$(id)', '`id`', '&&', 'reboot'],
      cwd: '/tmp/$(id)',
      env: { EVIL: "'; touch /tmp/pwn; '" }
    })
    const script = buildLauncher(p, { FROM_FILE: '$HOME' }, paths)
    expect(script).toContain(`'node' 'x'\\''; rm -rf ~; echo '\\''' '$(id)' '\`id\`' '&&' 'reboot'`)
    expect(script).toContain(`cd '/tmp/$(id)' || nt_end 1`)
    expect(script).toContain(`export EVIL=''\\''; touch /tmp/pwn; '\\'''`)
    expect(script).toContain(`export FROM_FILE='$HOME'`)
  })

  it('records pid and exit status, and traps INT with a handler (never ignore)', () => {
    const script = buildLauncher(proc({ type: 'node', program: 'a.js' }), {}, paths)
    expect(script).toContain(`echo $$ > '/d/n.pid'`)
    expect(script).toContain(`trap ':' INT TERM`)
    expect(script).not.toContain(`trap '' INT`)
    expect(script.trimEnd().endsWith('nt_end $?')).toBe(true)
  })

  it('lets the config env win over the envFile', () => {
    const script = buildLauncher(proc({ type: 'node', program: 'a.js', env: { K: 'config' } }), { K: 'file' }, paths)
    expect(script).toContain("export K='config'")
    expect(script).not.toContain("export K='file'")
  })
})

describe('parseEnvFile', () => {
  it('reads dotenv lines', () => {
    expect(parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'x # y\'\nD=raw # comment\nbad line\n')).toEqual({
      A: '1',
      B: 'two words',
      C: 'x # y',
      D: 'raw'
    })
  })
})

describe('normalizeRunConfig', () => {
  it('round-trips a valid config', () => {
    expect(normalizeRunConfig({ projectDir: '/a', launchConfig: 'Dev', deviceId: 'macos', deviceName: 'macOS', showTerminal: true })).toEqual({
      projectDir: '/a', launchConfig: 'Dev', deviceId: 'macos', deviceName: 'macOS', showTerminal: true, reloadOnSave: true
    })
  })
  it('drops hostile fields and non-absolute folders', () => {
    expect(normalizeRunConfig({ projectDir: 'rel' })).toBeUndefined()
    expect(normalizeRunConfig({ projectDir: '/a', deviceId: 'x; rm -rf ~', extraArgs: 'a\nb' })).toEqual({ projectDir: '/a', reloadOnSave: true })
  })
})

describe('presentation', () => {
  it('titles a node by configuration and folder', () => {
    expect(runNodeTitle('/dev/doc-flutter', 'Current device LOCAL DEV')).toBe('Current device LOCAL DEV · doc-flutter')
    expect(runNodeTitle('/dev/x')).toBe('Run · x')
    expect(runDirLabel('/dev/doc-flutter.worktrees/family/')).toBe('doc-flutter · family')
  })
  it('names the other nodes on the same device, never itself', () => {
    const nodes = [
      { id: 'a', title: 'A', runConfig: { deviceId: 'sim1' } },
      { id: 'b', title: 'B', runConfig: { deviceId: 'sim1' } }
    ]
    expect(deviceClaims(nodes, 'a', 'sim1')).toEqual(['B'])
  })
})
