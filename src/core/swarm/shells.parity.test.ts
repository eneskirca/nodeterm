import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../../..')

function src(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n')
}

describe('swarm service both-shells wiring', () => {
  it('desktop and Server Edition boot the same host-owned swarm service', () => {
    const main = src('src/main/index.ts')
    const server = src('src/server/index.ts')
    const bridge = src('src/renderer/bridge/ws-bridge.ts')
    for (const file of [main, server]) {
      expect(file).toContain("import { startSwarmService } from '../core/swarm/swarm-service'")
      expect(file).toContain('const swarmService = startSwarmService({')
      expect(file).toContain('swarmService.onAgentEvent')
      expect(file).toContain('getNode:')
      expect(file).toContain('agentSessionId: n.agentSessionId')
      expect(file).toContain('getSettings:')
      expect(file).toContain('broadcast:')
      expect(file).toContain('ensureWorktree:')
      expect(file).toContain('adoptOrAddWorktree')
      expect(file).toContain('gitService.runGit')
      expect(file).toContain('homeDir:')
      expect(file).toContain('sendText:')
      expect(file).toContain('paneCommand:')
    }
    expect(bridge).toContain('export function buildSwarmApi')
    expect(bridge).toContain('...buildSwarmApi(client)')
    expect(bridge).toContain('onChanged:')
    expect(bridge).toContain('caps:')
    expect(src('src/shared/ipc.ts')).toContain("swarmCaps: 'swarm:caps'")
    expect(src('src/shared/ipc.ts')).toContain("swarmSetWorkspace: 'swarm:set-workspace'")
    expect(bridge).toContain('setWorkspaceRoot:')
    expect(src('src/shared/ipc.ts')).toContain("swarmNoteIdle: 'swarm:note-idle'")
    expect(src('src/preload/index.ts')).toContain('IPC.swarmNoteIdle')
    expect(bridge).toContain('noteIdle:')
  })
})
