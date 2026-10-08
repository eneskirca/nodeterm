// Explicit node-pty recorder boundary for socket/Android interop; no kernel/ConPTY claim.
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
export function spawn(_file: string, _args: string[], options: { env: Record<string, string> }) {
  let output: ((data: string) => void) | undefined
  let exit: ((event: { exitCode: number }) => void) | undefined
  return {
    pid: process.pid,
    onData(cb: (data: string) => void) { output = cb
      setTimeout(() => {
        if (options.env.NT_HISTORY_SCROLL_OUTPUT !== undefined) cb(options.env.NT_HISTORY_SCROLL_OUTPUT)
        else { cb('\x1b[?20'); cb(options.env.NT_COMPOSED_MODE === 'off' ? '04lfixture ready\r\n' : '04hfixture ready\r\n') }
      }, 10) },
    onExit(cb: (event: { exitCode: number }) => void) { exit = cb },
    write(data: string) {
      fs.appendFileSync(options.env.NT_COMPOSED_WRITE_LOG, JSON.stringify({ data, at: performance.now() }) + '\n')
      if (data === 'mode-off') output?.('\x1b[?2004l')
      if (data === 'history-mouse-sgr') output?.('\x1b[?1000h\x1b[?1006h')
      if (data === 'history-mouse-default') output?.('\x1b[?1000h\x1b[?1006l\x1b[?1016l')
      if (data === 'history-mouse-pixels') output?.('\x1b[?1000h\x1b[?1016h')
      if (data === 'history-mouse-off') output?.('\x1b[?1000l\x1b[?1002l\x1b[?1003l')
      if (data === 'history-more-output') output?.('\x1b[?1049l' + 'fixture later output\r\n'.repeat(10_000))
      if (['history-mouse-default', 'history-mouse-sgr', 'history-mouse-pixels', 'history-mouse-off', 'history-more-output'].includes(data))
        output?.(`\r\nhistory-control-ready:${data}\r\n`)
    },
    resize() {}, pause() {}, resume() {},
    kill() { setTimeout(() => exit?.({ exitCode: 0 }), 0) }
  }
}
