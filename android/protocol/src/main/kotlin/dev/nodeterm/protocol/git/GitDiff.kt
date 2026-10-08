package dev.nodeterm.protocol.git

/**
 * A unified diff as the phone shows it: each line with the kind that colours it. The desktop's
 * `git.diff` answers git's own text (`git diff -- <path>`, `--cached` for a staged file, and
 * `--no-index /dev/null <path>` for an untracked one), with no size cap of its own, so the view
 * keeps the first [MAX_LINES] lines and says how many it left out. For an unmerged path git prints
 * a COMBINED diff (`diff --cc`, `@@@` hunks, one marker column per side), which reads the same way.
 */
data class GitDiff(val lines: List<Line>, val omitted: Int) {
    enum class Kind {
        /** `diff --git`, `index`, `---`/`+++` file names, mode and rename lines, "Binary files … differ". */
        META,
        /** `@@ -a,b +c,d @@`. */
        HUNK,
        ADD,
        DEL,
        CONTEXT,
        /** `\ No newline at end of file`. */
        NOTE
    }

    data class Line(val kind: Kind, val text: String)

    val isEmpty: Boolean get() = lines.isEmpty()

    companion object {
        const val MAX_LINES = 4_000

        /** Longer lines (a minified file) are cut, so one line cannot hold the view. */
        const val MAX_LINE_CHARS = 2_000

        /**
         * Classify [text]. A `+++`/`---` line is a file name only BEFORE the first hunk of a file:
         * inside a hunk it is an added line that starts with `++` (or a removed one with `--`), which
         * a naive prefix test would colour as a header.
         *
         * A hunk header's `@` count says how many marker columns its lines carry: `@@` one, a
         * combined diff's `@@@` two (one per side of a merge). A line with a `-` in any column is not
         * in the result (removed); one with a `+` in any column is new against some side (added),
         * which is how git itself colours a combined diff. So ` +ours` in a conflict is an added
         * line, not context.
         */
        fun parse(text: String, maxLines: Int = MAX_LINES): GitDiff {
            if (text.isEmpty()) return GitDiff(emptyList(), 0)
            val raw = text.removeSuffix("\n").split('\n')
            val out = ArrayList<Line>(minOf(raw.size, maxLines))
            var inHunk = false
            var columns = 1
            for (rawLine in raw.take(maxLines)) {
                val line = rawLine.removeSuffix("\r")
                val kind = when {
                    line.startsWith("diff ") -> {
                        inHunk = false
                        Kind.META
                    }
                    line.startsWith("@@") -> {
                        inHunk = true
                        columns = (line.takeWhile { it == '@' }.length - 1).coerceAtLeast(1)
                        Kind.HUNK
                    }
                    !inHunk -> Kind.META
                    line.startsWith("\\") -> Kind.NOTE
                    else -> {
                        val markers = line.take(columns)
                        when {
                            '-' in markers -> Kind.DEL
                            '+' in markers -> Kind.ADD
                            else -> Kind.CONTEXT
                        }
                    }
                }
                val shown = if (line.length > MAX_LINE_CHARS) line.take(MAX_LINE_CHARS) + " …" else line
                out += Line(kind, shown)
            }
            return GitDiff(out, (raw.size - maxLines).coerceAtLeast(0))
        }
    }
}
