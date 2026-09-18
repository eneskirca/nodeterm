// The Antigravity installer refuses a machine where cmd.exe runs an
// AutoRun command, and refuses when it cannot tell.
//
// The registry is NEVER written here. The reader is exercised over a fake `reg query` that answers
// the way reg.exe does (exit 0 + listing, or exit 1 with a localized message that we must not
// parse), and the real reader is only ever READ from, on Windows, to prove it answers.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CMD_AUTORUN_KEYS,
  checkCmdAutoRun,
  listingHasSubkey,
  parseAutoRunValue,
  readCmdAutoRun,
  makeRegQuery,
  type ExecFile,
  type CmdAutoRunCheck,
  type RegQuery
} from './antigravity-autorun'
import { ANTIGRAVITY_BUNDLE_KEY, installAntigravityHooks, removeAntigravityHooks } from './antigravity'

const [HKCU, HKLM, WOW] = CMD_AUTORUN_KEYS
// Every install here happens on a machine that HAS agy (the no-agy refusal is tested in antigravity.test.ts).
const HAS_AGY = (): string => 'C:/fake/agy.exe'

const listing = (key: string, values: string[] = [], subkeys: string[] = []): string =>
  ['', key, ...values.map((v) => `    ${v}`), '', ...subkeys.map((s) => `${key}\\${s}`), ''].join('\r\n')

/** A fake registry: `keys` maps a key to its listing; anything else answers like a missing key. */
const fakeReg = (keys: Record<string, string>, calls: string[] = []): RegQuery => {
  return (key) => {
    calls.push(key)
    const hit = Object.entries(keys).find(([k]) => k.toLowerCase() === key.toLowerCase())
    return hit
      ? { status: 0, stdout: hit[1] }
      : { status: 1, stdout: '' } // reg's own message goes to stderr, localized — never read
  }
}

/** The parents every lookup may climb to, all listable, with the usual children. */
const PARENTS: Record<string, string> = {
  HKEY_CURRENT_USER: listing('HKEY_CURRENT_USER', [], ['Software']),
  'HKEY_CURRENT_USER\\Software': listing('HKEY_CURRENT_USER\\Software', [], ['Microsoft']),
  'HKEY_CURRENT_USER\\Software\\Microsoft': listing('HKEY_CURRENT_USER\\Software\\Microsoft', [], ['Windows']),
  HKEY_LOCAL_MACHINE: listing('HKEY_LOCAL_MACHINE', [], ['SOFTWARE']),
  'HKEY_LOCAL_MACHINE\\Software': listing('HKEY_LOCAL_MACHINE\\Software', [], ['Microsoft', 'WOW6432Node']),
  'HKEY_LOCAL_MACHINE\\Software\\Microsoft': listing('HKEY_LOCAL_MACHINE\\Software\\Microsoft', [], ['Command Processor']),
  'HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft': listing(
    'HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft',
    [],
    ['Command Processor']
  )
}
const CP_PLAIN = ['CompletionChar    REG_DWORD    0x9', 'EnableExtensions    REG_DWORD    0x1']

describe('parsing', () => {
  it('reads an AutoRun value, any case, SZ or EXPAND_SZ', () => {
    expect(parseAutoRunValue(listing(HKCU, [...CP_PLAIN, 'AutoRun    REG_SZ    echo hi']))).toBe('echo hi')
    expect(parseAutoRunValue(listing(HKCU, ['autorun    REG_EXPAND_SZ    %USERPROFILE%\\x.cmd']))).toBe(
      '%USERPROFILE%\\x.cmd'
    )
  })

  it('an absent or empty AutoRun is no AutoRun', () => {
    expect(parseAutoRunValue(listing(HKLM, CP_PLAIN))).toBeUndefined()
    expect(parseAutoRunValue(listing(HKLM, ['AutoRun    REG_SZ    ']))).toBeUndefined()
    expect(parseAutoRunValue(listing(HKLM, ['AutoRun    REG_SZ']))).toBeUndefined()
    // A value whose NAME merely contains the word is not it.
    expect(parseAutoRunValue(listing(HKLM, ['AutoRunDisabled    REG_SZ    x']))).toBeUndefined()
  })

  it('finds a subkey line in a parent listing, any case, exact only', () => {
    const l = listing('HKEY_LOCAL_MACHINE\\Software', [], ['WOW6432Node', 'Microsoft'])
    expect(listingHasSubkey(l, 'hkey_local_machine\\software\\wow6432node')).toBe(true)
    expect(listingHasSubkey(l, 'HKEY_LOCAL_MACHINE\\Software\\WOW6432')).toBe(false)
  })
})

describe('checkCmdAutoRun over a fake reg', () => {
  const machine = (extra: Record<string, string>): Record<string, string> => ({
    ...PARENTS,
    [HKLM]: listing(HKLM, CP_PLAIN),
    [WOW]: listing(WOW, CP_PLAIN),
    ...extra
  })

  it('clear: HKCU has no Command Processor key (the usual case) and HKLM has no AutoRun', () => {
    expect(checkCmdAutoRun(fakeReg(machine({})))).toEqual({ kind: 'clear' })
  })

  it.each([
    ['HKCU', HKCU],
    ['HKLM', HKLM],
    ['WOW6432Node', WOW]
  ])('set: an AutoRun under %s', (_n, key) => {
    const reg = machine({ [key]: listing(key, [...CP_PLAIN, 'AutoRun    REG_SZ    @echo off & echo hello']) })
    expect(checkCmdAutoRun(fakeReg(reg))).toEqual({
      kind: 'set',
      entries: [{ key, value: '@echo off & echo hello' }]
    })
  })

  it('clear: an empty AutoRun value', () => {
    const reg = machine({ [HKCU]: listing(HKCU, ['AutoRun    REG_SZ    ']) })
    expect(checkCmdAutoRun(fakeReg(reg))).toEqual({ kind: 'clear' })
  })

  it('clear: a 32-bit Windows with no WOW6432Node at all (the parent says it is absent)', () => {
    const reg = machine({
      'HKEY_LOCAL_MACHINE\\Software': listing('HKEY_LOCAL_MACHINE\\Software', [], ['Microsoft'])
    })
    delete reg[WOW]
    delete reg['HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft']
    expect(checkCmdAutoRun(fakeReg(reg))).toEqual({ kind: 'clear' })
  })

  it('UNREADABLE: the key exists (its parent lists it) but cannot be listed', () => {
    const reg = machine({})
    delete reg[HKLM] // listed by its parent, fails itself — e.g. access denied
    const out = checkCmdAutoRun(fakeReg(reg))
    expect(out.kind).toBe('unreadable')
  })

  it('UNREADABLE: nothing can be listed at all (reg missing or blocked)', () => {
    const none: RegQuery = () => ({ status: null, stdout: '' })
    expect(checkCmdAutoRun(none).kind).toBe('unreadable')
  })

  it('UNREADABLE: a reg that throws', () => {
    const boom: RegQuery = () => {
      throw new Error('spawn failed')
    }
    expect(checkCmdAutoRun(boom).kind).toBe('unreadable')
  })

  it('never decides absence from the failing query itself — it asks the parent', () => {
    const calls: string[] = []
    checkCmdAutoRun(fakeReg(machine({}), calls))
    expect(calls).toContain(HKCU)
    expect(calls).toContain('HKEY_CURRENT_USER\\Software\\Microsoft')
  })
})

describe('the installer refuses before writing anything', () => {
  const root = mkdtempSync(join(tmpdir(), 'nt agy autorun '))
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))
  let n = 0
  const attempt = (readAutoRun: () => CmdAutoRunCheck, platform = 'win32') => {
    const home = join(root, `h${++n}`, 'John Doe')
    mkdirSync(home, { recursive: true })
    const hooksJson = join(home, '.gemini', 'config', 'hooks.json')
    const script = join(home, '.nodeterm', 'agent-hooks', 'antigravity.sh')
    let consulted = 0
    installAntigravityHooks({ findAgy: HAS_AGY,
      hooksJson,
      platform,
      scriptPath: script,
      readAutoRun: () => {
        consulted++
        return readAutoRun()
      }
    })
    return {
      consulted,
      hooksJson: existsSync(hooksJson),
      script: existsSync(script),
      wrapper: existsSync(join(home, '.nodeterm', 'agent-hooks', 'antigravity-hook.cmd'))
    }
  }

  it('an AutoRun is set → no hooks.json, no script, no wrapper', () => {
    expect(attempt(() => ({ kind: 'set', entries: [{ key: HKCU, value: 'echo hi' }] }))).toEqual({
      consulted: 1,
      hooksJson: false,
      script: false,
      wrapper: false
    })
  })

  it('the registry is unreadable → nothing written (the side that cannot deny a tool)', () => {
    expect(attempt(() => ({ kind: 'unreadable', reason: 'test' }))).toMatchObject({
      hooksJson: false,
      script: false,
      wrapper: false
    })
  })

  it('the reader throws → nothing written', () => {
    expect(
      attempt(() => {
        throw new Error('boom')
      })
    ).toMatchObject({ hooksJson: false, script: false, wrapper: false })
  })

  it('clear → installs (the refusal is the only thing the check changes)', () => {
    expect(attempt(() => ({ kind: 'clear' }))).toMatchObject({ consulted: 1, hooksJson: true, script: true })
  })

  it('off Windows the registry is never consulted', () => {
    expect(attempt(() => ({ kind: 'set', entries: [] }), 'linux')).toMatchObject({ consulted: 0, hooksJson: true })
  })
})

describe.skipIf(process.platform !== 'win32')('the real reader (read-only)', () => {
  it('answers clear or set on this machine — never unreadable', () => {
    const out = readCmdAutoRun()
    expect(out.kind).not.toBe('unreadable')
  })
})

describe('a refusal WITHDRAWS a bundle an earlier launch installed, so a later AutoRun cannot keep denying tools through it', () => {
  const root = mkdtempSync(join(tmpdir(), 'nt agy withdraw '))
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))
  let n = 0
  const FOREIGN = {
    'other-tool': { Stop: [{ type: 'command', command: 'C:\\other-tool\\Stop.cmd' }] },
    mine: { enabled: false }
  }
  /** A home with our bundle installed by a CLEAR launch, plus foreign keys. */
  const installed = () => {
    const home = join(root, `w${++n}`, 'John Doe')
    const hooksJson = join(home, '.gemini', 'config', 'hooks.json')
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
    writeFileSync(hooksJson, JSON.stringify(FOREIGN), 'utf8')
    const script = join(home, '.nodeterm', 'agent-hooks', 'antigravity.sh')
    installAntigravityHooks({ findAgy: HAS_AGY, hooksJson, platform: 'win32', scriptPath: script, readAutoRun: () => ({ kind: 'clear' }) })
    const before = JSON.parse(readFileSync(hooksJson, 'utf8')) as Record<string, unknown>
    expect(before[ANTIGRAVITY_BUNDLE_KEY]).toBeDefined()
    return { home, hooksJson, script }
  }
  const after = (hooksJson: string) => JSON.parse(readFileSync(hooksJson, 'utf8')) as Record<string, unknown>

  it.each<[string, CmdAutoRunCheck | 'throw']>([
    ['set', { kind: 'set', entries: [{ key: HKCU, value: 'echo hi' }] }],
    ['unreadable', { kind: 'unreadable', reason: 'test' }],
    ['a throwing reader', 'throw']
  ])('%s → our bundle is gone, foreign keys intact', (_name, verdict) => {
    const { hooksJson, script } = installed()
    installAntigravityHooks({ findAgy: HAS_AGY,
      hooksJson,
      platform: 'win32',
      scriptPath: script,
      readAutoRun: () => {
        if (verdict === 'throw') throw new Error('boom')
        return verdict
      }
    })
    const data = after(hooksJson)
    expect(data[ANTIGRAVITY_BUNDLE_KEY]).toBeUndefined()
    expect(data).toEqual(FOREIGN)
  })

  it('no quote-free command for the layout → our bundle is gone, foreign keys intact', () => {
    const { hooksJson } = installed()
    installAntigravityHooks({ findAgy: HAS_AGY,
      hooksJson,
      platform: 'win32',
      // The script now lives across a directory with a space: no quote-free relative path.
      scriptPath: join(root, 'Other Dir', 'agent-hooks', 'antigravity.sh'),
      writeScript: false,
      readAutoRun: () => ({ kind: 'clear' })
    })
    expect(after(hooksJson)).toEqual(FOREIGN)
  })

  it('an unreadable hooks.json stays byte-for-byte intact under a refusal', () => {
    const home = join(root, `w${++n}`)
    const hooksJson = join(home, 'hooks.json')
    mkdirSync(home, { recursive: true })
    writeFileSync(hooksJson, '{ not json', 'utf8')
    installAntigravityHooks({ findAgy: HAS_AGY,
      hooksJson,
      platform: 'win32',
      scriptPath: join(home, 'antigravity.sh'),
      readAutoRun: () => ({ kind: 'set', entries: [] })
    })
    expect(readFileSync(hooksJson, 'utf8')).toBe('{ not json')
  })

  it('a hooks.json with nothing of ours is not rewritten (not even reformatted)', () => {
    const home = join(root, `w${++n}`)
    const hooksJson = join(home, 'hooks.json')
    mkdirSync(home, { recursive: true })
    const body = '{"mine":   {"enabled":false}}'
    writeFileSync(hooksJson, body, 'utf8')
    installAntigravityHooks({ findAgy: HAS_AGY,
      hooksJson,
      platform: 'win32',
      scriptPath: join(home, 'antigravity.sh'),
      readAutoRun: () => ({ kind: 'set', entries: [] })
    })
    expect(readFileSync(hooksJson, 'utf8')).toBe(body)
  })
})

describe('the real reg query wrapper: absolute reg.exe only, and the 64-bit view of HKLM', () => {
  const recorder = () => {
    const calls: { file: string; args: readonly string[] }[] = []
    const exec: ExecFile = (file, args) => {
      calls.push({ file, args })
      return 'listing'
    }
    return { calls, exec }
  }

  it('without SystemRoot or windir it runs NOTHING and answers status null → unreadable', () => {
    const { calls, exec } = recorder()
    const query = makeRegQuery(exec, { PATH: 'C:\\evil' })
    expect(query(HKCU)).toEqual({ status: null, stdout: '' })
    expect(calls).toHaveLength(0)
    expect(checkCmdAutoRun(query).kind).toBe('unreadable')
  })

  it('uses the absolute reg.exe, falling back from SystemRoot to windir', () => {
    const a = recorder()
    makeRegQuery(a.exec, { SystemRoot: 'C:\\Windows' })(HKCU)
    expect(a.calls[0].file).toBe('C:\\Windows\\System32\\reg.exe')
    const b = recorder()
    makeRegQuery(b.exec, { windir: 'D:\\WIN' })(HKCU)
    expect(b.calls[0].file).toBe('D:\\WIN\\System32\\reg.exe')
  })

  it('passes /reg:64 on every HKLM query (parents included) and never on HKCU', () => {
    const { calls, exec } = recorder()
    const query = makeRegQuery(exec, { SystemRoot: 'C:\\Windows' })
    for (const key of [HKLM, WOW, 'HKEY_LOCAL_MACHINE\\Software', 'HKEY_LOCAL_MACHINE', HKCU, 'HKEY_CURRENT_USER']) {
      query(key)
    }
    expect(calls.map((c) => c.args)).toEqual([
      ['query', HKLM, '/reg:64'],
      ['query', WOW, '/reg:64'],
      ['query', 'HKEY_LOCAL_MACHINE\\Software', '/reg:64'],
      ['query', 'HKEY_LOCAL_MACHINE', '/reg:64'],
      ['query', HKCU],
      ['query', 'HKEY_CURRENT_USER']
    ])
  })

  it('a failing exec reports its exit status; one that never ran reports null', () => {
    const query1 = makeRegQuery(
      () => {
        throw Object.assign(new Error('exit 1'), { status: 1, stdout: '' })
      },
      { SystemRoot: 'C:\\Windows' }
    )
    expect(query1(HKCU)).toEqual({ status: 1, stdout: '' })
    const query2 = makeRegQuery(
      () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
      { SystemRoot: 'C:\\Windows' }
    )
    expect(query2(HKCU).status).toBeNull()
  })
})

describe('the refusal logs what the withdrawal REALLY did, so a failed write is not reported as done', () => {
  const root = mkdtempSync(join(tmpdir(), 'nt agy withdraw note '))
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))
  let n = 0
  const SET: CmdAutoRunCheck = { kind: 'set', entries: [{ key: HKCU, value: 'echo hi' }] }
  const home = () => {
    const h = join(root, `d${++n}`, 'John Doe')
    mkdirSync(join(h, '.gemini', 'config'), { recursive: true })
    return { hooksJson: join(h, '.gemini', 'config', 'hooks.json'), script: join(h, '.nodeterm', 'agent-hooks', 'antigravity.sh') }
  }
  const installClear = (hooksJson: string, script: string) =>
    installAntigravityHooks({ findAgy: HAS_AGY, hooksJson, platform: 'win32', scriptPath: script, readAutoRun: () => ({ kind: 'clear' }) })

  /** Refuse with `verdict`; returns the warning text and whether our bundle was present WHEN it was logged. */
  const refuse = (
    hooksJson: string,
    script: string,
    verdict: CmdAutoRunCheck,
    writeFile?: (file: string, data: Record<string, unknown>) => void
  ) => {
    const seen: { text: string; bundleAtLogTime: boolean }[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(' ')
      const bundleAtLogTime = existsSync(hooksJson) && readFileSync(hooksJson, 'utf8').includes(ANTIGRAVITY_BUNDLE_KEY)
      seen.push({ text, bundleAtLogTime })
    })
    try {
      installAntigravityHooks({ findAgy: HAS_AGY, hooksJson, platform: 'win32', scriptPath: script, readAutoRun: () => verdict, writeFile })
    } finally {
      spy.mockRestore()
    }
    expect(seen).toHaveLength(1)
    return seen[0]
  }

  it('withdrawn: says so, and says it only after the bundle is really gone', () => {
    const { hooksJson, script } = home()
    installClear(hooksJson, script)
    const w = refuse(hooksJson, script, SET)
    expect(w.text).toContain('was withdrawn')
    expect(w.bundleAtLogTime).toBe(false)
  })

  it('absent: says there was nothing to withdraw (and the unreadable branch says it too)', () => {
    const a = home()
    expect(refuse(a.hooksJson, a.script, SET).text).toContain('nothing to withdraw')
    const b = home()
    expect(refuse(b.hooksJson, b.script, { kind: 'unreadable', reason: 'x' }).text).toContain('nothing to withdraw')
  })

  it('failed: a write that fails is REPORTED as a failure, and the bundle is still there', () => {
    const { hooksJson, script } = home()
    installClear(hooksJson, script)
    const w = refuse(hooksJson, script, SET, () => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    expect(w.text).toContain('FAILED')
    expect(w.text).not.toContain('was withdrawn')
    expect(w.bundleAtLogTime).toBe(true)
    expect(readFileSync(hooksJson, 'utf8')).toContain(ANTIGRAVITY_BUNDLE_KEY)
  })

  it('unparseable: says the file was left untouched', () => {
    const { hooksJson, script } = home()
    writeFileSync(hooksJson, '{ nope', 'utf8')
    expect(refuse(hooksJson, script, SET).text).toContain('left untouched')
  })

  it('the no-quote-free-command branch reports the real result too', () => {
    const { hooksJson, script } = home()
    installClear(hooksJson, script)
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      installAntigravityHooks({ findAgy: HAS_AGY,
        hooksJson,
        platform: 'win32',
        scriptPath: join(root, 'Other Dir', 'agent-hooks', 'antigravity.sh'),
        writeScript: false,
        readAutoRun: () => ({ kind: 'clear' }),
        writeFile: () => {
          throw new Error('EBUSY')
        }
      })
      expect(String(spy.mock.calls[0]?.[0])).toContain('FAILED')
    } finally {
      spy.mockRestore()
    }
  })

  it('removeAntigravityHooks returns each outcome directly', () => {
    const { hooksJson, script } = home()
    expect(removeAntigravityHooks({ hooksJson })).toBe('absent')
    installClear(hooksJson, script)
    expect(
      removeAntigravityHooks({
        hooksJson,
        writeFile: () => {
          throw new Error('x')
        }
      })
    ).toBe('failed')
    expect(removeAntigravityHooks({ hooksJson })).toBe('withdrawn')
    expect(removeAntigravityHooks({ hooksJson })).toBe('absent')
    writeFileSync(hooksJson, '[]', 'utf8')
    expect(removeAntigravityHooks({ hooksJson })).toBe('unparseable')
  })
})
