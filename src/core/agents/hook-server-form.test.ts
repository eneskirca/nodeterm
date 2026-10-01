import { describe, it, expect } from 'vitest'
import { parseControlBody } from './hook-server'

const FORM = 'application/x-www-form-urlencoded'

describe('parseControlBody — form bodies from a native Windows curl', () => {
  // Git Bash hands the shim's argv to a native curl, which reads it in the ANSI code page: an
  // accented prompt arrives as windows-1252 bytes. It used to throw a URIError that surfaced as an
  // empty 204, and the open failed with no message at all.
  it('reads windows-1252 escapes instead of throwing', () => {
    const body = 'nodeId=n1&arg.prompt=n%E3o+edite%2C+s%F3+diga+%93oi%94'
    expect(parseControlBody(body, FORM).args).toEqual({ prompt: 'não edite, só diga “oi”' })
  })

  it('still reads UTF-8 escapes as UTF-8', () => {
    const body = 'nodeId=n1&arg.prompt=n%C3%A3o+%E2%86%92+sim'
    expect(parseControlBody(body, FORM).args).toEqual({ prompt: 'não → sim' })
  })

  // Field names come from the request: a `__proto__` field is an ordinary key, never a prototype.
  it('keeps a __proto__ field as an own key', () => {
    const { args } = parseControlBody('nodeId=n1&__proto__=x&arg.__proto__=y&arg.title=t', FORM)
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype)
    expect(Object.keys(args).sort()).toEqual(['__proto__', 'title'])
    expect(Object.getOwnPropertyDescriptor(args, '__proto__')?.value).toBe('y')
  })
})
