import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
// Native X11 hit testing needs these optional system tools; never drive the user's display.
const available = process.platform === 'linux' &&
  spawnSync('sh', ['-c', 'command -v xvfb-run && command -v xauth && command -v python3'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('python3', ['-c', "import ctypes; ctypes.CDLL('libX11.so.6'); ctypes.CDLL('libXtst.so.6')"], { stdio: 'ignore' }).status === 0

it.skipIf(!available)('keeps the wordmark draggable and the scrolled tabs interactive in real Electron', () => {
  const profile = mkdtempSync(join(tmpdir(), 'nodeterm-tabbar-test-'))
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const run = spawnSync('xvfb-run', ['-a', require('electron'), '--no-sandbox',
      resolve('scripts/tabbar-drag.electron.cjs'), profile, resolve('src/renderer/styles.css')], {
      cwd: profile, env, encoding: 'utf8', timeout: 55_000, stdio: ['ignore', 'pipe', 'pipe']
    })
    expect(run.error).toBeUndefined()
    expect(run.status, run.stderr + run.stdout).toBe(0)
    const output = run.stdout
    const line = output.split('\n').find(line => line.startsWith('TABBAR_RESULT '))
    expect(line, output).toBeDefined()
    const result = JSON.parse(line!.slice('TABBAR_RESULT '.length))
    expect(result.cases).toBe(36)
    expect(result.nativeHitTests).toBe(181)
    console.log(result)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}, 60_000)
