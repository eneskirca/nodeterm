import { describe, expect, it } from 'vitest'
import { shellSingleQuote, shellSplit } from './shell-quote'

describe('shellSingleQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shellSingleQuote('fix the bug')).toBe("'fix the bug'")
  })
  it("escapes embedded single quotes", () => {
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'")
  })
})

describe('shellSplit', () => {
  it('splits on whitespace', () => {
    expect(shellSplit('--model x --api-key foo')).toEqual(['--model', 'x', '--api-key', 'foo'])
  })
  it('preserves quoted substrings as single tokens', () => {
    expect(shellSplit("--msg 'hello world'")).toEqual(['--msg', 'hello world'])
  })
  it('handles double quotes', () => {
    expect(shellSplit('--x "a b" c')).toEqual(['--x', 'a b', 'c'])
  })
  it('honors backslash escapes', () => {
    expect(shellSplit('a\\ b c')).toEqual(['a b', 'c'])
  })
  it('returns [] for empty / whitespace input', () => {
    expect(shellSplit('')).toEqual([])
    expect(shellSplit('   ')).toEqual([])
  })
  it('does NOT perform shell variable expansion ($VAR stays literal)', () => {
    expect(shellSplit('$HOME/x')).toEqual(['$HOME/x'])
  })
})
