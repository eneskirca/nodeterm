// The relay host's attach decides where a phone-opened session runs from a resolver the desktop
// shell wires (`ptyManager.setRelayNodeResolver`). It is optional in core — the Server Edition has
// no relay host and wires none — so dropping the desktop's wire compiles, passes every unit test,
// and silently restores the bare LOCAL attach that made an SSH project's node a local shell. Pinned
// at source level, the remedy this repo uses for that class of hole (codex-chat-wiring.test.ts).
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('relay attach routing is wired in the desktop shell', () => {
  it('feeds core this machine’s placements, live masters and SSH-project identity', () => {
    const src = read('main/index.ts')
    expect(src).toMatch(/ptyManager\.setRelayNodeResolver\(\{\n\s*placements: \(nodeId\) => workspaceStore\.relayNodePlacements\(nodeId\),\n\s*refFor: \(scopeId\) => sshProjectManager\?\.spawnRefFor\(scopeId\),\n\s*projectIsRemote: \(projectId\) => !!workspaceStore\.projectTargetInfo\(projectId\)\?\.ssh\n\s*\}\)/)
  })
  it('the relay host attaches only through core’s decision, never the bare local attach', () => {
    const src = read('main/remote/host-service.ts')
    // The phone's project hint (and, when asked, its jailed launch request) is all that crosses.
    expect(src).toMatch(
      /pty\.prepareRelayAttach\(\n\s*nodeId,\n\s*\{ cols, rows \},\n\s*launchReq \? \{ projectId: projectHint, launch: launchReq \} : \{ projectId: projectHint \}\n\s*\)/
    )
    expect(src).not.toMatch(/pty\.attachDetached\(/)
  })
  it('a Team Access guest’s create in an SSH project is forced requireRemote', () => {
    expect(read('main/index.ts')).toMatch(
      /projectCwd: \(projectId\) => workspaceStore\.localCwdForProject\(projectId\),\n\s*projectIsRemote: \(projectId\) => !!workspaceStore\.projectTargetInfo\(projectId\)\?\.ssh,/
    )
  })
  it('a connection reports setup-done exactly where it reports connected', () => {
    const src = read('main/remote-ssh/ssh-project.ts')
    expect(src).toMatch(/entry\.setupDone = true\n\s*this\.emitStatus\(\{ projectId, status: 'connected' \}\)/)
  })
})
