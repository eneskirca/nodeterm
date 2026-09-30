// Nothing type-checks that main actually wires the forward lifecycle: a dropped listener compiles,
// passes every unit test, and leaves forwards open after their node closed. Pinned at source level,
// the same remedy hook-verified-parity.test.ts uses for the same class of hole.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const read = (p: string): string => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')

describe('dev-ports wiring', () => {
  const main = read('main/index.ts')
  it('the desktop registers the service with a forward leg over the project master', () => {
    expect(main).toMatch(/startDevPortsService\(\{[\s\S]{0,1500}forward: \{[\s\S]{0,300}refForProject/)
  })
  it("the local scan asks the app's own tmux, like session memory (a bundled-only tmux is not on PATH)", () => {
    expect(main).toMatch(/startDevPortsService\(\{\s*tmuxBin: \(\) => ptyManager\.getTmuxBin\(\)/)
  })
  it('a node\'s session ending cancels its forwards; a disconnect forgets the project\'s', () => {
    expect(main).toMatch(/ptyManager\.onSessionEnded\(\(nodeId\) => void devPorts\.registry\?\.nodeEnded\(nodeId\)\)/)
    expect(main).toMatch(/onSshProjectStatus\([\s\S]{0,200}projectDisconnected\(e\.projectId\)/)
  })
  it('the Server Edition does not register it (its bridge answers unsupported)', () => {
    expect(read('server/index.ts')).not.toMatch(/startDevPortsService/)
    expect(read('renderer/bridge/ws-bridge.ts')).not.toMatch(/devPortsScan/)
  })
  it('the canvas node header and the card modal both draw the chip; Canvas runs the scanner', () => {
    expect(read('renderer/nodes/TerminalNode.tsx')).toMatch(/<PortsChip/)
    expect(read('renderer/components/kanban/CardModal.tsx')).toMatch(/<PortsChip/)
    expect(read('renderer/canvas/Canvas.tsx')).toMatch(/useDevPortScanner\(/)
  })
})
