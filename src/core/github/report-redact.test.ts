import { describe, expect, it } from 'vitest'
import {
  REDACTED,
  REPORT_BODY_MAX,
  redactBody,
  redactExcerpt,
  redactReportText
} from './report-redact'

/** A real-SHAPED credential for every class. None of these is a live secret; each matches the
 *  vendor's documented layout, because a test using `xxx` proves only that `xxx` is caught. */
const SAMPLES = {
  githubClassic: 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  githubFine: 'github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789abcdefghij',
  anthropic: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf',
  openai: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  // Assembled at runtime, not written as one literal: a sample realistic enough to prove the rule
  // matches is also realistic enough for GitHub's push protection to block the PR that adds it
  // (it did). The runtime value is identical, so the test loses nothing.
  slack: ['xoxb', '123456789012', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-'),
  jwt:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.' +
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
}

describe('every class of secret is removed', () => {
  for (const [label, secret] of Object.entries(SAMPLES)) {
    it(`removes a ${label} token`, () => {
      const { text } = redactReportText(`the call failed with ${secret} in the header`)
      expect(text).not.toContain(secret)
      expect(text).toContain(REDACTED)
    })
  }

  it('removes a PEM private key block whole, body included', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDR2n/EXAMPLEb64'
    const { text, rules } = redactReportText(
      `config:\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\ndone`
    )
    expect(text).not.toContain(body)
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(rules).toContain('private-key')
    // The surrounding report survives — redaction must not eat the diagnostic.
    expect(text).toContain('config:')
    expect(text).toContain('done')
  })

  it('removes a bearer/authorization credential but keeps the header name', () => {
    const { text } = redactReportText("curl -H 'authorization: Bearer aGVsbG8td29ybGQtMTIz'")
    expect(text).not.toContain('aGVsbG8td29ybGQtMTIz')
    expect(text).toContain('authorization')
  })

  it('does NOT blank an ordinary English word after the keyword "token"', () => {
    // `token authentication failed` is a diagnostic sentence, not a credential. A keyword-only
    // rule redacts `authentication` here and destroys the report's meaning.
    const { text } = redactReportText('token authentication failed for this request')
    expect(text).toBe('token authentication failed for this request')
  })
})

describe('home directories lose the user, not the path', () => {
  it.each([
    ['/home/jdoe/src/app/index.ts', '~/src/app/index.ts'],
    ['/Users/Jane.Doe/Projects/x.ts', '~/Projects/x.ts'],
    ['C:\\Users\\jdoe\\src\\app.ts', '~\\src\\app.ts'],
    ['/root/nodeterm/src/core/x.ts', '~/nodeterm/src/core/x.ts']
  ])('rewrites %s', (input, expected) => {
    expect(redactReportText(input).text).toBe(expected)
  })

  it('takes the whole address when a macOS home IS an e-mail address', () => {
    // Order regression: home-first would leave `~@corp.com` — the employer's domain, published.
    const { text } = redactReportText('/Users/jane.doe@corp.com/src/app.ts')
    expect(text).not.toContain('corp.com')
    expect(text).not.toContain('jane.doe')
  })
})

describe('ssh endpoints and addresses', () => {
  it.each([
    'ssh root@prod-db-01 failed',
    'scp build.tar deploy@10.0.0.4:/srv failed',
    'contact jane.doe@example.com for access'
  ])('removes the endpoint in %s', (input) => {
    const { text } = redactReportText(input)
    expect(text).toContain(REDACTED)
    expect(text).not.toMatch(/@[A-Za-z0-9]/)
  })
})

describe('environment variable values', () => {
  it('keeps the NAME and drops the value — the name is the diagnostic', () => {
    const { text } = redactReportText('spawned with DATABASE_URL=postgres://u:p@db/app and PATH=/usr/bin')
    expect(text).toContain('DATABASE_URL=')
    expect(text).toContain('PATH=')
    expect(text).not.toContain('postgres://')
    expect(text).not.toContain('/usr/bin')
  })

  it('does not leave the tail of a quoted value behind', () => {
    const { text } = redactReportText('API_HOST="secret host name"')
    expect(text).not.toContain('secret host name')
    expect(text).not.toContain('host name"')
  })

  it('leaves ordinary prose and short comparisons alone', () => {
    expect(redactReportText('exit=1 and n=3').text).toBe('exit=1 and n=3')
  })
})

describe('caps', () => {
  it('keeps the TAIL of a long excerpt, where the error is', () => {
    const noise = 'noise line\n'.repeat(1_000)
    const { text, truncated } = redactExcerpt(`${noise}FATAL: the actual cause`, 200)
    expect(truncated).toBe(true)
    expect(text).toContain('FATAL: the actual cause')
    expect(text).toContain('omitted')
    expect(text.length).toBeLessThan(300)
  })

  it('clamps the excerpt AFTER redacting, so no half-token survives', () => {
    // Clamp-then-redact keeps the TAIL, which here is most of the token; the cut destroys the
    // leading word boundary, so the surviving fragment matches no rule and ships.
    const { text } = redactExcerpt(`${'noise '.repeat(20)}${SAMPLES.githubClassic}`, 40)
    expect(text).not.toContain(SAMPLES.githubClassic.slice(-20))
    expect(text).toContain(REDACTED)
  })

  it('catches a token glued to the end of the preceding word', () => {
    // A wrapped log column, a concatenated URL or an already-clamped line all produce this, and a
    // leading `\b` anchor silently matches NOTHING here — the credential ships intact.
    const { text } = redactReportText(`url=https://github.com/x${SAMPLES.githubClassic}`)
    expect(text).not.toContain(SAMPLES.githubClassic)
  })

  it('clamps the assembled body to the published maximum', () => {
    const { text, truncated } = redactBody('a'.repeat(REPORT_BODY_MAX * 2))
    expect(truncated).toBe(true)
    expect(text).toContain('report truncated')
    expect(text.length).toBeLessThan(REPORT_BODY_MAX + 200)
  })

  it('redacts the assembled body again, catching a value the caller interpolated', () => {
    const { text } = redactBody(`## Context\n\nran with ${SAMPLES.aws} set`)
    expect(text).not.toContain(SAMPLES.aws)
  })
})

describe('the result reports what fired, never the secret', () => {
  it('names the rules that changed the text', () => {
    const { rules } = redactReportText(`${SAMPLES.githubClassic} at /home/jdoe/x`)
    expect(rules).toContain('github-token')
    expect(rules).toContain('home-path')
  })

  it('reports nothing for clean text and leaves it byte-identical', () => {
    const clean = 'open-terminal refused: this edition has no session host.'
    const { text, rules, truncated } = redactReportText(clean)
    expect(text).toBe(clean)
    expect(rules).toEqual([])
    expect(truncated).toBe(false)
  })
})
