import { afterEach, expect, it, vi } from 'vitest'
import { RemoteHooks } from './remote-hooks'
import { setIntegrationConsent } from '../../core/integration-policy'
import { integrationHostKey } from '../../shared/agent-integrations'
const conn = { host: 'host', user: 'u' }
afterEach(() => setIntegrationConsent(undefined))
function fixture() {
  const run = vi.fn(async (args: string[], _stdin?: string) => {
    const command = args.join(' ')
    if (command.includes('printf %s "$HOME"')) return { code: 0, stdout: '/home/u' }
    if (command.includes('%{http_code}')) return { code: 0, stdout: '204' }
    const resolved = command.match(/nt_resolve '([^']+)' \|\| exit 1/)?.[1]
    if (resolved) return { code: 44, stdout: `${resolved}\n` }
    return { code: 0, stdout: '' }
  })
  return { run, hooks: new RemoteHooks({ run }) }
}
it('local consent and existing remote installation never authorize remote global writes', async () => {
  setIntegrationConsent({ local: { claude: true, codex: true } })
  const { run, hooks } = fixture()
  await hooks.setup('p', conn, '/tmp/control', { port: 123, token: 'fixture', version: 'test' })
  await hooks.installIntoAccountDir(conn, '/tmp/control', '/home/u', 'account')
  await hooks.ensureFullscreenTui(conn, '/tmp/control', '/home/u')
  expect(run.mock.calls.filter(([, input]) => input).map(([args]) => args.join(' ')).join('\n')).not.toMatch(/\.claude|\.codex|\.gemini|\.grok|\.copilot/)
})
it('remote opt-in installs only that agent and injects no global instructions', async () => {
  setIntegrationConsent({ remote: { [integrationHostKey(conn)]: { claude: true } } })
  const { run, hooks } = fixture()
  await hooks.setup('p', conn, '/tmp/control', { port: 123, token: 'fixture', version: 'test' })
  await hooks.installCanvasControl(conn, '/tmp/control', '/home/u')
  await hooks.installContextLink(conn, '/tmp/control', '/home/u')
  const writes = run.mock.calls.filter(([, input]) => input).map(([args]) => args.join(' ')).join('\n')
  expect(writes).toContain('.claude/settings.json')
  expect(writes).not.toMatch(/AGENTS\.md|GEMINI\.md|copilot-instructions\.md|\.codex|\.gemini/)
})
it('a queued disable observes current consent after an in-flight install and never reinstalls', async () => {
  setIntegrationConsent({ remote: { [integrationHostKey(conn)]: { claude: true } } })
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { hooks, run } = fixture()
  const install = vi.spyOn(hooks as never as { installJsonAgentRemote: (...args: unknown[]) => Promise<void> }, 'installJsonAgentRemote')
    .mockImplementationOnce(async () => { entered(); await gate })
  const first = hooks.reconcileIntegrations(conn, '/tmp/control', '/home/u')
  await started
  setIntegrationConsent({ remote: { [integrationHostKey(conn)]: { claude: false } } })
  const second = hooks.reconcileIntegrations(conn, '/tmp/control', '/home/u')
  release()
  await Promise.all([first, second])
  expect(install).toHaveBeenCalledTimes(4) // two JSON agents per serialized pass
  expect(run.mock.calls.filter(([, input]) => input).some(([args]) => args.join(' ').includes('.claude/settings.json'))).toBe(false)
  install.mockRestore()
})
it('revoking during an account script upload prevents the subsequent global config write', async () => {
  setIntegrationConsent({ remote: { [integrationHostKey(conn)]: { claude: true } } })
  const calls: { args: string[]; input?: string }[] = []
  const hooks = new RemoteHooks({ run: async (args, input) => {
    calls.push({ args, input })
    if (input) setIntegrationConsent({ remote: { [integrationHostKey(conn)]: { claude: false } } })
    return { code: 0, stdout: '{}' }
  } })
  await hooks.installIntoAccountDir(conn, '/fixture-control', '/home/u', 'account')
  expect(calls.some((c) => c.input && c.args.join(' ').includes('settings.json'))).toBe(false)
  expect(calls).toHaveLength(1)
})
