// Forces a decision whenever the relay API gains a channel: every IPC.* a relay tab can send must
// be VIEW, COMMENT or reviewed-EDITOR_ONLY. Also pins that the allowlists name real channels.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../../shared/ipc'
import { VIEW, COMMENT, EDITOR_ONLY, VIEW_EVENTS } from './access-policy'
import { HOSTED_VIEW_METHODS, HOSTED_COMMENT_METHODS } from '../../shared/hosted-access'
import type { HostedRole } from '../../shared/types'
import type { TeamRole } from './team-store'

const ROOT = path.resolve(__dirname, '../../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const BUILDERS = ['buildRealApi', 'buildFilesApi', 'buildGitHubApi', 'buildAgentApi', 'buildCanvasApi', 'buildPresenceApi', 'buildClaudeApi', 'buildHostedApi']

function body(src: string, fn: string): string {
  const start = src.indexOf(`export function ${fn}(`)
  if (start < 0) throw new Error(`builder ${fn} not found — update BUILDERS`)
  const next = src.indexOf('\nexport function ', start + 1)
  return src.slice(start, next < 0 ? undefined : next)
}

describe('access-policy guard', () => {
  const ipcValues = new Set((Object.values(IPC) as unknown[]).filter((v): v is string => typeof v === 'string'))
  it('every allowlisted method is a real IPC channel', () => {
    for (const m of [...Object.keys(VIEW), ...Object.keys(COMMENT), ...EDITOR_ONLY]) expect(ipcValues.has(m), m).toBe(true)
  })
  it('every VIEW / COMMENT method carries a declared argument check', () => {
    for (const [m, check] of [...Object.entries(VIEW), ...Object.entries(COMMENT)]) expect(typeof check, m).toBe('function')
  })
  it('no channel is decided twice', () => {
    const view = new Set(Object.keys(VIEW))
    for (const m of Object.keys(COMMENT)) expect(view.has(m), `${m} is in VIEW and COMMENT`).toBe(false)
    for (const m of EDITOR_ONLY) {
      expect(Object.hasOwn(VIEW, m) || Object.hasOwn(COMMENT, m), `${m} is allowlisted AND editor-only`).toBe(false)
    }
  })
  it('every event a non-editor may receive is a real IPC channel', () => {
    for (const ch of Object.keys(VIEW_EVENTS)) expect(ipcValues.has(ch), ch).toBe(true)
  })
  it('every relay-API channel has been decided', () => {
    const ws = read('src/renderer/bridge/ws-bridge.ts')
    const relay = read('src/renderer/bridge/relay-api.ts')
    const src = BUILDERS.map((b) => body(ws, b)).join('\n') + relay
    const names = new Set([...src.matchAll(/IPC\.([A-Za-z0-9_]+)/g)].map((x) => x[1]))
    const undecided = [...names]
      .map((n) => (IPC as Record<string, unknown>)[n])
      .filter((v): v is string => typeof v === 'string')
      .filter((v) => !Object.hasOwn(VIEW, v) && !Object.hasOwn(COMMENT, v) && !EDITOR_ONLY.has(v))
    expect(undecided, `classify these in access-policy.ts: ${undecided.join(', ')}`).toEqual([])
  })
  it('the renderer\'s mirror names exactly the host\'s viewer and commenter channels', () => {
    // A channel the host opens to viewers that the mirror does not name silently disappears from a
    // viewer's tab (refused locally); one the mirror names that the host does not is refused anyway.
    expect([...HOSTED_VIEW_METHODS].sort()).toEqual(Object.keys(VIEW).sort())
    expect([...HOSTED_COMMENT_METHODS].sort()).toEqual(Object.keys(COMMENT).sort())
  })
  it('canvas:authority is left Editor-only by omission: a relay tab answers it locally, never over the wire', () => {
    // A hosted tab's governed set is every project bound to its own connection (relay-api.ts), so
    // no relay builder names the channel and the guard above never forces a decision. Recorded
    // here instead: a non-editor may neither ask it nor receive its change event.
    expect(Object.hasOwn(VIEW, IPC.canvasAuthority) || Object.hasOwn(COMMENT, IPC.canvasAuthority)).toBe(false)
    expect(Object.hasOwn(VIEW_EVENTS, IPC.canvasAuthorityChanged)).toBe(false)
    expect(read('src/renderer/bridge/relay-api.ts')).not.toMatch(/IPC\.canvasAuthority/)
  })
  it('the renderer\'s role names are the team store\'s', () => {
    const toShared = (r: TeamRole): HostedRole => r
    const toCore = (r: HostedRole): TeamRole => r
    expect([toShared('viewer'), toCore('owner')]).toEqual(['viewer', 'owner'])
  })
})
