// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(__dirname, 'ModalTerminal.tsx'), 'utf8')

describe('ModalTerminal delivers the node launch command', () => {
  it('claims the one-shot launch so it cannot race the canvas node', () => {
    expect(SRC).toContain('claimNodeLaunch(nodeId)')
    expect(SRC).toContain('deliverCommand(')
    expect(SRC).toContain('updateNodeData(nodeId, { initialCommand: undefined })')
  })

  it('releases a claim that never started so a remount can try again', () => {
    expect(SRC).toContain('if (!started) releaseNodeLaunch(nodeId)')
  })

  it('seeds with hasInitialCommand when the live spawn still carries the CLI line', () => {
    expect(SRC).toContain('hasInitialCommand: !!spawn.initialCommand')
  })

  it('the off-screen Mesa park cannot claim the launch (mayLaunch)', () => {
    expect(SRC).toContain('mayLaunch = true')
    expect(SRC).toContain("mayLaunch && spawn.launchMode !== 'runtime'")
  })

  it('a Mesa attach-only viewer still publishes session-ready after the shell settles', () => {
    expect(SRC).toContain('whenShellSettled(() => markViewerSessionReady(nodeId))')
    expect(SRC).toContain('markViewerSessionReady')
  })

  it('accepts a themePatch so Mesa can recolor the emulator canvas', () => {
    expect(SRC).toContain('themePatch')
    expect(SRC).toContain('term.options.theme = { ...term.options.theme, ...themePatch }')
  })
})
