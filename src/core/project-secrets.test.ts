// Project secrets, core half (docs/project-secrets.md). The fetch runner is exercised against REAL
// child processes — a Node script that prints a dummy value — so "no shell", the askpass stdout
// contract, the bounds and the exit-code reporting are measured, not mocked. No real secret is
// used anywhere: the value is a fixed dummy string.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { testTmpDir } from './test-tmp'
import {
  ProjectSecretsService,
  normalizePasted,
  runSecretCommand,
  stripOneLineEnding,
  valueProblem,
  type DeclarationsRead,
  type SecretFetchResult,
  type SecretSpawnInput
} from './project-secrets'
import { SECRET_REDACTION_MARKER, SECRET_STDOUT_MAX_BYTES, type ProjectSecretDecl } from '../shared/project-secrets'

const DUMMY = 'dummy-secret-value-0123456789'
const NODE = process.execPath

/** A script that writes `out` to stdout, `err` to stderr and exits `code`. */
function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return file
}

describe('runSecretCommand — the askpass contract against a real process', () => {
  const dir = testTmpDir('nt-secret-run-')

  it('reads the value from stdout and strips exactly one trailing newline', async () => {
    const s = script(dir, 'ok.js', `process.stdout.write(${JSON.stringify(DUMMY + '\n')})`)
    const r = await runSecretCommand([NODE, s], dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.toString('utf8')).toBe(DUMMY)
  })

  it('strips a CRLF ending too (a Windows program)', async () => {
    const s = script(dir, 'crlf.js', `process.stdout.write(${JSON.stringify(DUMMY + '\r\n')})`)
    const r = await runSecretCommand([NODE, s], dir)
    expect(r.ok && r.value.toString('utf8')).toBe(DUMMY)
  })

  it('refuses more than one line, and an empty value, without echoing the output', async () => {
    const two = script(dir, 'two.js', `process.stdout.write(${JSON.stringify(DUMMY + '\n' + DUMMY + '\n')})`)
    const r = await runSecretCommand([NODE, two], dir)
    expect(r).toMatchObject({ ok: false, error: 'the command printed more than one line' })
    expect(JSON.stringify(r)).not.toContain(DUMMY)
    const empty = script(dir, 'empty.js', `process.stdout.write('\\n')`)
    expect(await runSecretCommand([NODE, empty], dir)).toMatchObject({ ok: false, error: 'the command printed nothing' })
  })

  it('reports a non-zero exit with its code and stderr, and discards stdout', async () => {
    const s = script(
      dir,
      'fail.js',
      `process.stdout.write(${JSON.stringify(DUMMY)}); process.stderr.write('not signed in'); process.exit(3)`
    )
    const r = await runSecretCommand([NODE, s], dir)
    expect(r).toMatchObject({ ok: false, exitCode: 3, error: 'the command exited with code 3', stderr: 'not signed in' })
    expect(JSON.stringify(r)).not.toContain(DUMMY)
  })

  it('passes shell metacharacters as literal arguments (there is no shell)', async () => {
    const s = script(dir, 'argv.js', `process.stdout.write(process.argv[2] + '\\n')`)
    const literal = '$(echo pwned);`id`|&>x'
    const r = await runSecretCommand([NODE, s, literal], dir)
    expect(r.ok && r.value.toString('utf8')).toBe(literal)
    expect(fs.existsSync(path.join(dir, 'x'))).toBe(false)
  })

  it('runs in the project folder', async () => {
    const s = script(dir, 'cwd.js', `process.stdout.write(process.cwd() + '\\n')`)
    const r = await runSecretCommand([NODE, s], dir)
    expect(r.ok && fs.realpathSync(r.value.toString('utf8'))).toBe(fs.realpathSync(dir))
  })

  it('resolves a relative program against the project folder', async () => {
    const r = await runSecretCommand(['./does-not-exist-here'], dir)
    expect(r.ok).toBe(false)
  })

  it('stops a command that does not finish in time', async () => {
    const s = script(dir, 'hang.js', `setTimeout(() => {}, 60000)`)
    const r = await runSecretCommand([NODE, s], dir, { timeoutMs: 300 })
    expect(r).toMatchObject({ ok: false, error: 'the command did not finish within 1 s' })
  })

  it('refuses output over the cap', async () => {
    const s = script(dir, 'big.js', `process.stdout.write('a'.repeat(${SECRET_STDOUT_MAX_BYTES + 10}))`)
    const r = await runSecretCommand([NODE, s], dir)
    expect(r).toMatchObject({ ok: false })
    if (!r.ok) expect(r.error).toContain('printed more than')
  })

  it('names a missing program without running anything', async () => {
    const r = await runSecretCommand(['definitely-not-a-program-xyz'], dir, { resolve: () => null })
    expect(r).toEqual({ ok: false, error: 'program not found: definitely-not-a-program-xyz' })
  })
})

describe('value checks', () => {
  it('strips one line ending only', () => {
    expect(stripOneLineEnding(Buffer.from('a\n\n')).toString()).toBe('a\n')
    expect(stripOneLineEnding(Buffer.from('a')).toString()).toBe('a')
  })
  it('refuses NUL and invalid UTF-8', () => {
    expect(valueProblem(Buffer.from([0x61, 0x00]))).toBe('the value contains a NUL byte')
    expect(valueProblem(Buffer.from([0xff, 0xfe]))).toBe('the value is not valid UTF-8 text')
    expect(valueProblem(Buffer.from('ok'))).toBeNull()
  })
})

const DECL: ProjectSecretDecl = { env: 'API_TOKEN', command: ['print-token'] }

function service(opts: {
  read?: DeclarationsRead
  confirm?: boolean
  policy?: 'deny' | 'allow' | 'ask'
  run?: (c: string[], cwd: string) => Promise<SecretFetchResult>
}) {
  const run = vi.fn(opts.run ?? (async () => ({ ok: true as const, value: Buffer.from(DUMMY) })))
  const confirm = vi.fn(async () => opts.confirm ?? true)
  const svc = new ProjectSecretsService({
    readDeclarations: async () => opts.read ?? { kind: 'ok', cwd: '/p', secrets: [{ decl: DECL, source: 'shared' }] },
    confirm,
    crossProjectPolicy: () => opts.policy ?? 'deny',
    run
  })
  return { svc, run, confirm }
}

const spawnInput = (over: Partial<SecretSpawnInput> = {}): SecretSpawnInput => ({
  projectId: 'p1',
  declarations: [DECL],
  agentId: 'claude',
  nodeId: 'n1',
  ownerClient: true,
  remote: false,
  crossProject: false,
  ...over
})

describe('ProjectSecretsService — authorization', () => {
  it('runs nothing when the person cancels the confirmation', async () => {
    const { svc, run } = service({ confirm: false })
    const r = await svc.authorize('p1')
    expect(r.kind).toBe('cancelled')
    expect(run).not.toHaveBeenCalled()
    expect(svc.spawnEnv(spawnInput())).toEqual({})
  })

  it('fetches each declared secret ONCE per authorization and reuses it for every spawn', async () => {
    const { svc, run } = service({})
    await svc.authorize('p1')
    for (let i = 0; i < 5; i++) expect(svc.spawnEnv(spawnInput({ nodeId: `n${i}` }))).toEqual({ API_TOKEN: DUMMY })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reports names and states, never a value', async () => {
    const { svc } = service({})
    expect((await svc.status('p1')).secrets[0]).toMatchObject({ env: 'API_TOKEN', state: 'not-fetched' })
    const r = await svc.authorize('p1')
    expect(r.view.secrets[0].state).toBe('available')
    expect(JSON.stringify(r)).not.toContain(DUMMY)
    expect(JSON.stringify(await svc.status('p1'))).not.toContain(DUMMY)
  })

  it('records a failure with its exit code, and injects nothing for it', async () => {
    const { svc } = service({ run: async () => ({ ok: false, error: 'the command exited with code 2', exitCode: 2 }) })
    const r = await svc.authorize('p1')
    expect(r.view.secrets[0]).toMatchObject({ state: 'failed', exitCode: 2 })
    expect(svc.spawnEnv(spawnInput())).toEqual({})
  })

  it('refuses an SSH project by name and runs nothing', async () => {
    const { svc, run, confirm } = service({ read: { kind: 'unavailable', reason: 'ssh' } })
    expect(await svc.authorize('p1')).toMatchObject({ kind: 'refused', reason: 'ssh' })
    expect(confirm).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a second authorization while one is running', async () => {
    let release!: () => void
    const { svc } = service({
      run: () => new Promise((r) => (release = () => r({ ok: true, value: Buffer.from(DUMMY) })))
    })
    const first = svc.authorize('p1')
    await new Promise((r) => setTimeout(r, 0))
    expect(await svc.authorize('p1')).toMatchObject({ kind: 'refused', reason: 'busy' })
    release()
    expect((await first).kind).toBe('done')
  })
})

describe('ProjectSecretsService — who receives a value', () => {
  const authorized = async (policy: 'deny' | 'allow' | 'ask' = 'deny') => {
    const s = service({ policy })
    await s.svc.authorize('p1')
    return s.svc
  }

  it('an agent node of the declaring project, for this machine\'s own app', async () => {
    expect((await authorized()).spawnEnv(spawnInput())).toEqual({ API_TOKEN: DUMMY })
  })

  it('never a plain terminal, another project, a remote node or a spawn this app did not ask for', async () => {
    const svc = await authorized()
    expect(svc.spawnEnv(spawnInput({ agentId: undefined }))).toEqual({})
    expect(svc.spawnEnv(spawnInput({ projectId: 'p2' }))).toEqual({})
    expect(svc.spawnEnv(spawnInput({ remote: true }))).toEqual({})
    expect(svc.spawnEnv(spawnInput({ ownerClient: false }))).toEqual({})
  })

  it('not after the declaration changed (the person approved the old command)', async () => {
    const svc = await authorized()
    expect(svc.spawnEnv(spawnInput({ declarations: [{ env: 'API_TOKEN', command: ['other'] }] }))).toEqual({})
    const view = await svc.status('p1')
    expect(view.secrets[0].state).toBe('available') // status reads the same (unchanged) declaration
  })

  it('cross-project: deny withholds, allow gives, ask gives only after the person agreed', async () => {
    expect((await authorized('deny')).spawnEnv(spawnInput({ crossProject: true }))).toEqual({})
    expect((await authorized('allow')).spawnEnv(spawnInput({ crossProject: true }))).toEqual({ API_TOKEN: DUMMY })
    const ask = await authorized('ask')
    expect(await ask.crossProjectGate('p1', 'n1')).toEqual({ kind: 'ask', names: ['API_TOKEN'] })
    expect(ask.spawnEnv(spawnInput({ crossProject: true }))).toEqual({})
    ask.decideCrossProject('p1', 'n1', false)
    expect(ask.spawnEnv(spawnInput({ crossProject: true }))).toEqual({})
    expect(await ask.crossProjectGate('p1', 'n1')).toEqual({ kind: 'proceed' })
    ask.decideCrossProject('p1', 'n2', true)
    expect(ask.spawnEnv(spawnInput({ crossProject: true, nodeId: 'n2' }))).toEqual({ API_TOKEN: DUMMY })
  })

  it('the ask gate does not ask when nothing is held', async () => {
    const { svc } = service({ policy: 'ask' })
    expect(await svc.crossProjectGate('p1', 'n1')).toEqual({ kind: 'proceed' })
  })
})

describe('ProjectSecretsService — memory lifetime', () => {
  it('Clear zeroes the held buffer and stops injection', async () => {
    const value = Buffer.from(DUMMY)
    const { svc } = service({ run: async () => ({ ok: true, value }) })
    await svc.authorize('p1')
    await svc.clear('p1')
    expect([...value].every((b) => b === 0)).toBe(true)
    expect(svc.spawnEnv(spawnInput())).toEqual({})
  })

  it('re-authorization replaces the value and zeroes the old one', async () => {
    const first = Buffer.from(DUMMY)
    let n = 0
    const { svc } = service({
      run: async () => ({ ok: true, value: n++ === 0 ? first : Buffer.from('second-dummy-value') })
    })
    await svc.authorize('p1')
    await svc.authorize('p1')
    expect([...first].every((b) => b === 0)).toBe(true)
    expect(svc.spawnEnv(spawnInput())).toEqual({ API_TOKEN: 'second-dummy-value' })
  })

  it('closing, deleting or re-binding the project drops its values', async () => {
    const { svc } = service({})
    await svc.authorize('p1')
    svc.retainProjects(new Map([['p1', '/p']]))
    expect(svc.spawnEnv(spawnInput())).toEqual({ API_TOKEN: DUMMY })
    svc.retainProjects(new Map([['p1', '/elsewhere']]))
    expect(svc.spawnEnv(spawnInput())).toEqual({})
    await svc.authorize('p1')
    svc.retainProjects(new Map())
    expect(svc.spawnEnv(spawnInput())).toEqual({})
  })

  it('quit zeroes every value', async () => {
    const value = Buffer.from(DUMMY)
    const { svc } = service({ run: async () => ({ ok: true, value }) })
    await svc.authorize('p1')
    svc.dispose()
    expect([...value].every((b) => b === 0)).toBe(true)
    expect(svc.holdsAny()).toBe(false)
  })
})

describe('ProjectSecretsService — redaction of text Nodeterm writes', () => {
  it('replaces every held value, and leaves text alone when nothing is held', async () => {
    const { svc } = service({})
    expect(svc.redact(`echo ${DUMMY}`)).toBe(`echo ${DUMMY}`)
    await svc.authorize('p1')
    expect(svc.redact(`a ${DUMMY} b ${DUMMY}`)).toBe(`a ${SECRET_REDACTION_MARKER} b ${SECRET_REDACTION_MARKER}`)
  })

  it('does not redact values too short to be a credential', async () => {
    const { svc } = service({ run: async () => ({ ok: true, value: Buffer.from('abc') }) })
    await svc.authorize('p1')
    expect(svc.redact('abcabc')).toBe('abcabc')
  })
})

describe('ProjectSecretsService — pasted secrets', () => {
  const PASTED: ProjectSecretDecl = { env: 'PASTED_TOKEN' }
  const both: DeclarationsRead = {
    kind: 'ok',
    cwd: '/p',
    secrets: [
      { decl: PASTED, source: 'shared' },
      { decl: DECL, source: 'shared' }
    ]
  }
  function pasteService(answer: string | null, read: DeclarationsRead = both) {
    const checks: (string | null)[] = []
    const promptValue = vi.fn(async (_p: string, _s: unknown, check: (v: Buffer) => string | null) => {
      if (answer === null) return null
      const v = normalizePasted(Buffer.from(answer))
      checks.push(check(v))
      return v
    })
    const run = vi.fn(async () => ({ ok: true as const, value: Buffer.from(DUMMY) }))
    const confirm = vi.fn(async () => true)
    const svc = new ProjectSecretsService({
      readDeclarations: async () => read,
      confirm,
      promptValue,
      crossProjectPolicy: () => 'deny',
      run
    })
    return { svc, promptValue, run, confirm, checks }
  }
  const input = (over: Partial<SecretSpawnInput> = {}) => spawnInput({ declarations: [PASTED, DECL], ...over })

  it('a declaration without a command is pasted: status says so and the value is never shown', async () => {
    const { svc, run } = pasteService('pasted-dummy-value-987654\r\n')
    expect((await svc.status('p1')).secrets[0]).toMatchObject({ env: 'PASTED_TOKEN', input: 'paste', state: 'not-fetched' })
    expect((await svc.status('p1')).secrets[0].command).toBeUndefined()
    const r = await svc.paste('p1', 'PASTED_TOKEN')
    expect(r.kind).toBe('done')
    expect(r.view.secrets[0].state).toBe('available')
    expect(JSON.stringify(r)).not.toContain('pasted-dummy-value')
    expect(run).not.toHaveBeenCalled()
    // Line endings at the ends are dropped (a copied token often brings one).
    expect(svc.spawnEnv(input())).toEqual({ PASTED_TOKEN: 'pasted-dummy-value-987654' })
  })

  it('cancelling keeps nothing', async () => {
    const { svc } = pasteService(null)
    expect((await svc.paste('p1', 'PASTED_TOKEN')).kind).toBe('cancelled')
    expect(svc.spawnEnv(input())).toEqual({})
  })

  it('the window is given the paste check: empty and multi-line values are refused', async () => {
    const { svc, checks } = pasteService('two\nlines')
    expect((await svc.paste('p1', 'PASTED_TOKEN')).kind).toBe('cancelled')
    expect(checks).toEqual(['the value is more than one line'])
    expect(valueProblem(Buffer.alloc(0), 'paste')).toBe('the value is empty')
    expect(svc.spawnEnv(input())).toEqual({})
  })

  it('refuses a paste for a secret that has a command, or is not declared, without opening anything', async () => {
    const { svc, promptValue } = pasteService('x-dummy-value')
    expect(await svc.paste('p1', 'API_TOKEN')).toMatchObject({ kind: 'refused', reason: 'not-pasted' })
    expect(await svc.paste('p1', 'NOPE')).toMatchObject({ kind: 'refused', reason: 'not-pasted' })
    expect(promptValue).not.toHaveBeenCalled()
  })

  it('Fetch runs only the commands and keeps the pasted value; Clear drops both', async () => {
    const { svc, run, confirm } = pasteService('pasted-dummy-value-987654')
    await svc.paste('p1', 'PASTED_TOKEN')
    await svc.authorize('p1')
    expect(confirm).toHaveBeenCalledWith('p1', [{ decl: DECL, source: 'shared' }])
    expect(run).toHaveBeenCalledTimes(1)
    expect(svc.spawnEnv(input())).toEqual({ PASTED_TOKEN: 'pasted-dummy-value-987654', API_TOKEN: DUMMY })
    await svc.clear('p1')
    expect(svc.spawnEnv(input())).toEqual({})
  })

  it('Fetch is refused when every secret is pasted', async () => {
    const { svc, confirm } = pasteService('x', { kind: 'ok', cwd: '/p', secrets: [{ decl: PASTED, source: 'shared' }] })
    expect(await svc.authorize('p1')).toMatchObject({ kind: 'refused', reason: 'nothing-declared' })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('a pasted value is not injected once the declaration gains a command', async () => {
    const { svc } = pasteService('pasted-dummy-value-987654')
    await svc.paste('p1', 'PASTED_TOKEN')
    expect(svc.spawnEnv(input({ declarations: [{ env: 'PASTED_TOKEN', command: ['print'] }] }))).toEqual({})
  })

  it('replacing a pasted value zeroes the old one', async () => {
    const first = Buffer.from('first-dummy-value')
    let n = 0
    const svc = new ProjectSecretsService({
      readDeclarations: async () => both,
      confirm: async () => true,
      promptValue: async () => (n++ === 0 ? first : Buffer.from('second-dummy-value')),
      crossProjectPolicy: () => 'deny'
    })
    await svc.paste('p1', 'PASTED_TOKEN')
    await svc.paste('p1', 'PASTED_TOKEN')
    expect([...first].every((b) => b === 0)).toBe(true)
    expect(svc.spawnEnv(input())).toEqual({ PASTED_TOKEN: 'second-dummy-value' })
  })

  it('is not offered when the shell gives no way to paste', async () => {
    const svc = new ProjectSecretsService({ readDeclarations: async () => both, confirm: async () => true, crossProjectPolicy: () => 'deny' })
    expect(await svc.paste('p1', 'PASTED_TOKEN')).toMatchObject({ kind: 'refused', reason: 'not-pasted' })
  })
})
