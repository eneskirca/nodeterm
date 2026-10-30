# Release notes

Two layers make up what a GitHub Release says. `.github/workflows/release.yml`'s "Generate release
notes" step assembles them; `scripts/release-notes.mjs` is the generator and
`scripts/release-notes.test.ts` is its test.

## Layer 1 — the grouped list (automatic, always there)

GitHub's own generator resolves each commit in the range to the PR that merged it, and we regroup
that list by the conventional-commit type in the **PR title**:

| section | types |
|---|---|
| **New** | `feat`, `feature` |
| **Improved** | `perf`, `ui`, `a11y`, **and anything unmapped** |
| **Fixed** | `fix`, `bugfix`, `hotfix`, `revert`, `security` |
| **Internal changes** (collapsed) | `docs`, `test`, `refactor`, `style`, `chore`, `ci`, `build`, `deps` |

`TYPE_SECTIONS` in `scripts/release-notes.mjs` is the one copy of that table. A type nobody mapped —
or a PR title with no conventional prefix at all — lands in **Improved**, visible, with its title
intact. Nothing is ever dropped except the previous tag's `chore(release):` version bump and PRs
labelled **`no-release-notes`**.

### Leaving a PR out: the `no-release-notes` label

A PR carrying the `no-release-notes` label is left out of the generated notes entirely — not folded
into Internal changes, not counted. It exists for work that ships switched off and must not be
announced until it is switched on; ordinary internal work stays in the collapsed section. The
generator looks the labelled PRs up on every run (`EXCLUDE_LABEL` in `scripts/release-notes.mjs`),
and a failed lookup fails the generator rather than publishing notes that ignored the label. That
failure, like any other, takes the fallback (see Failure), and the fallback's commit list knows
nothing about labels — so it is withheld, and the notes are the compare link alone, whenever a
labelled PR was merged in the range or the lookup does not answer there either.

## Layer 2 — Highlights (optional, written by hand)

Add `docs/release-notes/<tag>.md` — three to five sentences about what actually changed for
someone using the app — and CI puts it at the top of the notes, under a `## Highlights` heading
(supply your own heading if you want a different one).

**If the file is absent, the release publishes with the grouped list alone.** That is the rule the
whole design hangs on: no release may ever be blocked waiting for prose, and the workflow must stay
able to publish with nobody in the loop. Write it in the release PR, where it is reviewed like any
other change, or do not write it.

`v0.3.8.md` is the worked example.

## Writing one

- Say what changed **for a user**, not what the diff did. A reader who does not have the code open
  is the whole audience for this layer; the grouped list below it is already there for the reader
  who does.
- Name the thing in the UI where there is one ("Settings → Notch"), so the sentence is checkable.
- Do not restate the list. Four sentences that pick the three things worth knowing beat twelve that
  summarise everything.
- English, like every other string in this repo.

## Things the generator deliberately does not do

- **It does not translate or rewrite a title.** A non-English or out-of-context PR title is
  published verbatim in its section. A detector that guesses wrong either mangles a real entry or
  silently loses a user-facing fix, and neither is better than a line that reads oddly. Note that
  reading PR titles already removes most of this: a commit subject is written for a reviewer with
  the diff open, a PR title is reviewed.
- **Nothing becomes a headline by itself.** The only headline is the Highlights block, which is
  hand-written and reviewed, so a bad title is at worst a bullet.
- **It does not categorise by GitHub label.** `.github/release.yml` categories key off PR labels,
  and this repo does not label PRs by type (measured 2026-09-22: of six sampled PRs in the v0.3.8
  range, only the dependabot one carried any label). A label-driven config would put every entry in
  one bucket. If the repo starts labelling, that file becomes worth adding.

## Failure

Any failure in the generator — `gh api` down, a body shape it cannot parse, no `node` on the runner
— falls back to the plain `git log` list releases used to publish, with a `::warning::` in the job
log. The one exception is the label: when a `no-release-notes` PR was merged in the range, or the
label lookup does not answer, the fallback publishes only the compare link, because commit subjects
would announce exactly what the label keeps out. **A release that cannot publish because prose generation broke would be strictly worse
than the list this replaces.**

## Testing it by hand

```bash
node scripts/release-notes.mjs --tag v0.3.8 --prev v0.3.7 --repo eneskirca/nodeterm
```

It reads `docs/release-notes/<tag>.md` from the working directory (`--root` to point elsewhere) and
prints to stdout unless given `--out`. `--body-file` substitutes a saved `generate-notes` body for
the API call, and `--exclude <pr,pr>` the label lookup.
