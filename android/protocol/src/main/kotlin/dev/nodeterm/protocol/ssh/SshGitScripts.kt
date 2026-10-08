package dev.nodeterm.protocol.ssh

import dev.nodeterm.protocol.host.HostException

/** Typed argv only. The SSH account's Git config, credentials, hooks and signing stay its own. */
object SshGitScripts {
    const val REFUSED = 125
    const val MISSING = 126
    const val MAX_OUTPUT = 20 * 1024 * 1024

    fun path(path: String): String {
        if (path.isEmpty() || path.length > 16_384 || '\u0000' in path || path.startsWith('/') ||
            path.split('/').any { it == ".." }) throw HostException("Choose a file inside this repository.")
        return path
    }

    /** Recheck physical paths on the host for every operation, including symlinks and renames. */
    fun command(cwd: String, roots: List<String>, args: List<String>, repositoryRoot: Boolean = true): String {
        if (!cwd.startsWith('/') || '\u0000' in cwd || cwd.length > 16_384 || roots.isEmpty())
            throw HostException("Source control needs a listed project folder on this computer.")
        val safeRoots = roots.filter { it.startsWith('/') && '\u0000' !in it && it.length <= 16_384 }.distinct()
        if (safeRoots.isEmpty() || args.any { '\u0000' in it }) throw HostException("Invalid Git request.")
        val jail = safeRoots.joinToString("\n") { root ->
            """
            nt_root=${SshScripts.q(root)}
            nt_root=${'$'}(CDPATH= cd -P "${'$'}nt_root" 2>/dev/null && pwd -P && printf .) || nt_root=
            if [ -n "${'$'}nt_root" ]; then nt_root=${'$'}{nt_root%.}; nt_root=${'$'}{nt_root%?}; fi
            if [ -n "${'$'}nt_root" ]; then
              case "${'$'}nt_cwd" in "${'$'}nt_root"|"${'$'}nt_root"/*) nt_allowed=1 ;; esac
              [ "${'$'}nt_root" != / ] || nt_allowed=1
            fi
            """.trimIndent()
        }
        val rootCheck = if (repositoryRoot) """
            nt_repo=${'$'}(command git rev-parse --show-toplevel 2>/dev/null && printf .) || {
              printf '%s\n' 'nodeterm: This folder is not a Git working tree.'; exit ${REFUSED}
            }
            nt_repo=${'$'}{nt_repo%.}; nt_repo=${'$'}{nt_repo%?}
            CDPATH= cd -P "${'$'}nt_repo" 2>/dev/null || exit ${REFUSED}
            nt_cwd=${'$'}(pwd -P && printf .)
            nt_cwd=${'$'}{nt_cwd%.}; nt_cwd=${'$'}{nt_cwd%?}
            nt_allowed=0
            $jail
            [ "${'$'}nt_allowed" = 1 ] || {
              printf '%s\n' 'nodeterm: The repository root is outside the listed project folders.'; exit ${REFUSED}
            }
        """.trimIndent() else ""
        return """
            PATH="${'$'}PATH:/opt/homebrew/bin:/usr/local/bin:${'$'}HOME/.local/bin"
            export PATH GIT_TERMINAL_PROMPT=0
            unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES GIT_DISCOVERY_ACROSS_FILESYSTEM
            nt_cwd=${SshScripts.q(cwd)}
            CDPATH= cd -P "${'$'}nt_cwd" 2>/dev/null || {
              printf '%s\n' 'nodeterm: That project folder cannot be opened.'; exit ${REFUSED}
            }
            nt_cwd=${'$'}(pwd -P && printf .)
            nt_cwd=${'$'}{nt_cwd%.}; nt_cwd=${'$'}{nt_cwd%?}
            nt_allowed=0
            $jail
            [ "${'$'}nt_allowed" = 1 ] || {
              printf '%s\n' 'nodeterm: That folder is outside the listed project folders.'; exit ${REFUSED}
            }
            command -v git >/dev/null 2>&1 || {
              printf '%s\n' 'nodeterm: Git is not installed or not on the SSH PATH.'; exit ${MISSING}
            }
            $rootCheck
            command git --no-pager --literal-pathspecs ${args.joinToString(" ", transform = SshScripts::q)} 2>&1
        """.trimIndent()
    }
}
