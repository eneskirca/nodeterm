import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { testTmpDir } from '../src/core/test-tmp'
import {
  EXCLUDE_LABEL,
  dropExcluded,
  parseExcludeList,
  SECTIONS,
  TYPE_SECTIONS,
  UNMAPPED_SECTION,
  BODY_LIMIT,
  sectionForType,
  parseConventional,
  parseEntry,
  isReleaseBump,
  linkifyIssues,
  renderEntry,
  parseGeneratedBody,
  groupEntries,
  highlightsBlock,
  highlightsPathFor,
  renderNotes
  // @ts-expect-error — plain .mjs repo tooling, deliberately outside the typechecked projects.
} from './release-notes.mjs'

const REPO = 'eneskirca/nodeterm'
const pr = (n: number) => `https://github.com/${REPO}/pull/${n}`

// A trimmed copy of a real `POST /releases/generate-notes` body for v0.3.7..v0.3.8. Every case
// the generator has to get right is in here: a feat, a fix, an internal test PR, a dependabot
// bump, the PREVIOUS tag's release-bump PR, and two PR titles with no conventional prefix.
const GENERATED = `## What's Changed
* feat(notch): let the user place the HUD capsule (side + vertical offset) by @eneskirca in ${pr(796)}
* chore(release): v0.3.7 by @eneskirca in ${pr(795)}
* fix(license): never print the token TTL as the subscription end date (#800) by @eneskirca in ${pr(801)}
* Messaging: the unproven-owner refusal was advising a remedy that cannot work by @eneskirca in ${pr(803)}
* test(control): settings doc claims pinned to the mechanism by @eneskirca in ${pr(806)}
* build(deps-dev): bump the dev-dependencies group across 1 directory with 3 updates by @dependabot[bot] in ${pr(697)}

## New Contributors
* @ezwep made their first contribution in ${pr(579)}

**Full Changelog**: https://github.com/${REPO}/compare/v0.3.7...v0.3.8
`

const render = (over: Record<string, unknown> = {}) =>
  renderNotes({ tag: 'v0.3.8', prev: 'v0.3.7', repo: REPO, body: GENERATED, highlights: '', ...over })

describe('type → section table', () => {
  it('is the ONE mapping, and every value names a real section', () => {
    const keys = new Set(SECTIONS.map((s: { key: string }) => s.key))
    for (const [type, section] of Object.entries(TYPE_SECTIONS)) {
      expect(keys, `${type} maps to an unknown section`).toContain(section)
    }
    expect(keys).toContain(UNMAPPED_SECTION)
  })

  it('puts features first and internal work last', () => {
    expect(SECTIONS.map((s: { key: string }) => s.key)).toEqual(['new', 'improved', 'fixed', 'internal'])
    expect(SECTIONS.at(-1).collapsed).toBe(true)
    expect(SECTIONS.slice(0, -1).every((s: { collapsed: boolean }) => !s.collapsed)).toBe(true)
  })

  it('routes the audience types the way a reader expects', () => {
    expect(sectionForType('feat')).toBe('new')
    expect(sectionForType('perf')).toBe('improved')
    expect(sectionForType('fix')).toBe('fixed')
    expect(sectionForType('revert')).toBe('fixed')
    for (const internal of ['test', 'refactor', 'chore', 'ci', 'build', 'docs']) {
      expect(sectionForType(internal), internal).toBe('internal')
    }
  })

  it('is case-insensitive, because a hand-typed title says Fix as often as fix', () => {
    expect(sectionForType('FIX')).toBe('fixed')
    expect(sectionForType('Feat')).toBe('new')
  })

  // The load-bearing half of "never vanish".
  it('lands an unmapped type in a VISIBLE section, not in the collapsed one', () => {
    const section = sectionForType('wip')
    expect(section).toBe(UNMAPPED_SECTION)
    const target = SECTIONS.find((s: { key: string }) => s.key === section)
    expect(target.collapsed).toBe(false)
  })

  it('treats a missing type the same way', () => {
    expect(sectionForType(undefined)).toBe(UNMAPPED_SECTION)
    expect(sectionForType('')).toBe(UNMAPPED_SECTION)
  })
})

describe('conventional-commit parsing', () => {
  it('splits type, scope and subject', () => {
    expect(parseConventional('feat(notch): place the HUD capsule')).toEqual({
      type: 'feat',
      scope: 'notch',
      breaking: false,
      subject: 'place the HUD capsule'
    })
  })

  it('reads a bang as breaking', () => {
    expect(parseConventional('feat(api)!: drop the old channel').breaking).toBe(true)
  })

  it('accepts a type with no scope', () => {
    expect(parseConventional('docs: rewrite the setup section').scope).toBe(null)
  })

  // "Messaging: …" parses as the SHAPE of a conventional commit but "messaging" is not a type.
  // Stripping that prefix would throw away the only context the line has.
  it('refuses a prefix that is not a known type, so the title stays whole', () => {
    expect(parseConventional('Messaging: the unproven-owner refusal advises a remedy that cannot work')).toBe(null)
    const line = renderEntry({ title: 'Messaging: the refusal cannot work', author: 'x', pr: 803, prUrl: pr(803) }, REPO)
    expect(line).toContain('Messaging: the refusal cannot work')
  })

  it('is not fooled by a colon later in the subject', () => {
    expect(parseConventional('the wheel over a banner: whose is it?')).toBe(null)
  })
})

describe('entry parsing and links', () => {
  it('pulls title, author and PR number out of a generated line', () => {
    expect(parseEntry(`* fix(eco): prove the agent owns the pane by @eneskirca in ${pr(824)}`)).toEqual({
      title: 'fix(eco): prove the agent owns the pane',
      author: 'eneskirca',
      pr: 824,
      prUrl: pr(824)
    })
  })

  it('reads a bot author', () => {
    expect(parseEntry(`* build(deps): bump by @dependabot[bot] in ${pr(697)}`).author).toBe('dependabot[bot]')
  })

  it('returns null for a line that is not an entry', () => {
    expect(parseEntry('**Full Changelog**: https://example.com')).toBe(null)
    expect(parseEntry('* @ezwep made their first contribution')).toBe(null)
  })

  it('links the PR on every entry', () => {
    const line = renderEntry({ title: 'feat(notch): place the capsule', author: 'eneskirca', pr: 796, prUrl: pr(796) }, REPO)
    expect(line).toContain(`[#796](${pr(796)})`)
    expect(line).toContain('[@eneskirca](https://github.com/eneskirca)')
    expect(line).toContain('**notch** —')
  })

  it('links an issue the subject names, alongside the PR', () => {
    const line = renderEntry(
      { title: 'fix(license): never print the token TTL (#800)', author: 'eneskirca', pr: 801, prUrl: pr(801) },
      REPO
    )
    expect(line).toContain(`[#800](https://github.com/${REPO}/issues/800)`)
    expect(line).toContain(`[#801](${pr(801)})`)
  })

  it('links every issue shape the repo actually writes', () => {
    expect(linkifyIssues('(part 1 of #767)', REPO)).toBe(`(part 1 of [#767](https://github.com/${REPO}/issues/767))`)
    expect(linkifyIssues('route the send (issue #435)', REPO)).toContain('[#435]')
    expect(linkifyIssues('regression from #789', REPO)).toContain('[#789]')
  })

  it('leaves a reference that is already a link alone', () => {
    const already = `see [#800](https://github.com/${REPO}/issues/800)`
    expect(linkifyIssues(already, REPO)).toBe(already)
  })

  it('does not turn a colour or a fragment into an issue link', () => {
    expect(linkifyIssues('the accent is #1e90ff', REPO)).toBe('the accent is #1e90ff')
    expect(linkifyIssues('see docs/x.md#2 for the rule', REPO)).toBe('see docs/x.md#2 for the rule')
  })

  it('does not wrap a bot name in a markdown link it would break', () => {
    const line = renderEntry({ title: 'build(deps): bump', author: 'dependabot[bot]', pr: 697, prUrl: pr(697) }, REPO)
    expect(line).toContain('@dependabot[bot]')
    expect(line).not.toContain('[@dependabot[bot]]')
  })
})

describe('grouping', () => {
  it('drops the previous tag’s version-bump PR and nothing else', () => {
    expect(isReleaseBump('chore(release): v0.3.7')).toBe(true)
    expect(isReleaseBump('chore(deps): bump vite')).toBe(false)
    const { entries } = parseGeneratedBody(GENERATED)
    const { groups, dropped } = groupEntries(entries)
    expect(dropped).toBe(1)
    const all = Object.values(groups).flat() as Array<{ pr: number }>
    expect(all.map((e) => e.pr)).not.toContain(795)
    expect(all).toHaveLength(entries.length - 1)
  })

  it('keeps New Contributors out of the entry list', () => {
    const { entries, newContributors } = parseGeneratedBody(GENERATED)
    expect(entries.map((e: { pr: number }) => e.pr)).not.toContain(579)
    expect(newContributors).toEqual([`- @ezwep made their first contribution in ${pr(579)}`])
  })
})

describe('rendered notes', () => {
  it('orders the sections features-first, internal last and collapsed', () => {
    const out = render()
    const order = ['## New', '## Improved', '## Fixed', '<details>'].map((h) => out.indexOf(h))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order]).toEqual([...order].sort((a, b) => a - b))
    expect(out).toContain('<summary><strong>Internal changes</strong>')
  })

  it('collapses internal work but keeps it — it is not deleted', () => {
    const out = render()
    const details = out.slice(out.indexOf('<details>'))
    expect(details).toContain('[#806]')
    expect(details).toContain('[#697]')
    // …and the audience sections stay clean of it.
    expect(out.slice(0, out.indexOf('<details>'))).not.toContain('[#806]')
  })

  it('puts an unprefixed PR title in a visible section rather than dropping it', () => {
    const out = render()
    const visible = out.slice(0, out.indexOf('<details>'))
    expect(visible).toContain('Messaging: the unproven-owner refusal')
  })

  it('always ends with the full compare link', () => {
    expect(render()).toContain(`**Full Changelog**: https://github.com/${REPO}/compare/v0.3.7...v0.3.8`)
  })

  it('publishes a non-English title verbatim instead of guessing at it', () => {
    const body = `## What's Changed\n* fix(grok): usar session_summary como título by @xaviguardia in ${pr(784)}\n`
    const out = render({ body })
    expect(out).toContain('usar session_summary como título')
    expect(out).toContain('## Fixed')
  })

  it('carries New Contributors through', () => {
    expect(render()).toContain('## New contributors')
    expect(render()).toContain('@ezwep made their first contribution')
  })

  it('omits an empty section instead of printing an empty heading', () => {
    const body = `## What's Changed\n* fix(a): b by @x in ${pr(1)}\n`
    const out = render({ body })
    expect(out).toContain('## Fixed')
    expect(out).not.toContain('## New\n')
    expect(out).not.toContain('<details>')
  })
})

describe('the Highlights layer', () => {
  it('names the file CI looks for', () => {
    expect(highlightsPathFor('v0.3.8')).toBe('docs/release-notes/v0.3.8.md')
  })

  // THE load-bearing rule: no release may ever be blocked waiting for prose.
  it('renders the grouped list alone when the file is absent', () => {
    const out = render({ highlights: '' })
    expect(out).not.toContain('Highlights')
    expect(out.startsWith('## New')).toBe(true)
    expect(out).toContain('[#796]')
  })

  it('treats a whitespace-only file as absent', () => {
    expect(highlightsBlock('   \n\n  ')).toBe('')
    expect(render({ highlights: '\n \n' }).startsWith('## New')).toBe(true)
  })

  it('puts the curated block at the very top, above New', () => {
    const out = render({ highlights: 'Windows can pair with the phone over the relay now.' })
    expect(out.indexOf('## Highlights')).toBe(0)
    expect(out.indexOf('## Highlights')).toBeLessThan(out.indexOf('## New'))
    expect(out).toContain('Windows can pair with the phone over the relay now.')
  })

  it('does not add a heading when the file already starts with one', () => {
    const out = render({ highlights: '## What changed for you\n\nA sentence.' })
    expect(out.startsWith('## What changed for you')).toBe(true)
    expect(out).not.toContain('## Highlights')
  })
})

describe('truncation is never silent', () => {
  const many = (n: number, type: string) =>
    Array.from({ length: n }, (_, i) => `* ${type}(scope${i}): ${'a subject that is long enough to matter '.repeat(3)} by @eneskirca in ${pr(1000 + i)}`)

  it('keeps the whole list when it fits', () => {
    const body = `## What's Changed\n${many(40, 'fix').join('\n')}\n`
    const out = render({ body })
    expect(out.length).toBeLessThanOrEqual(BODY_LIMIT)
    expect(out).toContain('[#1039]')
  })

  it('when it must cut, it says what was cut and links the full compare view', () => {
    const body = `## What's Changed\n${many(20, 'feat').join('\n')}\n${many(900, 'chore').join('\n')}\n`
    const out = render({ body })
    expect(out.length).toBeLessThanOrEqual(BODY_LIMIT + 200)
    expect(out).toMatch(/internal changes \(tests, refactors, chores, dependency bumps\) are omitted/)
    expect(out).toContain(`https://github.com/${REPO}/compare/v0.3.7...v0.3.8`)
    // The audience sections survive the cut — they are the point of the notes.
    expect(out).toContain('## New')
    expect(out).toContain('[#1000]')
  })
})

describe('PRs labelled no-release-notes', () => {
  it('names the label once', () => {
    expect(EXCLUDE_LABEL).toBe('no-release-notes')
  })

  it('are left out entirely — not folded into Internal, not counted, not linked', () => {
    const out = render({ exclude: [796, 806] })
    expect(out).not.toContain('[#796]')
    expect(out).not.toContain('notch')
    expect(out).not.toContain('[#806]')
    expect(out).not.toContain('settings doc claims')
    // The internal fold counts what is left (the dependabot bump), not what was dropped.
    expect(out).toContain('<summary><strong>Internal changes</strong> (1)')
    // Everything else is untouched.
    expect(out).toContain('[#801]')
    expect(out).toContain('[#803]')
    expect(out).toContain('[#697]')
  })

  it('drop nothing when no PR is labelled', () => {
    expect(render({ exclude: [] })).toBe(render())
    expect(render({ exclude: [12345] })).toBe(render())
  })

  it('dropExcluded matches on the PR number only', () => {
    const entries = parseGeneratedBody(GENERATED).entries
    expect(dropExcluded(entries, new Set([801])).map((e: { pr: number }) => e.pr)).toEqual([796, 795, 803, 806, 697])
  })

  it('parseExcludeList reads gh --jq output or a comma list, ignoring blanks', () => {
    expect(parseExcludeList('1334\n1335\n\n')).toEqual([1334, 1335])
    expect(parseExcludeList('1334,1335, 1336')).toEqual([1334, 1335, 1336])
    expect(parseExcludeList('')).toEqual([])
  })

  it('the CLI drops them given --exclude, without asking GitHub for the label', () => {
    const dir = testTmpDir('nt-release-notes-')
    const bodyFile = path.join(dir, 'body.md')
    fs.writeFileSync(bodyFile, GENERATED)
    const r = spawnSync(
      process.execPath,
      [path.resolve(__dirname, 'release-notes.mjs'), '--tag', 'v0.3.8', '--prev', 'v0.3.7', '--repo', REPO,
        '--body-file', bodyFile, '--root', dir, '--exclude', '796,806'],
      { encoding: 'utf8', env: { ...process.env, PATH: '' } }
    )
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('[#801]')
    expect(r.stdout).not.toContain('[#796]')
    expect(r.stdout).not.toContain('[#806]')
  })
})
