// src/shared/relay-join-code.test.ts
import { describe, it, expect } from 'vitest'
import { JOIN_CODE_PREFIX, isJoinCode, peekJoinCode } from './relay-join-code'

/** base64url of a JSON object, the way the core encoder writes a join code. */
const encode = (o: unknown): string =>
  JOIN_CODE_PREFIX + Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url')

describe('join code (renderer-safe half)', () => {
  it('recognizes the prefix, trimmed, and nothing else', () => {
    expect(isJoinCode(`  ${JOIN_CODE_PREFIX}abc \n`)).toBe(true)
    expect(isJoinCode('nodeterm://pair?code=abc')).toBe(false)
    expect(isJoinCode('')).toBe(false)
    expect(isJoinCode(undefined as unknown as string)).toBe(false)
  })

  it('peeks the team id and label a code CLAIMS, without trusting them', () => {
    expect(peekJoinCode(encode({ v: 1, hostId: 'H1', label: 'box', hostPublicKeyB64: 'k' }))).toEqual({ hostId: 'H1', label: 'box' })
    // A code whose label is missing still names its team.
    expect(peekJoinCode(encode({ v: 1, hostId: 'H1' }))).toEqual({ hostId: 'H1', label: '' })
  })

  it('answers null for anything it cannot read, and never throws', () => {
    expect(peekJoinCode('nodeterm://pair?code=abc')).toBeNull()
    expect(peekJoinCode(`${JOIN_CODE_PREFIX}%%%`)).toBeNull()
    expect(peekJoinCode(`${JOIN_CODE_PREFIX}`)).toBeNull()
    expect(peekJoinCode(encode({ v: 1 }))).toBeNull()
    expect(peekJoinCode(encode({ v: 1, hostId: 7 }))).toBeNull()
    expect(peekJoinCode(encode({ v: 1, hostId: 'x'.repeat(65) }))).toBeNull()
    expect(peekJoinCode(encode(['H1']))).toBeNull()
    expect(peekJoinCode(encode(null))).toBeNull()
  })
})
