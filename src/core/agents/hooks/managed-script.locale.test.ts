import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildManagedScript } from './managed-script'
import { CONTROL_SHIM_SCRIPT } from '../../canvas-control-core'
import { CONTEXT_SHIM_SCRIPT } from '../../context-link-core'

const shAvailable = spawnSync('sh', ['-c', 'exit 0']).status === 0 && process.platform !== 'win32'

function fakeCurl(log: string): string {
  return [
    '#!/bin/sh',
    'loc=${LC_ALL:-${LC_NUMERIC:-${LANG:-C}}}',
    'case "$loc" in',
    '  C|C.*|POSIX) ;;',
    '  *)',
    '    prev=""',
    '    for a in "$@"; do',
    '      case "$prev" in',
    '        --connect-timeout|--max-time|-m)',
    '          case "$a" in *.*) echo "curl: option $prev: expected a proper numerical parameter" >&2; exit 2 ;; esac ;;',
    '      esac',
    '      prev=$a',
    '    done ;;',
    'esac',
    `printf 'ARGV %s\\n' "$*" >> ${JSON.stringify(log)}`,
    'cat >/dev/null',
    "printf '204'",
    'exit 0',
    ''
  ].join('\n')
}

describe.skipIf(!shAvailable)('managed hook under a comma-decimal locale, under /bin/sh', () => {
  const root = shAvailable ? mkdtempSync(join(tmpdir(), 'nt-hook-locale-')) : ''
  let n = 0
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  function postsDelivered(localeEnv: Record<string, string>): string {
    const dir = join(root, String(++n))
    const home = join(dir, 'home')
    const bin = join(dir, 'bin')
    const log = join(dir, 'curl.log')
    mkdirSync(join(home, '.nodeterm'), { recursive: true })
    mkdirSync(bin, { recursive: true })
    const endpoint = join(home, '.nodeterm', 'hook-endpoint.env')
    writeFileSync(endpoint, 'NODETERM_HOOK_PORT=45999\nNODETERM_HOOK_TOKEN=tok\nNODETERM_HOOK_VERSION=2\n', 'utf8')
    writeFileSync(join(bin, 'curl'), fakeCurl(log), { mode: 0o755 })
    const script = join(dir, 'claude.sh')
    writeFileSync(script, buildManagedScript('claude', null), { mode: 0o755 })
    const res = spawnSync('sh', [script], {
      encoding: 'utf8',
      input: '{"hook_event_name":"Stop"}',
      cwd: dir,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        NODETERM_NODE_ID: 'node-1',
        NODETERM_HOOK_ENDPOINT: endpoint,
        ...localeEnv
      }
    })
    expect(res.status).toBe(0)
    const deadline = Date.now() + 3000
    while (!existsSync(log) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    return existsSync(log) ? readFileSync(log, 'utf8') : ''
  }

  it('delivers the event when LC_ALL is sv_SE.UTF-8', () => {
    expect(postsDelivered({ LC_ALL: 'sv_SE.UTF-8' })).toContain('/hook/claude')
  })

  it('delivers the event when only LC_NUMERIC is sv_SE.UTF-8', () => {
    expect(postsDelivered({ LANG: 'en_US.UTF-8', LC_NUMERIC: 'sv_SE.UTF-8' })).toContain('/hook/claude')
  })
})

describe('every generated curl with a fractional timeout runs under LC_ALL=C', () => {
  const scripts: Record<string, string> = {
    ...Object.fromEntries(
      ['claude', 'codex', 'gemini', 'grok', 'copilot', 'cursor', 'antigravity'].map((id) => [
        `managed:${id}`,
        buildManagedScript(id, null)
      ])
    ),
    'canvas-control shim': CONTROL_SHIM_SCRIPT,
    'context-link shim': CONTEXT_SHIM_SCRIPT
  }

  it.each(Object.entries(scripts))('%s', (_name, script) => {
    const commands = script
      .replace(/\\\n\s*/g, ' ')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => /(^|[\s|(;{])curl\s/.test(line))
      .filter((line) => /(--connect-timeout|--max-time|\s-m)\s+[0-9]*\.[0-9]/.test(line))
    for (const command of commands) expect(command).toMatch(/LC_ALL=C curl\s/)
  })

  it('the guard finds the hook POSTs it is meant to cover', () => {
    const joined = buildManagedScript('claude', null).replace(/\\\n\s*/g, ' ')
    expect(joined.match(/curl\s[^\n]*--connect-timeout\s+0\.5/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })
})
