// Issue #744, at source level: a consent gate is only as good as the ONE path through it. A new call
// to a global installer that skips the lifecycle compiles fine and writes into the user's agent
// config without asking — exactly the bug this feature closes — so the call sites are pinned.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '..')
const code = (rel: string): string =>
  readFileSync(path.join(SRC, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) && !n.includes('test-plan')) out.push(path.relative(SRC, p))
  }
  return out
}

describe('agent-integration consent wiring (#744)', () => {
  it.each(['main/index.ts', 'server/index.ts'])('%s boots the lifecycle, registers its IPC and grandfathers at boot', (shell) => {
    const src = code(shell)
    expect(src).toContain('createIntegrationLifecycle(')
    expect(src).toContain('registerIntegrationLifecycle(')
    expect(src).toContain('registerIntegrationIpc(')
    expect(src).toContain('resolveIntegrationConsentAtBoot(')
    expect(src).toMatch(/settingsStore\.onChange\(\(s\) => integrations\.onSettingsChanged\(s\)\)/)
  })

  it('the Server Edition passes installHooks:false as a hard veto', () => {
    expect(code('server/index.ts')).toMatch(/veto: config\.installHooks === false/)
  })

  it('the desktop re-applies the SSH plan when the consent changes', () => {
    expect(code('main/index.ts')).toContain('sshProjectManager?.onIntegrationConsentChanged()')
    expect(code('main/index.ts')).toContain('integrationsForHost:')
  })

  it('no file outside the lifecycle calls a global installer', () => {
    const allowed: Record<string, readonly string[]> = {
      'installManagedAgentHooks(': ['core/agent-integrations.ts', 'core/agents/hooks/index.ts'],
      'installClaudeHooksInto(': ['core/agent-integrations.ts', 'core/agents/hooks/claude.ts'],
      'ensureClaudeFullscreenTuiInto(': ['core/agent-integrations.ts', 'core/agents/hooks/claude.ts'],
      'installCanvasSkillInto(': [],
      'mergeInstructionFile(': ['core/agents/hooks/settings-file.ts', 'core/integration-files.ts']
    }
    const offenders: string[] = []
    for (const rel of walk(SRC)) {
      const src = code(rel)
      for (const [needle, ok] of Object.entries(allowed)) {
        if (src.includes(needle) && !ok.includes(rel.split(path.sep).join('/'))) offenders.push(`${rel}: ${needle}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('RemoteHooks cannot be built without a consent plan', () => {
    expect(code('main/remote-ssh/remote-hooks.ts')).toMatch(
      /constructor\(\s*private r: RemoteRunner,\s*private integrations: \(conn: SshConnection\) => RemoteIntegrationPlan/
    )
  })
})
