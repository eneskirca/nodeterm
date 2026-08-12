/** Single-quote a string for safe use as one shell argument (POSIX).
 *
 *  Lives in `src/shared` so both the renderer's command assembly and any main/server-side
 *  command builder share one definition — a second copy would drift the quoting and let an
 *  unescaped quote reach a tmux `send-keys` line. */
export function shellSingleQuote(s: string): string {
  // POSIX single-quote: wrap in single quotes, and replace each embedded single quote with the
  // close-quote/escaped-quote/reopen-quote sequence `'\''`. Plain concatenation (not a template
  // literal) on purpose — a nested-backtick template for the replacement is legal but fragile
  // under tooling, and this is the one function whose correctness every typed command depends on.
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Split a free-text argv string into tokens the way a POSIX shell would, honoring single and
 * double quotes and backslash escapes. Used for a custom agent's `args` field, which the user
 * types as one string (matching `launchCmd`) but which must become discrete argv before the prompt
 * is appended.
 *
 * Deliberately NOT a full shell: no variable expansion, no command substitution, no tilde. The
 * expansion that DOES happen (`${env:VAR}`) is nodeterm's own, run BEFORE this split, so a
 * resolved value containing spaces is indistinguishable from a quoted one only if the user quoted
 * it — i.e. the user keeps the same control they have at a real shell.
 */
export function shellSplit(input: string): string[] {
  const tokens: string[] = []
  let buf = ''
  let i = 0
  let inSingle = false
  let inDouble = false
  let hasToken = false
  const push = () => {
    if (hasToken) tokens.push(buf)
    buf = ''
    hasToken = false
  }
  while (i < input.length) {
    const c = input[i]
    if (inSingle) {
      if (c === "'") inSingle = false
      else buf += c
    } else if (inDouble) {
      if (c === '\\' && input[i + 1] !== undefined) {
        buf += input[i + 1]
        i++
      } else if (c === '"') {
        inDouble = false
      } else {
        buf += c
      }
    } else if (c === '\\' && input[i + 1] !== undefined) {
      buf += input[i + 1]
      hasToken = true
      i++
    } else if (c === "'") {
      inSingle = true
      hasToken = true
    } else if (c === '"') {
      inDouble = true
      hasToken = true
    } else if (/\s/.test(c)) {
      push()
    } else {
      buf += c
      hasToken = true
    }
    i++
  }
  push()
  return tokens
}
