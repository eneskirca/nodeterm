/**
 * Redaction for agent-filed issue reports — the last thing that runs before text from this
 * machine is published to a repository we must assume is PUBLIC (ours is).
 *
 * The threat is not a hostile agent. It is an ordinary one pasting the thing it was looking at:
 * a refusal message, a stack trace, the command it ran, the tail of a failing build. Those carry
 * `/Users/<realname>/`, `root@prod-db-01`, `ANTHROPIC_API_KEY=sk-ant-…` and a bearer header,
 * routinely, with nobody awake to read the draft.
 *
 * WHAT THIS CAN AND CANNOT DO — state it plainly, because the caps and the consent gate are sized
 * against the second half:
 *  - It catches SHAPED secrets: things with a recognisable prefix, a delimiter, or a known layout.
 *  - It cannot catch SEMANTIC ones. `the acme-bank fraud-scoring worker crashed` is a customer
 *    name, an internal service and a business fact, and no pattern will ever see it. That is why
 *    this file is one layer of several (default-off per-project switch, caps, dedupe, a label and
 *    a body that says a machine wrote it) and never the sole reason publishing is safe.
 *
 * Every rule is ordered: multi-line key blocks first (they contain base64 that later rules would
 * mangle into something unrecognisable), then keyed secrets, then assignments, then paths, then
 * endpoints. Rules are written without nested quantifiers — this runs on agent-supplied text of
 * bounded but attacker-influenced length, so a backtracking blowup would be a hang in the hook
 * server's request path.
 */

/** What replaced a secret. One token, so a reader of the issue can see redaction happened. */
export const REDACTED = '[redacted]'

/** The whole body GitHub receives, after the header and footer are added around the report. */
export const REPORT_BODY_MAX = 8_000

/** A single block of pasted machine output (a log tail, a stack trace) inside one report. */
export const REPORT_EXCERPT_MAX = 2_000

export interface RedactionResult {
  text: string
  /** Which rule names fired, deduplicated and in rule order — surfaced to the agent (and the
   *  dry-run preview) so a human can see WHAT was stripped without seeing the secret. */
  rules: string[]
  /** True when the text was shortened by a cap rather than only rewritten. */
  truncated: boolean
}

interface Rule {
  name: string
  pattern: RegExp
  replace: string | ((...args: string[]) => string)
}

/**
 * Home directories → `~`. The USERNAME is the secret here, not the prefix: `/home/` tells a reader
 * nothing, `/home/jdoe` names a person. So the segment is replaced and the tail is kept — a report
 * whose paths all collapsed to `~` would lose the very detail that makes it actionable.
 *
 * Runs AFTER the endpoint rule, and the order is load-bearing: a macOS home directory is routinely
 * the user's e-mail address (`/Users/jane.doe@corp.com/`). Home-first would eat `/Users/jane.doe`
 * and leave `~@corp.com`, which no later rule matches — publishing the employer's domain. Endpoint
 * -first takes the whole address, and the `/Users/` prefix that remains names nobody.
 */
const HOME_RULES: Rule[] = [
  {
    name: 'home-path',
    // POSIX: /home/<user>, /Users/<user>, and /root (which has no user segment to drop).
    pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]{1,64}/g,
    replace: '~'
  },
  {
    name: 'home-path',
    pattern: /(?<![A-Za-z0-9._-])\/root(?=\/|\b)/g,
    replace: '~'
  },
  {
    name: 'home-path',
    // Windows, both separators, drive letter free.
    pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._ -]{1,64}/g,
    replace: '~'
  }
]

/**
 * Keyed secrets. Each entry is a vendor prefix with a documented shape, so the match is anchored
 * on the prefix rather than on entropy: an entropy heuristic on a 2 KB log tail redacts commit
 * SHAs, UUIDs and base64 payloads, which is how a redactor turns a useful report into noise.
 */
const SECRET_RULES: Rule[] = [
  {
    name: 'private-key',
    // Multi-line, non-greedy, and FIRST: the base64 body inside would otherwise be chewed by the
    // rules below into fragments that no longer look like a key — which reads as "no secret here".
    pattern: /-----BEGIN[A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8000}?-----END[A-Z ]{0,40}PRIVATE KEY-----/g,
    replace: `${REDACTED} (private key)`
  },
  {
    name: 'github-token',
    // Classic PAT / OAuth / server / refresh tokens, and the fine-grained `github_pat_` form.
    //
    // NO leading `\b`, deliberately, and this was a caught bug rather than a preference: `\b`
    // needs a non-word character before `ghp_`, so a token glued to the end of a preceding word —
    // which is what a clamped log line, a wrapped column or a concatenated URL produces — was not
    // matched at all. These prefixes carry an underscore and never occur inside an English word,
    // so the false-positive cost of dropping the anchor is nil and the miss it prevents is a live
    // credential published to a public repository. Rules whose prefix COULD be a word fragment
    // (`sk-` inside `disk-…`, `eyJ` inside `keyJ…`) keep their anchor for the opposite reason.
    pattern: /(?:gh[pousr]_[A-Za-z0-9]{16,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
    replace: REDACTED
  },
  {
    name: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,200}\b/g,
    replace: REDACTED
  },
  {
    name: 'openai-key',
    // `sk-` plus a long run. Kept after the Anthropic rule so `sk-ant-…` is named precisely.
    pattern: /\bsk-[A-Za-z0-9_-]{20,200}\b/g,
    replace: REDACTED
  },
  {
    name: 'aws-key-id',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g,
    replace: REDACTED
  },
  {
    name: 'slack-token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,200}\b/g,
    replace: REDACTED
  },
  {
    name: 'jwt',
    // Three base64url segments. Bounded per segment; a JWT is a bearer credential in its own right.
    pattern: /\beyJ[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{10,2000}\b/g,
    replace: REDACTED
  },
  {
    name: 'bearer-header',
    // `Authorization: Bearer x`, `-H 'authorization: token x'`, `--header "Bearer x"`.
    //
    // The keyword alone is too weak a signal to redact on: `token authentication failed` puts a
    // 14-character ENGLISH WORD where a credential would be, and blanking it turns a diagnostic
    // sentence into a mystery. So the candidate must also LOOK like a credential — carry a digit
    // or one of the separator characters real keys use. A lowercase word never does.
    pattern: /\b(authorization\s*[:=]\s*|Bearer\s+|token\s+)(['"]?)([A-Za-z0-9._~+/=-]{12,400})/gi,
    replace: (m: string, lead: string, quote: string, value: string) =>
      /[0-9._~+/=-]/.test(value) ? `${lead}${quote}${REDACTED}` : m
  }
]

/**
 * `NAME=value` where NAME looks like an environment variable. The NAME is kept: "the report says
 * DATABASE_URL was set" is exactly the diagnostic detail, and the value is exactly the part that
 * must not be published.
 *
 * Scoped to UPPER_SNAKE names of 4+ characters so ordinary prose (`X=1`, `n=3`) and shell
 * comparisons survive. A value is consumed up to whitespace, or to the closing quote when quoted —
 * `FOO="a b c"` must not leave `b c` behind.
 */
const ENV_RULE: Rule = {
  name: 'env-value',
  pattern: /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{4,})=(?:"[^"\n]{0,400}"|'[^'\n]{0,400}'|[^\s"'][^\s]{0,400})/g,
  replace: (_m: string, name: string) => `${name}=${REDACTED}`
}

/**
 * `user@host` — SSH endpoints and e-mail addresses in one rule, because they are the same shape
 * and both are things this machine should not publish on the user's behalf. The USER is dropped
 * and the host kept in the SSH case only when it is not itself a domain; simpler and safer to drop
 * the whole token, since a bare internal hostname (`prod-db-01`) is also an infrastructure leak.
 */
const ENDPOINT_RULE: Rule = {
  name: 'endpoint',
  pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?/g,
  replace: REDACTED
}

const RULES: Rule[] = [...SECRET_RULES, ENV_RULE, ENDPOINT_RULE, ...HOME_RULES]

/**
 * Apply every rule. Pure, order-fixed, and it reports WHICH classes fired so the caller can tell a
 * human "3 secrets and a home path were removed" without quoting any of them.
 */
export function redactReportText(input: string): RedactionResult {
  const fired: string[] = []
  let text = input
  for (const rule of RULES) {
    // `replace` with a global regex has no lastIndex hazard (it is reset per call), and each rule
    // sees the output of the previous one on purpose: a bearer header inside a home path should be
    // caught by both.
    const next = text.replace(rule.pattern, rule.replace as never)
    if (next !== text && !fired.includes(rule.name)) fired.push(rule.name)
    text = next
  }
  return { text, rules: fired, truncated: false }
}

/**
 * Clamp a block of pasted machine output and redact it.
 *
 * The TAIL is kept, not the head: a stack trace's cause, a build's first error and a CLI's refusal
 * all land at the end, and a head-clamped 2 KB of a 40 KB log is almost always the part nobody
 * needed. The elision is marked so a reader knows bytes are missing.
 */
export function redactExcerpt(input: string, max = REPORT_EXCERPT_MAX): RedactionResult {
  const redacted = redactReportText(input)
  if (redacted.text.length <= max) return redacted
  // Clamp AFTER redacting: clamping first can cut a token in half and leave a recognisable
  // fragment of a secret that no rule matches any more.
  const tail = redacted.text.slice(redacted.text.length - max)
  return {
    text: `…[${redacted.text.length - max} earlier characters omitted]\n${tail}`,
    rules: redacted.rules,
    truncated: true
  }
}

/**
 * Final gate on the assembled body. Redacts again — the assembled body contains text the caller
 * built around the excerpt, and a caller that interpolated a raw value must not get past this —
 * then clamps to `REPORT_BODY_MAX`, keeping the HEAD here because the assembled body leads with
 * the machine-written context a reader needs first.
 */
export function redactBody(input: string, max = REPORT_BODY_MAX): RedactionResult {
  const redacted = redactReportText(input)
  if (redacted.text.length <= max) return redacted
  const head = redacted.text.slice(0, max)
  return {
    text: `${head}\n\n…[report truncated at ${max} characters]`,
    rules: redacted.rules,
    truncated: true
  }
}
