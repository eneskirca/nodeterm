import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import {
  discoverProjects,
  flutterPidFile,
  launcherPath,
  listEntries,
  runStatus,
  setWatch,
  signalRun,
  startRun,
  stopAllRunWatches,
  stopRun
} from './run-service'

const PUBSPEC = 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n'
const NODE = process.execPath
const posix = process.platform !== 'win32'

let root: string
let children: ChildProcess[] = []

function write(rel: string, text: string): string {
  const p = path.join(root, rel)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, text)
  return p
}

async function until(fn: () => boolean | Promise<boolean>, ms = 6000): Promise<void> {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 40))
  }
}

/** Run the launcher the way the node's shell would: its own job (process group), like `sh x` typed
 *  at an interactive prompt. */
function runLauncher(nodeId: string): ChildProcess {
  const child = spawn('/bin/sh', [launcherPath(nodeId)], { detached: true, stdio: 'ignore' })
  children.push(child)
  return child
}

describe('run-service', () => {
  beforeEach(() => {
    initPlatform(fakePlatform())
    root = mkdtempSync(path.join(os.tmpdir(), 'nt-run-'))
  })
  afterEach(() => {
    stopAllRunWatches()
    for (const c of children) {
      try {
        process.kill(-(c.pid as number), 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    children = []
    rmSync(root, { recursive: true, force: true })
    resetPlatformForTests()
  })

  it('lists described entries, and offers plain flutter run to a Flutter checkout with no launch.json', async () => {
    const api = path.join(root, 'api')
    write('api/.vscode/launch.json', `{ "configurations": [
      { "name": "API", "type": "node", "request": "launch", "program": "a.js" },
      { "name": "Attach", "type": "node", "request": "attach" },
    ], "compounds": [ { "name": "All", "configurations": ["API"] } ] }`)
    const r = await listEntries(api)
    expect(r.found).toBe(true)
    expect(r.entries.map((e) => [e.name, e.kind, e.supported])).toEqual([
      ['API', 'config', true],
      ['Attach', 'config', false],
      ['All', 'compound', true]
    ])

    write('app/pubspec.yaml', PUBSPEC)
    const flutter = await listEntries(path.join(root, 'app'))
    expect(flutter).toMatchObject({ found: false, isFlutterProject: true })
    expect(flutter.entries.map((e) => e.typeLabel)).toEqual(['Flutter'])

    write('broken/.vscode/launch.json', '{ nope')
    expect((await listEntries(path.join(root, 'broken'))).error).toMatch(/Could not parse/)
  })

  it('finds runnable folders beside the project, worktrees included', async () => {
    write('api/.vscode/launch.json', '{}')
    write('doc-flutter/pubspec.yaml', PUBSPEC)
    write('doc-flutter.worktrees/feature/pubspec.yaml', PUBSPEC)
    write('notes/readme.md', 'x')
    const found = await discoverProjects(path.join(root, 'notes'))
    expect(found.map((d) => path.relative(root, d))).toEqual([
      'api',
      'doc-flutter',
      path.join('doc-flutter.worktrees', 'feature')
    ])
  })

  it('refuses with a sentence: no folder, no config, unsupported config; answers compounds and urls', async () => {
    write('w/.vscode/launch.json', `{ "configurations": [
      { "name": "Attach", "type": "node", "request": "attach" },
      { "name": "Web", "type": "chrome", "request": "launch", "url": "http://localhost:3000" },
    ], "compounds": [ { "name": "Both", "configurations": ["Web", "Attach"] } ] }`)
    const w = path.join(root, 'w')
    expect(await startRun('n1', { projectDir: path.join(root, 'gone'), reloadOnSave: true })).toMatchObject({ ok: false })
    expect(await startRun('n1', { projectDir: w, launchConfig: 'Nope', reloadOnSave: true })).toEqual({
      ok: false,
      error: '“Nope” is not in .vscode/launch.json.'
    })
    expect(await startRun('n1', { projectDir: w, launchConfig: 'Attach', reloadOnSave: true })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/attaches/)
    })
    expect(await startRun('n1', { projectDir: w, launchConfig: 'Web', reloadOnSave: true })).toEqual({
      ok: true,
      kind: 'browser',
      url: 'http://localhost:3000'
    })
    expect(await startRun('n1', { projectDir: w, launchConfig: 'Both', reloadOnSave: true })).toEqual({
      ok: true,
      kind: 'compound',
      members: ['Web', 'Attach']
    })
    expect(await startRun('../x', { projectDir: w, reloadOnSave: true })).toMatchObject({ ok: false })
  })

  it.skipIf(!posix)('runs the preLaunchTask, then the program with env + envFile, and records the exit code', async () => {
    const w = path.join(root, 'w')
    const out = path.join(root, 'out.txt')
    // Fixture scripts are FIXED source: anything run-specific (paths) reaches them as env, never
    // spliced into the code.
    write(
      'w/app.js',
      "require('fs').writeFileSync(process.env.OUT, [process.env.FROM_CFG, process.env.FROM_FILE, process.env.SHARED, process.cwd(), process.argv.slice(2).join(',')].join('|')); process.exit(3)"
    )
    write('w/.env', 'FROM_FILE=file-value\nSHARED=from-file\n')
    write('w/.vscode/tasks.json', `{ "tasks": [ { "label": "prep", "type": "shell", "command": "echo prepped > prep.txt" } ] }`)
    write('w/.vscode/launch.json', `{ "configurations": [ {
      "name": "API", "type": "node", "request": "launch",
      "runtimeExecutable": ${JSON.stringify(NODE)},
      "program": "\${workspaceFolder}/app.js", "args": ["a", "b c"],
      "env": { "FROM_CFG": "cfg-value", "SHARED": "from-config", "OUT": ${JSON.stringify(out)} },
      "envFile": "\${workspaceFolder}/.env",
      "preLaunchTask": "prep"
    } ] }`)
    const r = await startRun('n2', { projectDir: w, launchConfig: 'API', reloadOnSave: true, extraArgs: '--extra' })
    expect(r).toMatchObject({ ok: true, kind: 'process', hotReload: false })
    if (!r.ok || r.kind !== 'process') return
    expect(r.command).toBe(`sh '${launcherPath('n2')}'`)
    // Owner-only: the launcher can carry an envFile's secrets.
    expect(statSync(launcherPath('n2')).mode & 0o077).toBe(0)

    runLauncher('n2')
    await until(async () => (await runStatus('n2')).exitCode !== null)
    expect(await runStatus('n2')).toEqual({ running: false, exitCode: 3 })
    expect(readFileSync(path.join(w, 'prep.txt'), 'utf8').trim()).toBe('prepped')
    expect(readFileSync(out, 'utf8')).toBe(`cfg-value|file-value|from-config|${w}|a,b c,--extra`)
  })

  it.skipIf(!posix)('a failing preLaunchTask stops the run with its status', async () => {
    const w = path.join(root, 'w')
    write('w/.vscode/tasks.json', `{ "tasks": [ { "label": "fail", "type": "shell", "command": "exit 7" } ] }`)
    write('w/.vscode/launch.json', `{ "configurations": [ { "name": "X", "type": "node", "request": "launch",
      "runtimeExecutable": ${JSON.stringify(NODE)}, "program": "nope.js", "preLaunchTask": "fail" } ] }`)
    expect((await startRun('n3', { projectDir: w, launchConfig: 'X', reloadOnSave: true })).ok).toBe(true)
    runLauncher('n3')
    await until(async () => (await runStatus('n3')).exitCode !== null)
    expect(await runStatus('n3')).toEqual({ running: false, exitCode: 7 })
  })

  it.skipIf(!posix)('reports a live run, and Stop interrupts it like Ctrl+C', async () => {
    const w = path.join(root, 'w')
    const marker = path.join(root, 'got-int')
    const ready = path.join(root, 'ready')
    write(
      'w/serve.js',
      "const fs = require('fs'); process.on('SIGINT', () => { fs.writeFileSync(process.env.MARKER, 'x'); process.exit(130) }); fs.writeFileSync(process.env.READY, 'x'); setInterval(() => {}, 1000)"
    )
    write('w/.vscode/launch.json', JSON.stringify({
      configurations: [
        { name: 'S', type: 'node', request: 'launch', runtimeExecutable: NODE, program: 'serve.js', env: { MARKER: marker, READY: ready } }
      ]
    }))
    await startRun('n4', { projectDir: w, launchConfig: 'S', reloadOnSave: true })
    runLauncher('n4')
    await until(async () => (await runStatus('n4')).running)
    // The launcher is live before the program has installed its handler; wait for the program.
    await until(() => existsSync(ready))
    expect(await stopRun('n4')).toBe(true)
    await until(async () => !(await runStatus('n4')).running)
    expect(existsSync(marker)).toBe(true)
    expect((await runStatus('n4')).exitCode).toBe(130)
    expect(await stopRun('n4')).toBe(false)
  })

  it.skipIf(!posix)('hot reload / restart signal only a live flutter process', async () => {
    let out = ''
    const fake = spawn(
      NODE,
      ['-e', "process.on('SIGUSR1',()=>console.log('RELOAD'));process.on('SIGUSR2',()=>console.log('RESTART'));console.log('UP');setInterval(()=>{},1000)", 'flutter_tools.snapshot'],
      { stdio: ['ignore', 'pipe', 'ignore'], detached: true }
    )
    children.push(fake)
    fake.stdout!.on('data', (d) => (out += String(d)))
    await until(() => out.includes('UP'))
    mkdirSync(path.dirname(flutterPidFile('n5')), { recursive: true })
    writeFileSync(flutterPidFile('n5'), String(fake.pid))
    expect(await signalRun('n5', 'reload')).toBe(true)
    await until(() => out.includes('RELOAD'))
    expect(await signalRun('n5', 'restart')).toBe(true)
    await until(() => out.includes('RESTART'))

    // A pid file naming a process that is not flutter (this test runner) is never signalled.
    writeFileSync(flutterPidFile('n6'), String(process.pid))
    expect(await signalRun('n6', 'reload')).toBe(false)
  })

  it.skipIf(!posix)('reload on save: one hot reload per burst of .dart changes under lib/', async () => {
    write('app/lib/main.dart', 'void main() {}')
    let out = ''
    const fake = spawn(NODE, ['-e', "process.on('SIGUSR1',()=>console.log('RELOAD'));console.log('UP');setInterval(()=>{},1000)", 'flutter_tools.snapshot'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true
    })
    children.push(fake)
    fake.stdout!.on('data', (d) => (out += String(d)))
    await until(() => out.includes('UP'))
    mkdirSync(path.dirname(flutterPidFile('n7')), { recursive: true })
    writeFileSync(flutterPidFile('n7'), String(fake.pid))
    setWatch('n7', path.join(root, 'app'))
    await new Promise((r) => setTimeout(r, 150))
    write('app/lib/notes.txt', 'ignored')
    write('app/lib/a.dart', 'void a() {}')
    write('app/lib/b.dart', 'void b() {}')
    await until(() => out.includes('RELOAD'))
    await new Promise((r) => setTimeout(r, 600))
    expect(out.match(/RELOAD/g)).toHaveLength(1)
    setWatch('n7', null)
    write('app/lib/c.dart', 'void c() {}')
    await new Promise((r) => setTimeout(r, 700))
    expect(out.match(/RELOAD/g)).toHaveLength(1)
  })
})
