import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC } from '../shared/ipc'
import { isHostOnlyChannel } from '../shared/host-control'

/**
 * "Open recent" is served by BOTH shells, and nothing type-checks that: a shell that forgets
 * `registerRecentConversationsIpc()` compiles, and its renderer's list silently never appears
 * (the bridge answers `{ok:false}`, which the start screen draws as nothing). Pinned at source level.
 */
const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('recent conversations wiring', () => {
  it('both shells register the core handler', () => {
    expect(read('main/index.ts')).toMatch(/^\s+registerRecentConversationsIpc\(\)$/m)
    expect(read('server/index.ts')).toMatch(/^\s+registerRecentConversationsIpc\(\)$/m)
  })

  it('the preload and the browser bridge both reach the channel', () => {
    expect(read('preload/index.ts')).toContain('ipcRenderer.invoke(IPC.recentConversationsList')
    const bridge = read('renderer/bridge/ws-bridge.ts')
    expect(bridge).toContain('client.request(IPC.recentConversationsList')
    expect(bridge).toContain('...buildRecentConversationsApi(client)')
  })

  it('a relay peer may never list the host’s conversation history', () => {
    expect(isHostOnlyChannel(IPC.recentConversationsList)).toBe(true)
  })
})
