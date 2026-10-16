// Issue #829 step 3. Pure staging/GC logic: runs on every platform against a fake install tree;
// the Windows-only parts (process query, real Electron smoke) are injected.
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  STAGED_HOST_EXE,
  RUNTIME_MARKER,
  SMOKE_OK,
  classifyHostImage,
  collectStagedRuntimes,
  ensureStagedHostRuntime,
  parseProcessJson,
  planRuntimeFiles,
  resetStagedHostRuntimeForTests,
  resolveHostStaging,
  runtimeKey,
  stageHostRuntime,
  stagedRuntimeRoot,
  validStagedRuntime,
  type ProcessInfo
} from './session-host-runtime'
import { testTmpDir } from './test-tmp'

function write(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

function fakeInstall(): { root: string; execPath: string; resourcesPath: string; script: string; local: string } {
  const root = testTmpDir('nt-runtime-')
  const inst = path.join(root, 'Programs', 'nodeterm')
  const execPath = path.join(inst, 'nodeterm.exe')
  write(execPath, 'MZ electron')
  write(path.join(inst, 'ffmpeg.dll'), 'ffmpeg')
  write(path.join(inst, 'libEGL.dll'), 'egl')
  write(path.join(inst, 'icudtl.dat'), 'icu')
  write(path.join(inst, 'resources.pak'), 'pak')
  write(path.join(inst, 'v8_context_snapshot.bin'), 'snap')
  write(path.join(inst, 'LICENSE.electron.txt'), 'license')
  write(path.join(inst, 'Uninstall nodeterm.exe'), 'uninstaller')
  write(path.join(inst, 'locales', 'en-US.pak'), 'en')
  const resourcesPath = path.join(inst, 'resources')
  write(path.join(resourcesPath, 'app.asar'), 'asar')
  const script = path.join(resourcesPath, 'session-host', 'host.cjs')
  write(script, '// host')
  write(path.join(resourcesPath, 'session-host', 'node_modules', 'node-pty', 'package.json'), '{}')
  write(path.join(resourcesPath, 'session-host', 'node_modules', 'node-pty', 'build', 'Release', 'conpty.node'), 'n')
  return { root, execPath, resourcesPath, script, local: path.join(root, 'Local') }
}

const okSmoke = async (): Promise<number> => SMOKE_OK

function opts(f: ReturnType<typeof fakeInstall>, extra: Record<string, unknown> = {}) {
  return {
    platform: 'win32',
    execPath: f.execPath,
    resourcesPath: f.resourcesPath,
    script: f.script,
    appVersion: '0.4.0',
    localAppData: f.local,
    smoke: okSmoke,
    ...extra
  }
}

const tree = (dir: string): string[] => {
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
}

beforeEach(() => resetStagedHostRuntimeForTests())

describe('planRuntimeFiles', () => {
  it('takes the exe (renamed), DLLs, runtime data, locales and the host bundle — nothing else', async () => {
    const f = fakeInstall()
    const plan = await planRuntimeFiles(f.execPath, f.resourcesPath)
    expect(plan!.map((p) => p.rel)).toEqual([
      STAGED_HOST_EXE,
      'ffmpeg.dll',
      'icudtl.dat',
      'libEGL.dll',
      'locales/en-US.pak',
      'resources.pak',
      'resources/session-host/host.cjs',
      'resources/session-host/node_modules/node-pty/build/Release/conpty.node',
      'resources/session-host/node_modules/node-pty/package.json',
      'v8_context_snapshot.bin'
    ].sort())
  })

  it('refuses without ICU data or without the node-pty copy', async () => {
    const f = fakeInstall()
    fs.rmSync(path.join(path.dirname(f.execPath), 'icudtl.dat'))
    expect(await planRuntimeFiles(f.execPath, f.resourcesPath)).toBeNull()
    const g = fakeInstall()
    fs.rmSync(path.join(g.resourcesPath, 'session-host', 'node_modules'), { recursive: true })
    expect(await planRuntimeFiles(g.execPath, g.resourcesPath)).toBeNull()
  })
})

describe('runtimeKey', () => {
  it('is version-prefixed and changes when any source file changes', async () => {
    const f = fakeInstall()
    const plan = (await planRuntimeFiles(f.execPath, f.resourcesPath))!
    const a = runtimeKey('0.4.0', plan)
    expect(a).toMatch(/^0\.4\.0-[0-9a-f]{16}$/)
    expect(runtimeKey('0.4.0', [...plan.slice(1), { ...plan[0], size: plan[0].size + 1 }])).not.toBe(a)
    expect(runtimeKey('../../evil', plan)).not.toContain('/')
  })
})

describe('stageHostRuntime', () => {
  it('stages a verified copy outside the install directory and reuses it', async () => {
    const f = fakeInstall()
    const rt = await stageHostRuntime(opts(f))
    expect(rt).not.toBeNull()
    expect(rt!.dir.startsWith(stagedRuntimeRoot(f.local))).toBe(true)
    expect(rt!.dir.startsWith(path.dirname(f.execPath))).toBe(false)
    expect(fs.readFileSync(rt!.exe, 'utf8')).toBe('MZ electron')
    expect(fs.existsSync(rt!.script)).toBe(true)
    expect(tree(rt!.dir)).toContain(RUNTIME_MARKER)
    expect(tree(rt!.dir)).not.toContain('Uninstall nodeterm.exe')
    expect(tree(rt!.dir)).not.toContain('resources/app.asar')
    // No staging litter is left behind.
    expect(fs.readdirSync(stagedRuntimeRoot(f.local))).toEqual([path.basename(rt!.dir)])

    let smokes = 0
    const again = await stageHostRuntime(opts(f, { smoke: async () => (smokes++, SMOKE_OK) }))
    expect(again).toEqual(rt)
    expect(smokes).toBe(0)
  })

  it('never publishes a copy whose smoke run failed, and falls back (null)', async () => {
    const f = fakeInstall()
    for (const code of [null, 0, 1, 3221225781]) {
      expect(await stageHostRuntime(opts(f, { smoke: async () => code }))).toBeNull()
      const root = stagedRuntimeRoot(f.local)
      expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([])
    }
  })

  it('does not stage off Windows, without LOCALAPPDATA, or for a non-packaged script', async () => {
    const f = fakeInstall()
    expect(await stageHostRuntime(opts(f, { platform: 'linux' }))).toBeNull()
    expect(await stageHostRuntime(opts(f, { localAppData: undefined }))).toBeNull()
    expect(await stageHostRuntime(opts(f, { script: path.join(f.root, 'out', 'host.cjs') }))).toBeNull()
  })

  it('never launches a half-staged directory: an invalid one is moved aside and restaged', async () => {
    const f = fakeInstall()
    const plan = (await planRuntimeFiles(f.execPath, f.resourcesPath))!
    const dir = path.join(stagedRuntimeRoot(f.local), runtimeKey('0.4.0', plan))
    // An interrupted copy: the exe exists, no marker.
    write(path.join(dir, STAGED_HOST_EXE), 'MZ')
    expect(await validStagedRuntime(dir, runtimeKey('0.4.0', plan))).toBe(false)
    const rt = await stageHostRuntime(opts(f))
    expect(rt!.dir).toBe(dir)
    expect(await validStagedRuntime(dir, runtimeKey('0.4.0', plan))).toBe(true)
  })

  it('rejects a staged copy whose file sizes no longer match its marker', async () => {
    const f = fakeInstall()
    const rt = (await stageHostRuntime(opts(f)))!
    const key = path.basename(rt.dir)
    fs.writeFileSync(rt.exe, 'truncated')
    expect(await validStagedRuntime(rt.dir, key)).toBe(false)
    fs.rmSync(rt.exe)
    expect(await validStagedRuntime(rt.dir, key)).toBe(false)
  })

  it('a reinstall of the same version with different bytes gets its own directory', async () => {
    const f = fakeInstall()
    const a = (await stageHostRuntime(opts(f)))!
    fs.writeFileSync(f.execPath, 'MZ electron, rebuilt')
    const b = (await stageHostRuntime(opts(f)))!
    expect(b.dir).not.toBe(a.dir)
    expect(fs.readFileSync(b.exe, 'utf8')).toBe('MZ electron, rebuilt')
  })

  it('ensureStagedHostRuntime memoizes per app run', async () => {
    const f = fakeInstall()
    let smokes = 0
    const o = { ...opts(f, { smoke: async () => (smokes++, SMOKE_OK) }), collect: false }
    const [a, b] = await Promise.all([ensureStagedHostRuntime(o), ensureStagedHostRuntime(o)])
    expect(a).toEqual(b)
    expect(smokes).toBe(1)
  })
})

describe('collectStagedRuntimes', () => {
  const old = 60 * 60_000
  function setup(): { root: string; dirs: string[] } {
    const root = testTmpDir('nt-runtime-gc-')
    const dirs = ['0.3.20-aaaa', '0.3.21-bbbb', '0.4.0-cccc']
    for (const d of dirs) write(path.join(root, d, STAGED_HOST_EXE), 'MZ')
    return { root, dirs }
  }
  const later = Date.now() + 2 * old
  const procs = (list: ProcessInfo[]) => async () => list

  it('deletes only old runtimes nothing runs from, keeping the current one', async () => {
    const { root } = setup()
    const r = await collectStagedRuntimes({
      root,
      keep: ['0.4.0-cccc'],
      now: later,
      query: procs([
        { name: STAGED_HOST_EXE, path: path.join(root, '0.3.21-bbbb', STAGED_HOST_EXE).toUpperCase() },
        { name: 'explorer.exe', path: 'C:\\Windows\\explorer.exe' },
        { name: 'System', path: null }
      ])
    })
    expect(r.removed).toEqual(['0.3.20-aaaa'])
    expect(fs.readdirSync(root).sort()).toEqual(['0.3.21-bbbb', '0.4.0-cccc'])
  })

  it('fails closed: a failed query deletes nothing', async () => {
    const { root, dirs } = setup()
    for (const query of [async () => null, async () => { throw new Error('denied') }]) {
      const r = await collectStagedRuntimes({ root, keep: [], now: later, query })
      expect(r.refused).toBe('query-failed')
      expect(fs.readdirSync(root).sort()).toEqual(dirs)
    }
  })

  it('fails closed: a staged host whose path cannot be read deletes nothing', async () => {
    const { root, dirs } = setup()
    const r = await collectStagedRuntimes({
      root,
      keep: [],
      now: later,
      query: procs([{ name: STAGED_HOST_EXE.toUpperCase(), path: null }])
    })
    expect(r.refused).toBe('unknown-host-path')
    expect(fs.readdirSync(root).sort()).toEqual(dirs)
  })

  it('leaves recently created directories alone and sweeps old staging litter', async () => {
    const { root } = setup()
    write(path.join(root, '.staging-1234', 'x'), 'x')
    const fresh = await collectStagedRuntimes({ root, keep: [], query: procs([]) })
    expect(fresh.removed).toEqual([])
    const r = await collectStagedRuntimes({ root, keep: ['0.4.0-cccc'], now: later, query: procs([{ name: 'a.exe', path: 'C:\\a.exe' }]) })
    expect(r.removed.sort()).toEqual(['.staging-1234', '0.3.20-aaaa', '0.3.21-bbbb'])
    expect(fs.readdirSync(root)).toEqual(['0.4.0-cccc'])
  })

  it('does not match a sibling whose name only starts with the same characters', async () => {
    const { root } = setup()
    const r = await collectStagedRuntimes({
      root,
      keep: ['0.4.0-cccc', '0.3.21-bbbb'],
      now: later,
      query: procs([{ name: 'x.exe', path: path.join(root, '0.3.20-aaaa-other', 'x.exe') }])
    })
    expect(r.removed).toEqual(['0.3.20-aaaa'])
  })
})

describe('parseProcessJson', () => {
  it('reads PowerShell ConvertTo-Json output, single object or array', () => {
    expect(parseProcessJson('{"Name":"a.exe","ExecutablePath":"C:\\\\a.exe"}')).toEqual([{ name: 'a.exe', path: 'C:\\a.exe' }])
    expect(parseProcessJson('[{"Name":"System","ExecutablePath":null},{"Name":"b","ExecutablePath":""}]')).toEqual([
      { name: 'System', path: null },
      { name: 'b', path: null }
    ])
  })
  it('anything unexpected is a failed query', () => {
    for (const t of ['', 'not json', '[]', '[1]', '[{"ExecutablePath":"x"}]']) expect(parseProcessJson(t)).toBeNull()
  })
})

describe('parseProcessJson pid', () => {
  it('keeps a positive integer ProcessId and ignores anything else', () => {
    expect(parseProcessJson('[{"Name":"a","ExecutablePath":null,"ProcessId":42},{"Name":"b","ExecutablePath":null,"ProcessId":"7"}]')).toEqual([
      { name: 'a', path: null, pid: 42 },
      { name: 'b', path: null }
    ])
  })
})

// U3: a staged host does not block the installer; everything else keeps the stop flow.
describe('classifyHostImage', () => {
  const install = 'C:\\Users\\me\\AppData\\Local\\Programs\\nodeterm'
  const root = 'C:\\Users\\me\\AppData\\Local\\nodeterm\\session-host'
  const staged = `${root}\\0.4.1-0123456789abcdef\\${STAGED_HOST_EXE}`
  it.each([
    ['staged copy', staged, 'staged'],
    ['mixed case, forward slashes', staged.toUpperCase().replace(/\\/g, '/'), 'staged'],
    ['sibling directory is not under the root', staged.replace('session-host\\', 'session-host-evil\\'), 'unknown'],
    ['staged root but another image name', `${root}\\0.4.1-x\\helper.exe`, 'unknown'],
    ['legacy hard-link host', `${install}\\nodeterm-session-host.exe`, 'install'],
    ['fallback host name anywhere', 'D:\\Other\\nodeterm.exe', 'install'],
    ['staged name inside the installation', `${install}\\${STAGED_HOST_EXE}`, 'install'],
    ['something else entirely', 'C:\\Temp\\x.exe', 'unknown'],
    ['no path', null, 'unknown'],
    ['blank path', '  ', 'unknown']
  ] as const)('%s', (_n, exe, want) => {
    expect(classifyHostImage(exe, install, root)).toBe(want)
  })
  it('an absent staged root never yields staged', () => {
    expect(classifyHostImage(staged, install, null)).toBe('unknown')
  })
})

describe('resolveHostStaging', () => {
  const install = 'C:\\Apps\\nodeterm'
  const root = 'C:\\L\\nodeterm\\session-host'
  const exe = `${root}\\v\\${STAGED_HOST_EXE}`
  it('prefers the published exe and does not query', async () => {
    let asked = false
    const query = async (): Promise<ProcessInfo[]> => {
      asked = true
      return []
    }
    expect(await resolveHostStaging({ exe, pid: 9, installDir: install, stagedRoot: root, query })).toBe('staged')
    expect(asked).toBe(false)
  })
  it('falls back to the process with that pid', async () => {
    const query = async (): Promise<ProcessInfo[]> => [
      { name: 'nodeterm.exe', path: `${install}\\nodeterm.exe`, pid: 8 },
      { name: STAGED_HOST_EXE, path: exe, pid: 9 }
    ]
    expect(await resolveHostStaging({ pid: 9, installDir: install, stagedRoot: root, query })).toBe('staged')
    expect(await resolveHostStaging({ pid: 8, installDir: install, stagedRoot: root, query })).toBe('install')
    expect(await resolveHostStaging({ pid: 7, installDir: install, stagedRoot: root, query })).toBe('unknown')
  })
  it('a failed, throwing or pid-less lookup is unknown', async () => {
    expect(await resolveHostStaging({ pid: 9, installDir: install, stagedRoot: root, query: async () => null })).toBe('unknown')
    expect(
      await resolveHostStaging({
        pid: 9,
        installDir: install,
        stagedRoot: root,
        query: async () => {
          throw new Error('denied')
        }
      })
    ).toBe('unknown')
    expect(await resolveHostStaging({ pid: null, installDir: install, stagedRoot: root, query: async () => [] })).toBe('unknown')
  })
})
