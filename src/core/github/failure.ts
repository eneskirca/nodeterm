/**
 * The ONE place this module decides what a failed GitHub call means.
 *
 * The distinction that matters to a user is "you are signed out" against "GitHub could not be
 * asked". Only the first is fixed by signing in, and saying it for the second sends the user to
 * re-authenticate an account that is fine — while the real cause (a rate limit, an outage, a
 * dropped network) goes unnamed. So `unauthorized` is reserved for an answer GitHub actually gave
 * about the credential: a 401, or a 403 that is not a rate limit. Everything that merely failed to
 * produce an answer is `unreachable` or `rate-limited`, and must never be reported as signed out.
 *
 * It reads the error's SHAPE (`code`, `status`, `retryAt`) rather than its class, so an error that
 * lost its prototype on the way (a structured clone, a re-thrown copy) still classifies the same.
 */

export type GitHubFailure =
  | { kind: 'unauthorized' }
  | { kind: 'rate-limited'; retryAt?: number }
  | { kind: 'unreachable' }
  /** GitHub answered 404: the thing is gone, or this token may not see it. */
  | { kind: 'not-found' }
  /** Not a statement about GitHub at all: configuration, approval, a programming error. */
  | { kind: 'other' }

/** A credential check that could not reach an answer. Thrown instead of reporting "signed out". */
export class GitHubReachabilityError extends Error {
  constructor(
    readonly code: 'github-unreachable' | 'rate-limited',
    readonly retryAt?: number
  ) {
    super(code)
  }
}

export function classifyGitHubFailure(error: unknown): GitHubFailure {
  if (!error || typeof error !== 'object') return { kind: 'other' }
  const value = error as { code?: unknown; status?: unknown; retryAt?: unknown }
  switch (value.code) {
    case 'rate-limited':
      return typeof value.retryAt === 'number' && Number.isFinite(value.retryAt)
        ? { kind: 'rate-limited', retryAt: value.retryAt }
        : { kind: 'rate-limited' }
    case 'insufficient-permission':
      return { kind: 'unauthorized' }
    case 'request-failed':
      if (value.status === 401) return { kind: 'unauthorized' }
      return value.status === 404 ? { kind: 'not-found' } : { kind: 'unreachable' }
    case 'malformed-response':
    case 'response-too-large':
    case 'github-unreachable':
      return { kind: 'unreachable' }
    default:
      return { kind: 'other' }
  }
}
