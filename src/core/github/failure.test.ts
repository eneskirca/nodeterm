import { describe, expect, it } from 'vitest'
import { GitHubClientError } from './client'
import { GitHubReachabilityError, classifyGitHubFailure } from './failure'
import { GitHubCoordinatorError } from './request-coordinator'

describe('classifyGitHubFailure', () => {
  it.each([
    ['a 401', new GitHubClientError('request-failed', 401), { kind: 'unauthorized' }],
    ['a non-rate-limit 403', new GitHubClientError('insufficient-permission', 403), { kind: 'unauthorized' }],
    ['a primary rate limit', new GitHubClientError('rate-limited', 403, 9_000), { kind: 'rate-limited', retryAt: 9_000 }],
    ['a secondary rate limit', new GitHubClientError('rate-limited', 429, 7_000), { kind: 'rate-limited', retryAt: 7_000 }],
    ['a capped coordinator wait', new GitHubCoordinatorError('rate-limited', 5_000), { kind: 'rate-limited', retryAt: 5_000 }],
    ['a network failure or timeout', new GitHubClientError('request-failed'), { kind: 'unreachable' }],
    ['a 502', new GitHubClientError('request-failed', 502), { kind: 'unreachable' }],
    ['a 404 (gone, or not visible to the token)', new GitHubClientError('request-failed', 404), { kind: 'not-found' }],
    ['a truncated body', new GitHubClientError('malformed-response'), { kind: 'unreachable' }],
    ['an oversized body', new GitHubClientError('response-too-large'), { kind: 'unreachable' }],
    ['an unreachable credential check', new GitHubReachabilityError('github-unreachable'), { kind: 'unreachable' }],
    ['a rate-limited credential check', new GitHubReachabilityError('rate-limited', 4_000), { kind: 'rate-limited', retryAt: 4_000 }],
    ['a configuration change', new GitHubCoordinatorError('configuration-changed'), { kind: 'other' }],
    ['an unrelated error', new Error('boom'), { kind: 'other' }],
    ['a non-error', 'boom', { kind: 'other' }]
  ])('classifies %s', (_name, error, expected) => {
    expect(classifyGitHubFailure(error)).toEqual(expected)
  })

  it('reads the error shape, so an error that crossed a structured clone still classifies', () => {
    expect(classifyGitHubFailure({ code: 'rate-limited', retryAt: 3 })).toEqual({ kind: 'rate-limited', retryAt: 3 })
    expect(classifyGitHubFailure({ code: 'request-failed', status: 401 })).toEqual({ kind: 'unauthorized' })
  })
})
