// The Zellij backend against a REAL Zellij binary (skipped when none is found — see
// zellij-test-env.ts). Same discipline as the *.realtmux suites: the claims in zellij-backend.ts are
// about another program's behaviour, so they are proven on that program, not on a fake.
//
// Sessions are created headless (`attach --create-background`) with the SAME config and layout
// the painter uses; the painter's `--create` differs only in attaching a client, which vitest has no
// pty for (node-pty is built for Electron's ABI here).
import fs from 'fs'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ZELLIJ_LAYOUT,
  zellijCapture,
  zellijConf,
  zellijForegroundCommand,
  zellijKillSession,
  zellijSendText,
  zellijSessionState,
  zellijWriteChars
} from './zellij-backend'
import { TEST_ZELLIJ, disposeZellijSandbox, eventually, makeZellijSandbox, type ZellijSandbox } from './zellij-test-env'
import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

describe.skipIf(!TEST_ZELLIJ)('Zellij backend against the real binary', () => {
  let sb: ZellijSandbox
  let conf: string
  const created: string[] = []

  beforeAll(() => {
    sb = makeZellijSandbox()
    conf = path.join(sb.root, 'zellij.kdl')
    fs.writeFileSync(conf, zellijConf())
  })
  afterAll(async () => {
    if (sb) await disposeZellijSandbox(sb)
  })

  async function create(name: string, extraEnv: Record<string, string> = {}): Promise<void> {
    created.push(name)
    await exec(
      TEST_ZELLIJ as string,
      ['--config', conf, '--layout-string', ZELLIJ_LAYOUT, 'attach', '--create-background', '--close-on-exit', name, '--', '/bin/sh'],
      { env: { ...sb.env, ...extraEnv }, cwd: sb.root, timeout: 10_000 }
    )
    expect(await eventually(async () => (await zellijSessionState(sb.run, name)) === 'live')).toBe(true)
  }
  const screen = (name: string): Promise<string> => zellijCapture(sb.run, name, { full: true })

  it('the creating client’s environment IS the session’s — nothing rides an argv', async () => {
    await create('nt-env1', { NT_PROBE_SECRET: 'from-client-env' })
    expect(await zellijWriteChars(sb.run, 'nt-env1', 'echo "V=$NT_PROBE_SECRET"\r')).toBe(true)
    expect(await eventually(async () => (await screen('nt-env1')).includes('V=from-client-env'))).toBe(true)
  })

  it('existence is exact-name and tri-state; kill ends it', async () => {
    await create('nt-ex1')
    expect(await zellijSessionState(sb.run, 'nt-ex')).toBe('absent')
    expect(await zellijSessionState(sb.run, 'nt-ex1')).toBe('live')
    expect(await zellijKillSession(sb.run, 'nt-ex')).toBe(false)
    expect(await zellijSessionState(sb.run, 'nt-ex1')).toBe('live')
    expect(await zellijKillSession(sb.run, 'nt-ex1')).toBe(true)
    expect(await eventually(async () => (await zellijSessionState(sb.run, 'nt-ex1')) === 'absent')).toBe(true)
  })

  it('paste honours the app’s bracketed-paste request — the paste-buffer -p contract', async () => {
    await create('nt-paste1')
    await zellijWriteChars(sb.run, 'nt-paste1', 'stty -echo; cat -v\r')
    expect(await zellijSendText(sb.run, 'nt-paste1', 'U1\nU2', true)).toBe(true)
    expect(await eventually(async () => /U1\n\s*U2/.test(await screen('nt-paste1')))).toBe(true)
    expect(await screen('nt-paste1')).not.toContain('^[[200~U1')
    await zellijWriteChars(sb.run, 'nt-paste1', '\u0004')
    await zellijWriteChars(sb.run, 'nt-paste1', "printf '\\033[?2004h'; cat -v\r")
    await new Promise((r) => setTimeout(r, 300))
    expect(await zellijSendText(sb.run, 'nt-paste1', 'F1\nF2', true)).toBe(true)
    expect(await eventually(async () => (await screen('nt-paste1')).includes('^[[200~F1'))).toBe(true)
  })

  it('text that starts with "-" is delivered, not read as a flag', async () => {
    await create('nt-dash1')
    await zellijWriteChars(sb.run, 'nt-dash1', 'stty -echo; cat -v\r')
    expect(await zellijSendText(sb.run, 'nt-dash1', '- item one\n- item two', true)).toBe(true)
    expect(await zellijWriteChars(sb.run, 'nt-dash1', '-h\r')).toBe(true)
    expect(
      await eventually(async () => {
        const text = await screen('nt-dash1')
        return text.includes('- item two') && /^-h$/m.test(text)
      })
    ).toBe(true)
  })

  it('the foreground command is read off the process table', async () => {
    await create('nt-fg1')
    await zellijWriteChars(sb.run, 'nt-fg1', 'sleep 30\r')
    const fg = async (): Promise<string | null> => {
      const { stdout } = await exec('ps', ['-A', '-o', 'pid=,ppid=,tpgid=,comm=,args='], { encoding: 'utf-8' })
      return zellijForegroundCommand(stdout, 'nt-fg1')
    }
    expect(await eventually(async () => (await fg()) === 'sleep')).toBe(true)
    await zellijWriteChars(sb.run, 'nt-fg1', '\u0003')
    expect(await eventually(async () => (await fg()) === 'sh')).toBe(true)
  })

  it('a shell that exits with no client attached never reads as a live session', async () => {
    await create('nt-z1')
    await zellijWriteChars(sb.run, 'nt-z1', 'exit\r')
    expect(await eventually(async () => (await zellijSessionState(sb.run, 'nt-z1')) !== 'live')).toBe(true)
  })

  afterAll(async () => {
    for (const name of created) await zellijKillSession(sb.run, name)
  })
})
