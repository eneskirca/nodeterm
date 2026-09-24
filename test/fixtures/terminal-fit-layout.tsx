import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { quantizeCharSize } from '../../src/renderer/terminal/char-size-quantize'

const frame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()))
const assert = (ok: boolean, message: string): void => { if (!ok) throw new Error(message) }

async function run(): Promise<void> {
  document.getElementById('root')!.innerHTML = `<div class="term-node" style="width:1282px;height:901px">
    <div style="height:36px;flex-shrink:0"></div>
    <div class="term-node__body"><div class="term-node__xterm"></div></div></div>`
  const node = document.querySelector<HTMLElement>('.term-node')!
  const host = document.querySelector<HTMLElement>('.term-node__xterm')!
  const body = document.querySelector<HTMLElement>('.term-node__body')!
  const term = new Terminal({ fontSize: 13, lineHeight: 1, fontFamily: 'monospace' })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)
  quantizeCharSize(term)
  await new Promise<void>(resolve => term.write('preserved-session-marker', resolve))
  const measurements: { height: number; dpr: number; rows: number; cell: number; screenHeight: number; available: number; overflow: number; clipOverflow: number }[] = []
  try {
    for (const height of [901, ...Array.from({ length: 31 }, (_, i) => 880 + i), 901]) {
      node.style.height = height + 'px'
      await frame()
      fit.fit()
      assert(Array.from({ length: term.buffer.active.length }, (_, i) =>
        term.buffer.active.getLine(i)?.translateToString(true)).some(line =>
        line?.includes('preserved-session-marker')), 'buffer lost during resize')
      await new Promise<void>(resolve => term.write('\x1b[' + term.rows + ';1Hbottom gyjp', resolve))
      await frame()
      const cell = (term as any)._core._renderService.dimensions.css.cell.height as number
      const screen = host.querySelector('.xterm-screen')!.getBoundingClientRect()
      const clip = body.getBoundingClientRect()
      const padding = parseFloat(getComputedStyle(host).paddingBottom)
      const measurement = { height, dpr: devicePixelRatio, rows: term.rows, cell,
        screenHeight: screen.height, available: clip.bottom - padding - screen.top,
        overflow: screen.bottom - (clip.bottom - padding), clipOverflow: screen.bottom - clip.bottom }
      measurements.push(measurement)
      assert(Math.abs(host.getBoundingClientRect().height - clip.height) < 0.05, 'host no longer covers body')
      assert(term.buffer.active.getLine(term.buffer.active.baseY + term.rows - 1)?.translateToString(true).startsWith('bottom') === true, 'bottom missing')
    }
    assert(measurements.every(m => m.overflow <= 0.05), JSON.stringify(measurements.reduce((a, b) => a.overflow > b.overflow ? a : b)))
    document.getElementById('result')!.textContent = 'PASS ' + JSON.stringify(measurements)
  } finally { term.dispose() }
}
run().catch(error => { document.getElementById('result')!.textContent = 'FAIL ' + error.message })
