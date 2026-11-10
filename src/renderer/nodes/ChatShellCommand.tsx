/**
 * A `!` shell command the user ran (the reader's tool part named `!`), drawn as Claude Code's TUI
 * draws it: the command after a pink `!`, and its output's first line indented under a `⎿` hook. The
 * row opens to the whole output (the reader keeps it, `BASH_OUTPUT_MAX`). The point of the line is
 * feedback that the command ran; the output is for the agent, so it stays one line until asked for.
 * - `result` absent: no output record yet (still running, or never saved): no hook line.
 * - `result` empty: it ran and printed nothing.
 */
export function ChatShellCommand({ arg, result }: { arg: string; result?: string }): JSX.Element {
  const lines = result === undefined ? null : result.split('\n')
  const first = lines === null ? null : lines[0] === '' ? '(no output)' : lines[0]
  const more = lines !== null && lines.length > 1
  return (
    <details className="term-chat__shell">
      <summary>
        <span className="term-chat__shell-line">
          <span className="term-chat__shell-bang" aria-hidden="true">
            !
          </span>
          <span className="term-chat__shell-cmd">{arg}</span>
        </span>
        {first !== null && (
          <span className={`term-chat__shell-out term-chat__shell-first${more ? ' term-chat__shell-first--more' : ''}`}>
            <span className="term-chat__shell-hook" aria-hidden="true">
              ⎿
            </span>
            <span className="term-chat__shell-text">{first}</span>
          </span>
        )}
      </summary>
      {lines !== null && (
        <div className="term-chat__shell-out">
          <span className="term-chat__shell-hook" aria-hidden="true">
            ⎿
          </span>
          <pre className="term-chat__shell-text">{first === '(no output)' ? first : result}</pre>
        </div>
      )}
    </details>
  )
}
