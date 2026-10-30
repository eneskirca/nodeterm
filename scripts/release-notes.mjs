// Release notes generator — repo tooling, not product code.
//
// Replaces the one-line `git log --no-merges --format='- %s'` step that used to write the
// release body. That line produced a chronological, unlinkable list in which a test tidy-up
// sat beside a new feature, because `--no-merges` drops exactly the commits that carry the
// PR number (issue #841).
//
// WHAT RESOLVES THE PR NUMBERS: GitHub's own generator
// (`POST /repos/{owner}/{repo}/releases/generate-notes`). It already maps every commit in the
// range back to the PR that merged it and prints `* <PR title> by @<author> in <url>`. We do
// not re-derive that from git — the platform's resolver is better than a second one here,
// and it has a side benefit worth writing down: it reads the **PR title**, which was reviewed,
// instead of the commit subject, which was not. Measured on v0.3.6..v0.3.7 — the Spanish
// commit subject `fix(grok): usar session_summary como título…` never reaches the notes,
// because PR #784's title is English.
//
// WHAT WE DO OURSELVES: the grouping. GitHub's `.github/release.yml` categories key off PR
// **labels**, and this repo does not label PRs by type (measured 2026-09-22: of six sampled
// PRs in the v0.3.8 range, only the dependabot one carried any label at all). A label-driven
// config would put every entry in one bucket, so the type comes from the conventional-commit
// prefix in the PR title instead, through the single table below.
//
// ONE WAY TO LEAVE A PR OUT: the `no-release-notes` label (EXCLUDE_LABEL). A PR carrying it is
// dropped entirely — not folded into Internal changes, not counted, not linked. It is for work that
// ships switched off and must not be announced before it is switched on; everything else, internal
// work included, stays in the notes. The labelled PRs are looked up per run (`gh api`), and a failed
// lookup fails the generator rather than publishing notes that silently ignored the label.
//
// NON-ENGLISH / OUT-OF-CONTEXT SUBJECTS are deliberately NOT special-cased here. This layer
// publishes what it is given, verbatim, in its mapped section; it never translates, rewrites
// or drops a line, because a detector that guesses wrong either mangles a real entry or
// silently loses a user-facing fix. Nothing here can ever become a headline: the only headline
// is `## Highlights`, which is a hand-written file reviewed in the release PR
// (docs/release-notes/<tag>.md). Absent file ⇒ the grouped list alone — no release is ever
// blocked waiting for prose.

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/**
 * Audience sections, in the order they are rendered. Features first, internal work kept but
 * collapsed — someone auditing a release must still be able to find the test and chore work.
 */
export const SECTIONS = [
  { key: 'new', title: 'New', collapsed: false },
  { key: 'improved', title: 'Improved', collapsed: false },
  { key: 'fixed', title: 'Fixed', collapsed: false },
  { key: 'internal', title: 'Internal changes', collapsed: true }
]

/**
 * THE one commit-type → section table. The workflow, the tests and any future reader use this
 * and nothing else. A type that is not in here does not vanish: see UNMAPPED_SECTION.
 */
export const TYPE_SECTIONS = {
  feat: 'new',
  feature: 'new',
  perf: 'improved',
  ui: 'improved',
  a11y: 'improved',
  fix: 'fixed',
  bugfix: 'fixed',
  hotfix: 'fixed',
  revert: 'fixed',
  security: 'fixed',
  docs: 'internal',
  doc: 'internal',
  test: 'internal',
  tests: 'internal',
  refactor: 'internal',
  style: 'internal',
  chore: 'internal',
  ci: 'internal',
  build: 'internal',
  deps: 'internal'
}

/**
 * Where an entry lands when its type is not in the table — including an entry with no
 * conventional prefix at all. Visible on purpose: an unmapped type must be read by a human and
 * either mapped or reworded, and it can only be read if it is on screen.
 */
export const UNMAPPED_SECTION = 'improved'

/** PRs carrying this label never reach the notes (see the header). */
export const EXCLUDE_LABEL = 'no-release-notes'

/** The version-bump commit for the PREVIOUS tag lands in every range. It is pure noise. */
const RELEASE_BUMP_RE = /^chore\(release\)/i

/**
 * GitHub's release body is capped (125k characters). Past this we drop the collapsed internal
 * section and say so, rather than letting the API reject the whole body.
 */
export const BODY_LIMIT = 110000

const ENTRY_RE = /^[*-]\s+(.*\S)\s+by\s+@([A-Za-z0-9._-]+(?:\[bot\])?)\s+in\s+(https:\/\/\S*?\/pull\/(\d+))\s*$/
const CONVENTIONAL_RE = /^([A-Za-z]+)(?:\(([^)]*)\))?(!?):\s*(\S.*)$/

/** Section key for a commit type. Unknown / missing type ⇒ UNMAPPED_SECTION. */
export function sectionForType(type) {
  if (!type) return UNMAPPED_SECTION
  return TYPE_SECTIONS[String(type).toLowerCase()] ?? UNMAPPED_SECTION
}

/**
 * Split a conventional-commit title. Returns null when the prefix is not a type we know:
 * "Messaging: the refusal was advising a remedy that cannot work" parses as the shape but
 * "messaging" is not a type, and stripping that prefix would throw away the only context the
 * line has. An unrecognised prefix therefore stays part of the subject, verbatim.
 */
export function parseConventional(title) {
  const m = CONVENTIONAL_RE.exec(title)
  if (!m) return null
  const type = m[1].toLowerCase()
  if (!(type in TYPE_SECTIONS)) return null
  return { type, scope: m[2] || null, breaking: m[3] === '!', subject: m[4] }
}

/** Parse one `* <title> by @<author> in <pr url>` line from GitHub's generated body. */
export function parseEntry(line) {
  const m = ENTRY_RE.exec(line)
  if (!m) return null
  return { title: m[1], author: m[2], prUrl: m[3], pr: Number(m[4]) }
}

export function isReleaseBump(title) {
  return RELEASE_BUMP_RE.test(title)
}

/**
 * Turn bare `#123` references into absolute links. Absolute because these notes are also
 * rendered outside github.com (nodeterm.dev), where nothing auto-links a bare `#123`.
 * `/issues/<n>` redirects to `/pull/<n>` when the number is a PR, so a wrong guess about which
 * kind of number it is costs nothing. A `#123` that is already inside a link is left alone.
 */
export function linkifyIssues(text, repo) {
  if (!repo) return text
  const parts = String(text).split(/(\[[^\]]*\]\([^)]*\))/g)
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/(^|[^\w/[])#(\d+)\b/g, (_all, lead, n) => `${lead}[#${n}](https://github.com/${repo}/issues/${n})`)
    )
    .join('')
}

function renderAuthor(author) {
  // `@dependabot[bot]` cannot be the text of a markdown link — the brackets close it early.
  return author.endsWith('[bot]') ? `@${author}` : `[@${author}](https://github.com/${author})`
}

/** One rendered bullet. Scope becomes a bold lead-in; the PR is always linked. */
export function renderEntry(entry, repo) {
  const parsed = parseConventional(entry.title)
  const subject = parsed ? parsed.subject : entry.title
  const scope = parsed?.scope ? `**${parsed.scope}** — ` : ''
  const breaking = parsed?.breaking ? '**Breaking:** ' : ''
  const body = `${breaking}${scope}${linkifyIssues(subject, repo)}`
  return `- ${body} · [#${entry.pr}](${entry.prUrl}) by ${renderAuthor(entry.author)}`
}

/**
 * Pull the entries out of GitHub's generated body. Anything that looks like an entry is taken,
 * whatever heading it sits under, EXCEPT the "New Contributors" block, which GitHub writes in
 * the same bullet shape and which we keep verbatim at the bottom.
 */
export function parseGeneratedBody(body) {
  const entries = []
  const newContributors = []
  const unparsed = []
  let inContributors = false
  for (const raw of String(body ?? '').split('\n')) {
    const line = raw.trimEnd()
    if (/^#{1,6}\s/.test(line)) {
      inContributors = /new contributors/i.test(line)
      continue
    }
    if (!/^[*-]\s/.test(line)) continue
    if (inContributors) {
      newContributors.push(line.replace(/^[*-]\s+/, '- '))
      continue
    }
    const entry = parseEntry(line)
    if (entry) entries.push(entry)
    else unparsed.push(line.replace(/^[*-]\s+/, '- '))
  }
  return { entries, newContributors, unparsed }
}

/** `entries` without the PRs numbered in `excluded` (an iterable of PR numbers). */
export function dropExcluded(entries, excluded) {
  const skip = new Set([...(excluded ?? [])].map(Number))
  return entries.filter((entry) => !skip.has(entry.pr))
}

/** PR numbers from `gh --jq` output (one per line) or a hand-typed comma list. */
export function parseExcludeList(text) {
  return String(text ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0)
}

/** Group parsed entries into the section order above. Release-bump entries are dropped. */
export function groupEntries(entries) {
  const groups = Object.fromEntries(SECTIONS.map((s) => [s.key, []]))
  let dropped = 0
  for (const entry of entries) {
    if (isReleaseBump(entry.title)) {
      dropped += 1
      continue
    }
    const parsed = parseConventional(entry.title)
    groups[sectionForType(parsed?.type)].push(entry)
  }
  return { groups, dropped }
}

/**
 * The curated block. The file owns its content; we only add the `## Highlights` heading when
 * the author did not start with a heading of their own.
 */
export function highlightsBlock(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return ''
  return /^#{1,6}\s/.test(trimmed) ? trimmed : `## Highlights\n\n${trimmed}`
}

function compareUrl(repo, prev, tag) {
  return prev ? `https://github.com/${repo}/compare/${prev}...${tag}` : null
}

/**
 * Render the whole body. Pure: every input is a value, so the tests exercise exactly what CI
 * publishes.
 */
export function renderNotes({ tag, prev, repo, body, highlights, exclude }) {
  const { entries, newContributors, unparsed } = parseGeneratedBody(body)
  const { groups } = groupEntries(dropExcluded(entries, exclude))
  for (const line of unparsed) groups[UNMAPPED_SECTION].push({ raw: line })
  const compare = compareUrl(repo, prev, tag)

  const renderSection = (section, { omitInternal }) => {
    const items = groups[section.key]
    if (!items.length) return null
    if (section.collapsed && omitInternal) {
      const more = compare ? ` See the [full changelog](${compare}) for all of them.` : ''
      return `_${items.length} internal change${items.length === 1 ? '' : 's'} (tests, refactors, chores, dependency bumps) are omitted here because the notes would exceed GitHub's release-body limit.${more}_`
    }
    const lines = items.map((item) => (item.raw ? item.raw : renderEntry(item, repo)))
    if (!section.collapsed) return `## ${section.title}\n\n${lines.join('\n')}`
    return [
      '<details>',
      `<summary><strong>${section.title}</strong> (${lines.length}) — tests, refactors, chores, dependency bumps</summary>`,
      '',
      lines.join('\n'),
      '',
      '</details>'
    ].join('\n')
  }

  const build = (omitInternal) => {
    const blocks = []
    const head = highlightsBlock(highlights)
    if (head) blocks.push(head)
    for (const section of SECTIONS) {
      const rendered = renderSection(section, { omitInternal })
      if (rendered) blocks.push(rendered)
    }
    if (newContributors.length) blocks.push(`## New contributors\n\n${newContributors.join('\n')}`)
    if (compare) blocks.push(`**Full Changelog**: ${compare}`)
    return blocks.join('\n\n') + '\n'
  }

  const full = build(false)
  if (full.length <= BODY_LIMIT) return full
  const trimmed = build(true)
  if (trimmed.length <= BODY_LIMIT) return trimmed
  const cut = trimmed.slice(0, BODY_LIMIT)
  const tail = compare ? `\n\n_Truncated to fit GitHub's release-body limit — see the [full changelog](${compare})._\n` : '\n'
  return cut + tail
}

// ---------------------------------------------------------------------------------------------
// CLI. Everything above is pure; everything below is the shell around it.
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1)
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[(i += 1)]
    else out[arg.slice(2)] = 'true'
  }
  return out
}

function generatedBody({ repo, tag, prev }) {
  const args = ['api', `repos/${repo}/releases/generate-notes`, '-f', `tag_name=${tag}`]
  if (prev) args.push('-f', `previous_tag_name=${prev}`)
  args.push('--jq', '.body')
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

/** The numbers of every PR (open or closed) carrying EXCLUDE_LABEL. Throws when the lookup fails. */
function excludedPrs({ repo }) {
  const out = execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repo}/issues?labels=${EXCLUDE_LABEL}&state=all&per_page=100`,
      '--jq',
      '.[] | select(.pull_request) | .number'
    ],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
  )
  return parseExcludeList(out)
}

export function highlightsPathFor(tag) {
  return `docs/release-notes/${tag}.md`
}

function readHighlights(tag, root) {
  const path = `${root ?? '.'}/${highlightsPathFor(tag)}`
  try {
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf8')
  } catch (err) {
    // Never fatal: an unreadable Highlights file must not hold up a release.
    console.error(`::warning::could not read ${path}: ${err.message}`)
    return ''
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const tag = args.tag
  const repo = args.repo
  if (!tag || !repo) {
    console.error(
      'usage: release-notes.mjs --tag <tag> --repo <owner/name> [--prev <tag>] [--out <file>] [--body-file <file>] [--exclude <pr,pr>]'
    )
    process.exit(2)
  }
  const prev = args.prev && args.prev !== 'true' ? args.prev : ''
  const body = args['body-file'] ? readFileSync(args['body-file'], 'utf8') : generatedBody({ repo, tag, prev })
  // `--exclude` stands in for the label lookup (tests, a hand run against a saved body).
  const exclude = args.exclude !== undefined ? parseExcludeList(args.exclude === 'true' ? '' : args.exclude) : excludedPrs({ repo })
  const notes = renderNotes({
    tag,
    prev,
    repo,
    body,
    highlights: readHighlights(tag, args.root),
    exclude
  })
  if (args.out && args.out !== 'true') writeFileSync(args.out, notes)
  else process.stdout.write(notes)
}

if (process.argv[1] && process.argv[1].endsWith('release-notes.mjs')) main()
