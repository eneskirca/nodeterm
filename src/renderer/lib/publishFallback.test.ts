import { describe, expect, it } from 'vitest'
import type { GitResult } from '@shared/types'
import {
  GH_LOGIN_COMMAND,
  pendingPublish,
  publishOutcome,
  retryPublishAfterLogin,
  startPublishRetry
} from './publishFallback'

const AUTH: GitResult = { ok: false, message: 'Sign in to GitHub to publish.', needsAuth: true }
const OK: GitResult = { ok: true, message: 'Published to GitHub.' }

/** A publish that answers from a script, recording how often it ran. */
function scripted(...answers: GitResult[]) {
  let calls = 0
  return {
    publish: async () => answers[Math.min(calls++, answers.length - 1)],
    calls: () => calls
  }
}

const instant = { sleep: async () => undefined }

describe('publishOutcome', () => {
  it('asks for a terminal login that is ONE bare command — no chaining, quoting or repo name', () => {
    const o = publishOutcome(AUTH)
    expect(o).toEqual({ kind: 'login', terminalCmd: 'gh auth login' })
    expect(GH_LOGIN_COMMAND).not.toMatch(/&&|;|'|"|\|/)
  })
  it('passes success and non-auth failures through', () => {
    expect(publishOutcome(OK)).toEqual({ kind: 'published' })
    expect(publishOutcome({ ok: false, message: 'name taken' })).toEqual({ kind: 'error', message: 'name taken' })
  })
})

describe('retryPublishAfterLogin', () => {
  it('retries while gh still needs auth, and stops at the first success', async () => {
    const s = scripted(AUTH, AUTH, OK, OK)
    const r = await retryPublishAfterLogin(s.publish, { signal: new AbortController().signal, ...instant })
    expect(r).toEqual({ kind: 'published' })
    expect(s.calls()).toBe(3)
  })
  it('stops on a failure that is not about auth', async () => {
    const s = scripted(AUTH, { ok: false, message: 'Invalid repository name.' })
    const r = await retryPublishAfterLogin(s.publish, { signal: new AbortController().signal, ...instant })
    expect(r).toEqual({ kind: 'error', message: 'Invalid repository name.' })
  })
  it('gives up when the window closes', async () => {
    let t = 0
    const s = scripted(AUTH)
    const r = await retryPublishAfterLogin(s.publish, {
      signal: new AbortController().signal,
      timeoutMs: 10,
      now: () => t,
      sleep: async () => {
        t += 4
      }
    })
    expect(r).toEqual({ kind: 'timeout' })
    expect(s.calls()).toBe(2)
  })
  it('is cancelled by its signal before the next attempt', async () => {
    const ctl = new AbortController()
    const s = scripted(AUTH)
    const r = await retryPublishAfterLogin(s.publish, {
      signal: ctl.signal,
      sleep: async () => {
        if (s.calls() === 1) ctl.abort()
      }
    })
    expect(r).toEqual({ kind: 'cancelled' })
    expect(s.calls()).toBe(1)
  })
})

describe('startPublishRetry', () => {
  it('is single-flight per folder, outlives its caller, and clears itself when done', async () => {
    const first = startPublishRetry('/r', scripted(AUTH).publish, undefined, { sleep: () => new Promise(() => {}) })
    expect(pendingPublish('/r')).toBe(first)
    let seen: unknown
    const second = startPublishRetry('/r', scripted(OK).publish, (r) => (seen = r), instant)
    expect(pendingPublish('/r')).toBe(second)
    await expect(second.done).resolves.toEqual({ kind: 'published' })
    expect(seen).toEqual({ kind: 'published' })
    expect(pendingPublish('/r')).toBeUndefined()
  })
})
