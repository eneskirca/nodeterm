// Forces a decision whenever the relay tab gains a channel: every IPC.* a relay tab can send must be
// allowlisted for a scoped guest (SCOPED, with its own argument check) or reviewed-and-refused
// (SCOPED_REFUSED). Also: nothing host-only is ever allowlisted.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../../shared/ipc'
import { isHostOnlyChannel } from '../../shared/host-control'
import { SCOPED, SCOPED_REFUSED } from './scoped-guest-policy'

const ROOT = path.resolve(__dirname, '../../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const BUILDERS = ['buildRealApi', 'buildFilesApi', 'buildGitHubApi', 'buildAgentApi', 'buildCanvasApi', 'buildPresenceApi', 'buildClaudeApi', 'buildHostedApi']

function body(src: string, fn: string): string {
  const start = src.indexOf(`export function ${fn}(`)
  if (start < 0) throw new Error(`builder ${fn} not found — update BUILDERS`)
  const next = src.indexOf('\nexport function ', start + 1)
  return src.slice(start, next < 0 ? undefined : next)
}

describe('scoped guest policy guard', () => {
  const ipcValues = new Set((Object.values(IPC) as unknown[]).filter((v): v is string => typeof v === 'string'))
  it('every decided method is a real IPC channel', () => {
    for (const m of [...Object.keys(SCOPED), ...SCOPED_REFUSED]) expect(ipcValues.has(m), m).toBe(true)
  })
  it('no channel is decided twice', () => {
    for (const m of SCOPED_REFUSED) expect(Object.hasOwn(SCOPED, m), `${m} is allowed AND refused`).toBe(false)
  })
  it('nothing host-only is allowlisted', () => {
    for (const m of Object.keys(SCOPED)) expect(isHostOnlyChannel(m), m).toBe(false)
  })
  it('every relay-API channel has been decided', () => {
    const ws = read('src/renderer/bridge/ws-bridge.ts')
    const relay = read('src/renderer/bridge/relay-api.ts')
    const src = BUILDERS.map((b) => body(ws, b)).join('\n') + relay
    const names = new Set([...src.matchAll(/IPC\.([A-Za-z0-9_]+)/g)].map((x) => x[1]))
    const undecided = [...names]
      .map((n) => (IPC as Record<string, unknown>)[n])
      .filter((v): v is string => typeof v === 'string')
      .filter((v) => !Object.hasOwn(SCOPED, v) && !SCOPED_REFUSED.has(v))
    expect(undecided, `classify these in scoped-guest-policy.ts: ${undecided.join(', ')}`).toEqual([])
  })
})
