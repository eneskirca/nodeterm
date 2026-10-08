// Real backend/emulator/client code; only the native process is an explicit byte recorder.
// This does not claim Windows ConPTY or kernel PTY acceptance (the native proof is separate).
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { NativeWindowsPane } from '../../../../../src/core/native-windows-pane'
import { SessionHostClient } from '../../../../../src/core/session-host-client'
import { SessionHostPty } from '../../../../../src/core/session-host-pty'
import { bootComposedHost } from '../../../../../src/session-host/__fixtures__/composed-host'
import type { NativeScrollResult } from '../../../../../src/shared/history-scroll'
import type { ComposedInput, ComposedInputResult } from '../../../../../src/shared/composed-input'

export async function composedBackendFixture(root: string, kind: string, emit: (event: object) => void) {
  const mode = process.env.FIXTURE_COMPOSED_MODE ?? 'on'
  const historyMode = process.env.FIXTURE_HISTORY_SCROLL
  const historyMouse = historyMode === 'default' ? '\x1b[?1000h\x1b[?1006l' :
    historyMode === 'sgr' ? '\x1b[?1000h\x1b[?1006h' :
    historyMode === 'pixels' ? '\x1b[?1000h\x1b[?1016h' : '\x1b[?1000l\x1b[?1006l'
  if (historyMode && !['off', 'default', 'sgr', 'pixels'].includes(historyMode)) throw new Error('Invalid history fixture mode')
  const historyOutput = Array.from({ length: 200 }, (_, i) => `H${String(i).padStart(4, '0')} pre-attach Ω retained row`).join('\r\n') +
    '\r\n' + 'wrapped-'.repeat(12) + '\r\n\x1b[?1049hcurrent alternate fixture ready\r\n' + historyMouse
  const emitWrites = (writes: Array<{ data: string; at: number }>): void => {
    for (const write of writes) emit({ event: 'composed-native-write', backend: kind, ...write })
  }
  let submit: (input: ComposedInput, current: () => boolean) => Promise<ComposedInputResult>
  let control: (command: string) => Promise<void>
  let close: () => void
  let scroll: (up: boolean, lines: number, capture: boolean, current: () => boolean) => Promise<NativeScrollResult>
  if (kind === 'native-windows') {
    const writes: Array<{ data: string; at: number }> = []
    const pane = new NativeWindowsPane({ pid: 123, write: data => writes.push({ data, at: performance.now() }) },
      { cols: 80, rows: 24, scrollback: historyMode ? 400 : 100 })
    if (historyMode) pane.recordOutput(historyOutput)
    pane.recordOutput('\x1b[?20'); pane.recordOutput(mode === 'off' ? '04lfixture ready\r\n' : '04hfixture ready\r\n')
    submit = async (input, current) => { const start = writes.length
      const result = await pane.submitComposed(input, current); emitWrites(writes.slice(start)); return result }
    scroll = async (up, lines, capture, current) => { const start = writes.length
      const result = await pane.scrollForHistory(up, lines, capture, current)
      const delta = writes.slice(start); emitWrites(delta)
      emit({ event: 'history-native-result', backend: kind, status: result.status, writes: delta.map(write => write.data) })
      return result }
    control = async (command) => {
      const modes: Record<string, string> = {
        'history-mouse-default': '\x1b[?1000h\x1b[?1006l\x1b[?1016l',
        'history-mouse-sgr': '\x1b[?1000h\x1b[?1006h',
        'history-mouse-pixels': '\x1b[?1000h\x1b[?1016h',
        'history-mouse-off': '\x1b[?1000l\x1b[?1002l\x1b[?1003l',
        'history-more-output': '\x1b[?1049l' + Array.from({ length: 10_000 }, (_, i) => `new live row ${i}`).join('\r\n')
      }
      if (!Object.hasOwn(modes, command)) throw new Error('Unknown native history fixture control')
      pane.recordOutput(modes[command]); await pane.capture(true)
    }
    close = () => pane.dispose()
  } else if (kind === 'session-host') {
    fs.mkdirSync(root, { recursive: true })
    const host = await bootComposedHost(root, process.argv[1] + '-composed-host.cjs', mode)
    let ownedPainter: SessionHostPty | undefined
    const stop = async (): Promise<void> => { ownedPainter?.destroy(); await host.close() }
    const terminate = (): void => { void stop().then(() => process.exit(0), () => process.exit(1)) }
    process.once('SIGTERM', terminate)
    try {
      const client = new SessionHostClient({ userDataDir: host.dataDir })
      if (historyMode) host.spawnOptions.env.NT_HISTORY_SCROLL_OUTPUT = historyOutput
      const painter = new SessionHostPty(client, 'android-owned', host.spawnOptions, historyMode ? 400 : 100)
      ownedPainter = painter
      let output = ''
      let modeTimer: ReturnType<typeof setTimeout> | undefined
      const modeObserved = new Promise<void>((resolve, reject) => {
        modeTimer = setTimeout(() => reject(new Error('Native history fixture output deadline')), 4000)
        painter.onData(data => { output += data; if (output.includes('fixture ready')) resolve() })
      })
      try { await Promise.all([painter.ready, modeObserved]) } finally { if (modeTimer) clearTimeout(modeTimer) }
      submit = async (input, current) => { const start = host.writes().length
        const result = await painter.submitComposed(input, current); emitWrites(host.writes().slice(start)); return result }
      scroll = async (up, lines, capture, current) => { const start = host.writes().length
        const result = await painter.scrollForHistory(up, lines, capture, current)
        const delta = host.writes().slice(start); emitWrites(delta)
        emit({ event: 'history-native-result', backend: kind, status: result.status, writes: delta.map(write => write.data) })
        return result }
      control = async (command) => {
        if (!['history-mouse-default', 'history-mouse-sgr', 'history-mouse-pixels', 'history-mouse-off', 'history-more-output'].includes(command))
          throw new Error('Unknown session-host history fixture control')
        let waiting = true
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { waiting = false; reject(new Error('History fixture control deadline')) }, 4000)
          painter.onData(data => { if (waiting && data.includes('history-control-ready:' + command)) {
            waiting = false; clearTimeout(timer); resolve()
          } })
          painter.write(command)
        })
      }
      close = () => { void stop() }
    } catch (error) {
      // Startup failure must reap this child before the parent exits and loses descendant proof.
      try { await stop() } finally { process.removeListener('SIGTERM', terminate) }
      throw error
    }
  } else throw new Error('Unknown explicit composed backend fixture')
  emit({ event: 'composed-backend-ready', backend: kind, nativeBoundary: 'byte-recorder', actualBackend: true })
  return { submit, scroll, control, close }
}
