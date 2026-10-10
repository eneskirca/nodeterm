// The two emitters of the curl-config escaping rule must agree byte for byte: `headerLine` (POSIX
// sh, inside every generated hook client) and `curlHeaderConfigLine` (Node). The sh one has a fast
// path that skips its `tr -d` strip when the value is made only of [A-Za-z0-9._-] — the strip is
// the identity there, and skipping it saves a command substitution and a pipeline on every hook
// event. Using the Node emitter as the oracle proves both branches apply the one rule.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { curlHeaderConfigLine, curlHeaderConfigSh } from './hook-curl-config-sh'

const HAS_SH = !spawnSync('sh', ['-c', 'exit 0']).error

/** Run the generated emitter for one value, passed through the environment like the real ones. */
function shEmit(value: string): string {
  const fn = curlHeaderConfigSh('nt_test_headers', [{ name: 'X-Test', valueRef: '$NT_TEST_VALUE' }], '# test')
  const res = spawnSync('sh', ['-c', `${fn}\nnt_test_headers`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', NT_TEST_VALUE: value }
  })
  expect(res.status).toBe(0)
  return res.stdout
}

/** Values that must take the STRIP path, each holding the one character its label names. */
const STRIP_CASES: [string, string, string][] = [
  ['a double quote', 'abc"def', '"'],
  ['a backslash', 'abc\\def', '\\'],
  ['a carriage return', 'abc\rdef', '\r'],
  ['a line feed', 'abc\ndef', '\n'],
  ['a trailing CRLF', 'token\r\n', '\r']
]

describe.skipIf(!HAS_SH)('curl header config: the sh emitter matches the Node oracle', () => {
  it.each([
    ['a real node token (fast path)', 'kid1.mac-ABC_def'],
    ['a UUID bearer (fast path)', '3f2a9c1e-77b0-4c1d-9a51-0f5e2d8b6c43'],
    ['an empty value', ''],
    ['a space and other punctuation', 'a b;c$d'],
    ['non-ASCII letters', 'tökén']
  ])('%s', (_label, value) => {
    expect(shEmit(value)).toBe(curlHeaderConfigLine('X-Test', value))
  })

  it.each(STRIP_CASES)('%s is stripped exactly as the Node emitter strips it', (_label, value, ch) => {
    // A fixture that silently lost its character (an unescaped backslash, a normalised CRLF) would
    // take the fast path and prove nothing about the strip.
    expect(value).toContain(ch)
    const out = shEmit(value)
    expect(out).toBe(curlHeaderConfigLine('X-Test', value))
    // The value BETWEEN the config line's own quotes must not keep the character.
    const emitted = out.slice('header = "X-Test: '.length, -'"\n'.length)
    expect(emitted).not.toContain(ch)
  })
})
