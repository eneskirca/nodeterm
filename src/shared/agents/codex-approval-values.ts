// Shared pure parser for the host capability probe and companion interop fixture.
/**
 * Only the option we are reading, never the one next to it.
 *
 * `--help` lists `-s, --sandbox <SANDBOX_MODE>` with its own `[possible values: read-only,
 * workspace-write, danger-full-access]` two lines above `--ask-for-approval`, so a parser that
 * scanned the page for "possible values" would confidently return the SANDBOX vocabulary and then
 * emit `--ask-for-approval read-only`. The slice below is anchored on the option's own header line
 * and ends at the next one.
 */
const ASK_FOR_APPROVAL = /--ask-for-approval\b/
/** An option header: indented at most 6 and starting with a dash. Value/description lines inside an
 *  option are indented 10, so this cannot cut a block short. */
const OPTION_HEADER = /^ {0,6}-{1,2}[A-Za-z]/

/**
 * Pure: `codex --help` output → the `--ask-for-approval` values it advertises, or `null` when the
 * page did not say (absent output, an option we could not find, a shape we do not recognise).
 *
 * `null` is a first-class answer and NOT an empty list: "the CLI accepts nothing" and "we could not
 * read the page" lead to different decisions one layer up, where `null` resolves to the baseline
 * vocabulary and an empty list would forbid every value including the two that have always worked.
 *
 * BOTH of clap's renderings are handled, because both are real. Long `--help` prints a block:
 *
 *     -a, --ask-for-approval <APPROVAL_POLICY>
 *             Configure when the model requires human approval before executing a command
 *
 *             Possible values:
 *             - on-request: The model decides when to ask the user for approval
 *             - never:      Never ask for user approval Execution failures are immediately
 *               returned to the model
 *
 * short `-h` prints it inline and wraps it mid-phrase:
 *
 *     -a, --ask-for-approval <APPROVAL_POLICY>
 *             Configure when the model requires human approval ... [possible
 *             values: on-request, never]
 *
 * — which is why the inline branch joins the slice before matching rather than working line by
 * line. The probe below asks for the long form; the short form is handled so a caller that has
 * `-h` output lying around gets the same answer instead of a silent `null`.
 *
 * Every token is validated against `[a-z][a-z0-9-]*`. These strings are appended to a launch
 * command that is typed into a tmux pane, so the help page is untrusted input at an interpolation
 * site like any other — a token we would not recognise is dropped rather than quoted and hoped
 * for, and if nothing survives the answer is `null`.
 */
export function codexApprovalValuesFrom(helpOutput: string | null | undefined): string[] | null {
  if (!helpOutput) return null
  const lines = helpOutput.split(/\r?\n/)
  const start = lines.findIndex((l) => ASK_FOR_APPROVAL.test(l))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !OPTION_HEADER.test(lines[end])) end++
  const slice = lines.slice(start, end)

  const values: string[] = []
  const inline = slice.join(' ').match(/\[possible\s+values:\s*([^\]]*)\]/i)
  if (inline) {
    values.push(...inline[1].split(','))
  } else {
    // The block form. Anchored on the `Possible values:` marker so a bullet inside the option's
    // prose description can never be mistaken for a value.
    const marker = slice.findIndex((l) => /^\s*possible\s+values:\s*$/i.test(l))
    if (marker < 0) return null
    for (const line of slice.slice(marker + 1)) {
      const m = line.match(/^\s*-\s+([^\s:]+)\s*:/)
      if (m) values.push(m[1])
    }
  }
  const clean = values.map((v) => v.trim()).filter((v) => /^[a-z][a-z0-9-]*$/.test(v))
  return clean.length ? Array.from(new Set(clean)) : null
}

