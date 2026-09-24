import { afterEach, expect, it, vi } from 'vitest'
import { buildSync } from 'esbuild'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import type { Terminal } from '@xterm/xterm'
import { patchImeModeSwitch } from './ime-mode-switch'

// Execute the dependency's real composition helper, not a hand-written copy of its algorithm.
// Bundling in memory resolves xterm's source aliases without writing into node_modules.
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => { window: { document: Document } } }
const src = resolve(dirname(require.resolve('@xterm/xterm/package.json')), 'src')
const built = buildSync({
  entryPoints: [resolve(src, 'browser/input/CompositionHelper.ts')], bundle: true,
  platform: 'node', format: 'cjs', write: false,
  alias: { common: resolve(src, 'common'), browser: resolve(src, 'browser') },
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true } }
})
const mod = { exports: {} as { CompositionHelper: new (...args: unknown[]) => any } }
new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports)
const document = new JSDOM('').window.document
function fixture(patch = true) {
  const textarea = document.createElement('textarea')
  const sent: string[] = []
  const helper = new mod.exports.CompositionHelper(textarea, document.createElement('div'), {}, {}, {
    triggerDataEvent: (s: string) => sent.push(s)
  }, {})
  helper.updateCompositionElements = () => {} // geometry is unrelated to the input lifecycle
  const term = { _core: { _compositionHelper: helper } } as unknown as Terminal
  if (patch) { patchImeModeSwitch(term); patchImeModeSwitch(term) }
  return { textarea, helper, sent }
}
async function compose(f: ReturnType<typeof fixture>, text = '中文') {
  f.helper.compositionstart()
  f.textarea.value += text
  f.helper.compositionupdate({ data: text })
  await vi.advanceTimersByTimeAsync(1)
}
afterEach(() => vi.useRealTimers())
it('CONTROL: upstream sends twice when Caps Lock precedes compositionend', async () => {
  vi.useFakeTimers(); const f = fixture(false)
  await compose(f)
  f.helper.keydown({ key: 'CapsLock', keyCode: 20 })
  f.helper.compositionend(); await vi.runAllTimersAsync()
  expect(f.sent).toEqual(['中文', '中文'])
})
it('Caps Lock leaves one commit to compositionend and permits intentional repetition', async () => {
  vi.useFakeTimers(); const f = fixture()
  for (let i = 0; i < 2; i++) {
    await compose(f)
    expect(f.helper.keydown({ key: 'CapsLock', keyCode: 20 })).toBe(false)
    expect(f.sent).toHaveLength(i)
    f.helper.compositionend(); await vi.runAllTimersAsync()
  }
  expect(f.sent).toEqual(['中文', '中文'])
})
it('ordinary Enter still commits synchronously before terminal submission', async () => {
  vi.useFakeTimers(); const f = fixture()
  await compose(f)
  expect(f.helper.keydown({ key: 'Enter', keyCode: 13 })).toBe(true)
  expect(f.sent).toEqual(['中文'])
  expect(f.helper.keydown({ key: 'CapsLock', keyCode: 20 })).toBe(true)
})
