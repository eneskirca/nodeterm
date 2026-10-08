package dev.nodeterm.protocol.ssh

import dev.nodeterm.protocol.model.ProjectsParser
import dev.nodeterm.protocol.model.TmuxNames
import dev.nodeterm.protocol.host.ManagedSessionAdoption
import dev.nodeterm.protocol.model.TerminalHistory

/**
 * The POSIX sh the direct-SSH transport runs on the paired computer. Generated shell, so every
 * interpolation is single-quoted with [q] and every target is checked against the shape this app
 * generates (`nt-[A-Za-z0-9_-]+`) before it is spliced.
 *
 * Four facts about the computer these encode:
 *  - an ssh exec channel gets a NON-login shell, so Homebrew's tmux is not on PATH on a Mac: the
 *    PATH is APPENDED (never prepended — a PATH that already resolves tmux keeps that binary), the
 *    same rule as `remoteTmuxPathPrologue` in src/shared/ssh.ts; the tmux the macOS app ships
 *    (`Contents/Resources/bin/tmux`) is the last resort, as it is for the desktop's own `findTmux`;
 *  - a nodeterm running ON the computer keeps its sessions on the `-L node-terminal` socket
 *    (src/core/tmux-naming.ts), and a desktop that drives the computer over SSH keeps the sessions
 *    of its SSH projects on `-L nodeterm-rmt` (`remoteTmuxCommand`, src/shared/ssh.ts). Both can be
 *    there at once, so every session is reached on the socket it was listed on ([TmuxNames.SOCKETS],
 *    audit A27), and a session that was not listed is looked up on both ([whichSocket]);
 *  - the desktop app's userData is `~/Library/Application Support/node-terminal` on macOS and
 *    `$XDG_CONFIG_HOME/node-terminal` (default `~/.config/node-terminal`) on Linux: Electron names it
 *    after package.json `name`, and the desktop has no top-level `productName` (the desktop's own
 *    hook shell walks the same dirs, src/core/agents/hook-endpoint-failover-sh.ts). The `nodeterm`
 *    spelling is probed after it as a legacy fallback (audit A02);
 *  - the Server Edition keeps the same files in its data dir: `~/.nodeterm-server` by default
 *    (src/server/config.ts), or wherever `--data-dir` / `NODETERM_DATA_DIR` put it. The browse checks
 *    `$NODETERM_DATA_DIR` when the SSH session happens to carry it, then the default; a server whose
 *    data dir is elsewhere needs the phone's explicit saved profile folder selection.
 */
object SshScripts {
    const val META_START = "##NT-META"
    const val META_END = "##NT-META-END"
    const val FILE_MARK = "##NT-FILE "

    /** [browse]'s sections after the `projects.list`-shaped part ([HostBrowse] reads them). Each is a
     *  line of its own; JSON never has a line starting `##`, and session names are checked in sh. */
    const val RMT_MARK = "##NT-RMT"
    const val SLICE_MARK = "##NT-SLICE "
    const val PROJECT_FILE_MARK = "##NT-PROJFILE "
    const val PHONE_MARK = "##NT-PHONE"
    const val END_MARK = "##NT-END"

    /** Bounds on what [browse] walks for project files: directories per session path, and files. */
    const val WALK_DEPTH = 40
    const val MAX_PROJECT_FILES = 64

    /** Single-quote for sh: `'` → `'\''`. */
    fun q(s: String): String = "'" + s.replace("'", "'\\''") + "'"

    const val SELECTED_PROFILE_MISSING_EXIT = 46

    private val PREPARE = """
        unset TMUX TMUX_PANE
        PATH="${'$'}PATH:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:${'$'}HOME/.local/bin"; export PATH
        NT_TMUX=${'$'}(command -v tmux 2>/dev/null)
        if [ -z "${'$'}NT_TMUX" ]; then
          for c in /Applications/nodeterm.app/Contents/Resources/bin/tmux "${'$'}HOME/Applications/nodeterm.app/Contents/Resources/bin/tmux"; do
            if [ -x "${'$'}c" ]; then NT_TMUX="${'$'}c"; break; fi
          done
        fi
    """.trimIndent()

    private val PRELUDE = """
        $PREPARE
        NT_UD=""
        for d in "${'$'}HOME/Library/Application Support/node-terminal" "${'$'}{XDG_CONFIG_HOME:-${'$'}HOME/.config}/node-terminal" \
                 "${'$'}HOME/Library/Application Support/nodeterm" "${'$'}{XDG_CONFIG_HOME:-${'$'}HOME/.config}/nodeterm"; do
          if [ -f "${'$'}d/workspace.json" ]; then NT_UD="${'$'}d"; break; fi
        done
        if [ -z "${'$'}NT_UD" ]; then
          for d in ${'$'}{NODETERM_DATA_DIR:+"${'$'}NODETERM_DATA_DIR"} "${'$'}HOME/.nodeterm-server"; do
            if [ -f "${'$'}d/workspace.json" ] || [ -f "${'$'}d/agent-status.json" ] || [ -f "${'$'}d/install-meta.json" ]; then NT_UD="${'$'}d"; break; fi
          done
        fi
    """.trimIndent()

    private fun prelude(profilePath: String?): String {
        SshProfilePath.requireValid(profilePath)
        if (profilePath == null) return PRELUDE
        // Keep tmux/PATH preparation, but never run automatic profile discovery for an explicit choice.
        return """
            $PREPARE
            NT_UD=${q(profilePath)}
            [ -d "${'$'}NT_UD" ] || exit $SELECTED_PROFILE_MISSING_EXIT
            if [ ! -f "${'$'}NT_UD/workspace.json" ] && [ ! -f "${'$'}NT_UD/agent-status.json" ] && [ ! -f "${'$'}NT_UD/install-meta.json" ]; then
              exit $SELECTED_PROFILE_MISSING_EXIT
            fi
        """.trimIndent()
    }

    /** Validate atomic ownership metadata, including sessions with interrupted option setup. */
    private val PHONE_GUARD = """
        nt_phone_owned() {
          nt_name=${'$'}1
          nt_id_env=${'$'}("${'$'}NT_TMUX" -L ${TmuxNames.PHONE_SOCKET} show-environment -t "=${'$'}nt_name" ${PhoneTerminals.ID_ENV} 2>/dev/null) || return 1
          nt_id=${'$'}{nt_id_env#${PhoneTerminals.ID_ENV}=}
          [ "${'$'}nt_name" = "nt-${'$'}nt_id" ] || return 1
          case "${'$'}nt_id" in phone-????????-????-????-????-????????????) ;; *) return 1 ;; esac
          case "${'$'}{nt_id#phone-}" in *[!0-9a-f-]*) return 1 ;; esac
          nt_marker=${'$'}("${'$'}NT_TMUX" -L ${TmuxNames.PHONE_SOCKET} show-environment -t "=${'$'}nt_name" ${PhoneTerminals.CREATION_ENV} 2>/dev/null) || return 1
          nt_creation=${'$'}{nt_marker#${PhoneTerminals.CREATION_ENV}=}
          [ ${'$'}{#nt_creation} -eq 64 ] || return 1
          case "${'$'}nt_creation" in *[!0-9a-f]*) return 1 ;; esac
          nt_cwd_env=${'$'}("${'$'}NT_TMUX" -L ${TmuxNames.PHONE_SOCKET} show-environment -t "=${'$'}nt_name" ${PhoneTerminals.CWD_ENV} 2>/dev/null) || return 1
          nt_cwd=${'$'}{nt_cwd_env#${PhoneTerminals.CWD_ENV}=}
          case "${'$'}nt_cwd" in /*) ;; *) return 1 ;; esac
          nt_request_env=${'$'}("${'$'}NT_TMUX" -L ${TmuxNames.PHONE_SOCKET} show-environment -t "=${'$'}nt_name" ${PhoneTerminals.REQUEST_ENV} 2>/dev/null) || return 1
          nt_request=${'$'}{nt_request_env#${PhoneTerminals.REQUEST_ENV}=}
          [ "${'$'}nt_request" = HOME ] || [ "${'$'}nt_request" = "${'$'}nt_cwd" ] || return 1
          nt_options=${'$'}("${'$'}NT_TMUX" -L ${TmuxNames.PHONE_SOCKET} display-message -p -t "=${'$'}nt_name:" '#{${PhoneTerminals.ID_OPTION}}|#{${PhoneTerminals.CREATION_OPTION}}|#{${PhoneTerminals.CWD_OPTION}}' 2>/dev/null) || return 1
          nt_opt_id=${'$'}{nt_options%%|*}; nt_options=${'$'}{nt_options#*|}
          nt_opt_creation=${'$'}{nt_options%%|*}; nt_opt_cwd=${'$'}{nt_options#*|}
          [ -z "${'$'}nt_opt_id" ] || [ "${'$'}nt_opt_id" = "${'$'}nt_id" ] || return 1
          [ -z "${'$'}nt_opt_creation" ] || [ "${'$'}nt_opt_creation" = "${'$'}nt_creation" ] || return 1
          [ -z "${'$'}nt_opt_cwd" ] || [ "${'$'}nt_opt_cwd" = "${'$'}nt_cwd" ] || return 1
          return 0
        }
    """.trimIndent()

    /**
     * A UTF-8 locale for the tmux CLIENT (audit A03). An sshd exec channel on a stock macOS host
     * carries no LANG, and tmux draws every character with no ACS mapping (╭, é, CJK, emoji) as `_`
     * for a client it does not believe is UTF-8. The rule is the desktop's `resolveLocaleLang`
     * (src/core/pty-manager.ts): keep an inherited LC_ALL/LC_CTYPE/LANG that already says UTF-8,
     * otherwise export LANG — `en_US.UTF-8` on macOS (always present, and what the desktop uses),
     * `C.UTF-8` elsewhere (a Linux host may not have en_US generated, and shells would print setlocale
     * warnings). LANG also reaches the panes of a server this attach starts; `-u` on the client makes
     * the rendering UTF-8 even when an explicit non-UTF-8 LC_ALL wins over LANG.
     */
    private val LOCALE = """
        case "${'$'}{LC_ALL:-${'$'}{LC_CTYPE:-${'$'}{LANG:-}}}" in
          *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) ;;
          *) if [ "${'$'}(uname -s 2>/dev/null)" = Darwin ]; then LANG=en_US.UTF-8; else LANG=C.UTF-8; fi; export LANG ;;
        esac
    """.trimIndent()

    /**
     * Browse: emits a meta block (the data dir, tmux, `$HOME`, and `relay=1|0`: whether
     * `~/.nodeterm/relay.json` is there — the desktop writes it while its phone host is registered at
     * the relay and removes it when remote access is turned off, relay-advertise.ts; audit A26), then
     * EXACTLY the `projects.list` blob shape (workspace.json ·
     * live `nt-*` sessions on `node-terminal` · agent-status.json), so the relay and SSH paths share
     * one parser — then what a desktop that drives this computer over SSH left here (audit A27):
     *
     *  - [RMT_MARK]: the `nt-*` sessions on `nodeterm-rmt`, one name per line (checked against the
     *    shape this app generates before it is printed);
     *  - [SLICE_MARK]`<projectId>`: each `~/.nodeterm/agent-status-<projectId>.json`, the per-project
     *    status slice that desktop pushes (src/main/remote-ssh/remote-status-push.ts). There is no
     *    workspace.json for those projects on this computer: this is their only status;
     *  - [PROJECT_FILE_MARK]`<dir>`: each `<dir>/.nodeterm/project.json` found by walking up from a
     *    `nodeterm-rmt` session's start directory (`#{session_path}`, the node's cwd the desktop gave
     *    `new-session -c`), deduplicated, at most [WALK_DEPTH] levels per path and
     *    [MAX_PROJECT_FILES] files. An SSH project's canvas lives in `<remoteCwd>/.nodeterm/project.json`,
     *    and its sessions start in or under that folder;
     *  - [END_MARK].
     *
     * Splitting is by lines in the shell (`IFS` = newline, globbing off), never by a here-document:
     * this template keeps its indentation, and a here-document's terminator must start its line.
     */
    fun browse(profilePath: String? = null): String = """
        ${prelude(profilePath)}
        printf '%s\n' '$META_START'
        printf 'ud=%s\n' "${'$'}NT_UD"
        printf 'tmux=%s\n' "${'$'}NT_TMUX"
        printf 'home=%s\n' "${'$'}HOME"
        if [ -s "${'$'}HOME/.nodeterm/relay.json" ]; then printf 'relay=1\n'; else printf 'relay=0\n'; fi
        printf '%s\n' '$META_END'
        if [ -n "${'$'}NT_UD" ]; then cat "${'$'}NT_UD/workspace.json" 2>/dev/null; fi
        printf '\n%s\n' '${ProjectsParser.PROJECTS_MARK}'
        if [ -n "${'$'}NT_TMUX" ]; then "${'$'}NT_TMUX" -L ${TmuxNames.SOCKET} list-sessions -F '#{session_name}' 2>/dev/null; fi
        printf '\n%s\n' '${ProjectsParser.STATUS_MARK}'
        if [ -n "${'$'}NT_UD" ]; then cat "${'$'}NT_UD/agent-status.json" 2>/dev/null; fi
        printf '\n%s\n' '$RMT_MARK'
        NT_NL=${'$'}(printf '\nx'); NT_NL=${'$'}{NT_NL%x}
        NT_DIRS=""; NT_NDIRS=0
        if [ -n "${'$'}NT_TMUX" ]; then
          NT_RMT=${'$'}("${'$'}NT_TMUX" -L ${TmuxNames.REMOTE_SOCKET} list-sessions -F '#{session_name} #{session_path}' 2>/dev/null)
          set -f; IFS=${'$'}NT_NL
          for l in ${'$'}NT_RMT; do
            n=${'$'}{l%% *}
            case "${'$'}n" in nt-*) ;; *) continue ;; esac
            case "${'$'}{n#nt-}" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
            printf '%s\n' "${'$'}n"
            p=${'$'}{l#* }
            [ "${'$'}p" = "${'$'}l" ] && continue
            i=0
            while [ ${'$'}i -lt $WALK_DEPTH ] && [ ${'$'}NT_NDIRS -lt $MAX_PROJECT_FILES ]; do
              case "${'$'}p" in /*) ;; *) break ;; esac
              if [ -f "${'$'}p/.nodeterm/project.json" ]; then
                case "${'$'}NT_NL${'$'}NT_DIRS${'$'}NT_NL" in
                  *"${'$'}NT_NL${'$'}p${'$'}NT_NL"*) ;;
                  *) NT_DIRS="${'$'}NT_DIRS${'$'}NT_NL${'$'}p"; NT_NDIRS=${'$'}((NT_NDIRS + 1)) ;;
                esac
              fi
              [ "${'$'}p" = / ] && break
              p=${'$'}{p%/*}
              [ -n "${'$'}p" ] || p=/
              i=${'$'}((i + 1))
            done
          done
          unset IFS; set +f
        fi
        for f in "${'$'}HOME"/.nodeterm/agent-status-*.json; do
          [ -f "${'$'}f" ] || continue
          id=${'$'}{f##*/}; id=${'$'}{id#agent-status-}; id=${'$'}{id%.json}
          case "${'$'}id" in ''|*[!A-Za-z0-9._-]*) continue ;; esac
          printf '\n%s%s\n' '$SLICE_MARK' "${'$'}id"
          cat "${'$'}f" 2>/dev/null
        done
        set -f; IFS=${'$'}NT_NL
        for d in ${'$'}NT_DIRS; do
          printf '\n%s%s\n' '$PROJECT_FILE_MARK' "${'$'}d"
          cat "${'$'}d/.nodeterm/project.json" 2>/dev/null
        done
        unset IFS; set +f
        printf '\n%s\n' '$PHONE_MARK'
        if [ -n "${'$'}NT_TMUX" ]; then
          $PHONE_GUARD
          NT_PHONE=${'$'}("${'$'}NT_TMUX" -L ${TmuxNames.PHONE_SOCKET} list-sessions -F '#{session_name}' 2>/dev/null)
          set -f; IFS=${'$'}NT_NL
          for n in ${'$'}NT_PHONE; do
            nt_phone_owned "${'$'}n" || continue
            printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${'$'}n" "${'$'}nt_id" "${'$'}nt_creation" "${'$'}nt_cwd" "${'$'}nt_creation" "${'$'}nt_request"
          done
          unset IFS; set +f
        fi
        printf '\n%s\n' '$END_MARK'
        exit 0
    """.trimIndent()

    /** Cat each file behind a `##NT-FILE <i>` marker (a missing file yields an empty section). */
    fun catFiles(paths: List<String>): String = buildString {
        for ((i, p) in paths.withIndex()) {
            append("printf '\\n%s\\n' '").append(FILE_MARK).append(i).append("'\n")
            append("cat ").append(q(p)).append(" 2>/dev/null\n")
        }
        append("exit 0\n")
    }

    /**
     * Which socket the node's session is on: prints `node-terminal` or `nodeterm-rmt` (the first that
     * has it, in [TmuxNames.SOCKETS] order — the attribution [browse]'s listing makes), or nothing
     * when neither does or there is no tmux.
     */
    fun whichSocket(nodeId: String, phoneCreation: String? = null): String {
        val target = q("=" + target(nodeId))
        return """
            $PRELUDE
            $PHONE_GUARD
            [ -n "${'$'}NT_TMUX" ] || exit 0
            for s in ${if (PhoneTerminals.validId(nodeId)) TmuxNames.PHONE_SOCKET else TmuxNames.SOCKETS.joinToString(" ")}; do
              if "${'$'}NT_TMUX" -L "${'$'}s" has-session -t $target 2>/dev/null; then
                if [ "${'$'}s" = ${TmuxNames.PHONE_SOCKET} ]; then
                  nt_phone_owned ${q(target(nodeId))} || continue
                  [ "${'$'}nt_creation" = ${q(phoneCreation ?: "")} ] || continue
                fi
                printf '%s\n' "${'$'}s"; exit 0
              fi
            done
            exit 0
        """.trimIndent()
    }

    /**
     * Attach a pty to the node's EXISTING session — `attach-session`, never `new-session`: a session
     * created over SSH gets none of the hook environment the desktop gives it (`NODETERM_NODE_ID`,
     * the hook endpoint), so an agent resumed there never reports status, and the desktop never
     * repairs it because tmux reads `-e` only at creation — or it inherits ANOTHER node's id from the
     * tmux server's global env (audit A08). A missing session exits [NO_SESSION_EXIT] instead, and
     * the app offers the relay, where the desktop creates it properly. Without `-d`: the desktop's
     * own client must stay attached (`-d` is what "[detached]" dead terminals are made of).
     *
     * The same holds on [TmuxNames.REMOTE_SOCKET], and more so: a session the driving desktop creates
     * there also gets its remote tmux.conf (`-f`) and the hook/account `-e` env, none of which the
     * phone has.
     */
    fun attach(nodeId: String, socket: String, phoneCreation: String? = null, inputHandshake: Boolean = false): String {
        val target = target(nodeId)
        val s = socket(socket)
        return """
            $PRELUDE
            $PHONE_GUARD
            if [ -z "${'$'}NT_TMUX" ]; then echo 'nodeterm: tmux was not found on this computer.' >&2; exit 127; fi
            "${'$'}NT_TMUX" -L $s has-session -t ${q("=$target")} 2>/dev/null || exit $NO_SESSION_EXIT
            ${if (socket == TmuxNames.PHONE_SOCKET) "nt_phone_owned ${q(target)} || exit $NO_SESSION_EXIT" else ""}
            ${phonePin(socket, phoneCreation)}
            ${if (socket == TmuxNames.PHONE_SOCKET) "\"${'$'}NT_TMUX\" -L $s set-option -t ${q("=$target:")} mouse on \\; set-option -t ${q("=$target:")} status off \\; set-option -t ${q("=$target:")} destroy-unattached off || exit 1" else ""}
            TERM=xterm-256color; export TERM
            $LOCALE
            ${if (inputHandshake) "nt_tty=\$(tty 2>/dev/null) || exit $NO_SESSION_EXIT\nprintf 'NT-INPUT-VIEW %s\\n' \"\$nt_tty\"" else ""}
            exec "${'$'}NT_TMUX" -u -L $s attach-session -t ${q("=$target")}
        """.trimIndent()
    }

    /** Same existing phone-shell ownership checks for attachment-bound composed input. */
    internal fun composedPrelude(nodeId: String, socket: String, phoneCreation: String?): String {
        val name = target(nodeId)
        socket(socket)
        return """
            $PRELUDE
            $PHONE_GUARD
            [ -n "${'$'}NT_TMUX" ] || exit 127
            ${if (socket == TmuxNames.PHONE_SOCKET) "nt_phone_owned ${q(name)} || exit 3" else ""}
            ${phonePin(socket, phoneCreation)}
        """.trimIndent()
    }

    /** View only the exact host-created pane. Missing/replaced generations are never recreated. */
    internal fun attachManaged(adoption: ManagedSessionAdoption, ad: SshActions.Advertisement, attach: Boolean = true, clientTty: String? = null, profilePath: String? = null): String {
        val r = adoption.receipt
        require(ad.instance == r.hostInstance)
        require(clientTty == null || !attach && ManagedViewHandshake.validTty(clientTty))
        val format = "#{session_name}|#{session_created}|#{pane_id}|#{pane_pid}|#{NODETERM_MANAGED_CREATION_ID}"
        val tuple = "${r.session}|${r.sessionCreated}|${r.paneId}|${r.panePid}|${r.creationId}"
        val parts = listOf("#{==:#{session_name},${r.session}}", "#{==:#{session_created},${r.sessionCreated}}",
            "#{==:#{pane_id},${r.paneId}}", "#{==:#{pane_pid},${r.panePid}}", "#{==:#{NODETERM_MANAGED_CREATION_ID},${r.creationId}}")
        val condition = parts.reduce { a, b -> "#{&&:$a,$b}" }
        return """
            ${prelude(profilePath)}
            [ "${'$'}NT_UD" = ${q(adoption.request.profile)} ] || exit $NO_SESSION_EXIT
            [ -n "${'$'}NT_TMUX" ] || exit $NO_SESSION_EXIT
            ${SshActionsScripts.adoptionGuard(adoption.request.profile, ad)}
            nt_tuple=${'$'}("${'$'}NT_TMUX" -L ${q(r.socket)} list-panes -s -t ${q("=" + r.session)} -F ${q(format)} 2>/dev/null) || exit $NO_SESSION_EXIT
            [ "${'$'}nt_tuple" = ${q(tuple)} ] || exit $NO_SESSION_EXIT
            case "${'$'}(uname -s 2>/dev/null)" in
              Linux)
                nt_stat=${'$'}(cat /proc/${r.panePid}/stat 2>/dev/null) || exit $NO_SESSION_EXIT
                nt_boot=${'$'}(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || exit $NO_SESSION_EXIT
                nt_fields=${'$'}{nt_stat##*) }; set -f; set -- ${'$'}nt_fields
                [ "${'$'}#" -ge 20 ] || exit $NO_SESSION_EXIT
                shift 19; nt_birth="linux:${'$'}nt_boot:${'$'}1"
                ;;
              Darwin)
                nt_started=${'$'}(LC_ALL=C ps -o lstart= -p ${r.panePid} 2>/dev/null | awk '{${'$'}1=${'$'}1; print}')
                [ -n "${'$'}nt_started" ] || exit $NO_SESSION_EXIT
                nt_birth="darwin:${'$'}nt_started"
                ;;
              *) exit $NO_SESSION_EXIT ;;
            esac
            [ "${'$'}nt_birth" = ${q(r.paneBirth)} ] || exit $NO_SESSION_EXIT
            nt_managed_ad || exit $NO_SESSION_EXIT
            TERM=xterm-256color; export TERM
            $LOCALE
            ${if (attach) """
            nt_tty=${'$'}(tty 2>/dev/null) || exit $NO_SESSION_EXIT
            printf 'NT-MANAGED-VIEW %s\n' "${'$'}nt_tty"
            """.trimIndent() else ""}
            ${if (clientTty != null) """
            nt_wait=0; nt_found=0
            while [ "${'$'}nt_wait" -lt 30 ]; do
              nt_clients=${'$'}("${'$'}NT_TMUX" -L ${q(r.socket)} list-clients -t ${q("=" + r.session)} -F '#{client_tty}|#{session_name}' 2>/dev/null) || exit $NO_SESSION_EXIT
              if printf '%s\n' "${'$'}nt_clients" | ${"awk -v expected=" + q(clientTty + "|" + r.session)} 'BEGIN { found=0 } ${'$'}0 == expected { found=1 } END { exit !found }'; then nt_found=1; break; fi
              nt_wait=${'$'}((nt_wait + 1)); sleep 0.1
            done
            [ "${'$'}nt_found" = 1 ] || exit $NO_SESSION_EXIT
            """.trimIndent() else ""}
            # -F has no asynchronous shell probe: the final tuple and attach share a tmux queue.
            # An unknown command in the false branch fails closed, with no alternate target.
            exec "${'$'}NT_TMUX" -u -L ${q(r.socket)} if-shell -F -t ${q(r.paneId)} ${q(condition)} \
              ${q(if (attach) "attach-session -t " + q("=" + r.session) else "display-message -p NT-MANAGED-VERIFIED")} 'managed-session-receipt-mismatch'
        """.trimIndent()
    }

    /** [attach]'s exit status when the node's session is not running. */
    const val NO_SESSION_EXIT = 3

    /** Explicit creation of a plain phone shell; attach never creates or resumes an agent. */
    fun createTerminal(nodeId: String, cwd: String?): String {
        val fingerprint = PhoneTerminals.fingerprint(nodeId, cwd)
        val target = q("=" + target(nodeId))
        val paneTarget = q("=" + target(nodeId) + ":")
        val bootstrap = """
            for nt_var in ${'$'}(env | sed -n 's/^\(NODETERM_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "${'$'}nt_var"; done
            unset CLAUDE_CONFIG_DIR CODEX_HOME
            TERM=xterm-256color; export TERM
            # Normalize stale non-UTF-8 overrides from a warm phone server, preserving UTF-8 ones.
            case "${'$'}{LC_ALL:-}" in ''|*[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) ;; *) unset LC_ALL ;; esac
            case "${'$'}{LC_CTYPE:-}" in ''|*[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) ;; *) unset LC_CTYPE ;; esac
            $LOCALE
            nt_shell=${'$'}{SHELL:-/bin/sh}
            case "${'$'}nt_shell" in /*) ;; *) nt_shell=/bin/sh ;; esac
            [ -x "${'$'}nt_shell" ] || nt_shell=/bin/sh
            exec "${'$'}nt_shell"
        """.trimIndent()
        return """
            $PRELUDE
            [ -n "${'$'}NT_TMUX" ] || { echo 'nodeterm: tmux was not found on this computer.'; exit 127; }
            nt_cwd=${cwd?.let(::q) ?: "\"${'$'}HOME\""}
            case "${'$'}nt_cwd" in /*) ;; *) echo 'nodeterm: Choose an absolute folder.'; exit 2 ;; esac
            for s in ${TmuxNames.SOCKET} ${TmuxNames.REMOTE_SOCKET}; do
              if "${'$'}NT_TMUX" -L "${'$'}s" has-session -t $target 2>/dev/null; then echo 'nodeterm: This terminal id is already in use.'; exit 2; fi
            done
            if ! "${'$'}NT_TMUX" -L ${TmuxNames.PHONE_SOCKET} has-session -t $target 2>/dev/null; then
              [ -d "${'$'}nt_cwd" ] && [ -x "${'$'}nt_cwd" ] || { echo 'nodeterm: That folder no longer exists or cannot be opened.'; exit 2; }
              # Marker creation is atomic with the session, including after a lost SSH reply.
              TERM=xterm-256color; export TERM
              $LOCALE
              "${'$'}NT_TMUX" -u -L ${TmuxNames.PHONE_SOCKET} -f /dev/null start-server \
                \; set-option -g history-limit 50000 \
                \; new-session -d -s ${q(target(nodeId))} -c "${'$'}nt_cwd" \
                -e ${q(PhoneTerminals.CREATION_ENV + "=" + fingerprint)} \
                -e ${q(PhoneTerminals.ID_ENV + "=" + nodeId)} \
                -e "${PhoneTerminals.CWD_ENV}=${'$'}nt_cwd" \
                -e ${q(PhoneTerminals.REQUEST_ENV + "=" + (cwd ?: "HOME"))} ${q("/bin/sh -c " + q(bootstrap))} >/dev/null 2>&1 || {
                  "${'$'}NT_TMUX" -L ${TmuxNames.PHONE_SOCKET} has-session -t $target 2>/dev/null || { echo 'nodeterm: Could not create the terminal.'; exit 1; }
                }
            fi
            nt_marker=${'$'}("${'$'}NT_TMUX" -L ${TmuxNames.PHONE_SOCKET} show-environment -t $target ${PhoneTerminals.CREATION_ENV} 2>/dev/null) || { echo 'nodeterm: This terminal id belongs to another session.'; exit 2; }
            [ "${'$'}nt_marker" = ${q(PhoneTerminals.CREATION_ENV + "=" + fingerprint)} ] || { echo 'nodeterm: This terminal id belongs to another session.'; exit 2; }
            $PHONE_GUARD
            nt_phone_owned ${q(target(nodeId))} || { echo 'nodeterm: This terminal id belongs to another session.'; exit 2; }
            nt_previous=${'$'}("${'$'}NT_TMUX" -L ${TmuxNames.PHONE_SOCKET} display-message -p -t ${q("=" + target(nodeId) + ":")} '#{${PhoneTerminals.CREATION_OPTION}}' 2>/dev/null) || exit 2
            [ -z "${'$'}nt_previous" ] || [ "${'$'}nt_previous" = '$fingerprint' ] || { echo 'nodeterm: This terminal id belongs to another session.'; exit 2; }
            nt_previous_id=${'$'}("${'$'}NT_TMUX" -L ${TmuxNames.PHONE_SOCKET} display-message -p -t $paneTarget '#{${PhoneTerminals.ID_OPTION}}' 2>/dev/null) || exit 2
            [ -z "${'$'}nt_previous_id" ] || [ "${'$'}nt_previous_id" = ${q(nodeId)} ] || { echo 'nodeterm: This terminal id belongs to another session.'; exit 2; }
            # A retry reconciles the existing shell even if its original directory was renamed.
            nt_previous_cwd=${'$'}("${'$'}NT_TMUX" -L ${TmuxNames.PHONE_SOCKET} display-message -p -t $paneTarget '#{${PhoneTerminals.CWD_OPTION}}' 2>/dev/null) || exit 2
            if [ -n "${'$'}nt_previous_cwd" ]; then nt_cwd=${'$'}nt_previous_cwd; fi
            # All writes address exactly this creation's session; no canvas or shared project file.
            "${'$'}NT_TMUX" -L ${TmuxNames.PHONE_SOCKET} set-option -t $paneTarget ${PhoneTerminals.ID_OPTION} ${q(nodeId)} \
              \; set-option -t $paneTarget ${PhoneTerminals.CREATION_OPTION} '$fingerprint' \
              \; set-option -t $paneTarget ${PhoneTerminals.CWD_OPTION} "${'$'}nt_cwd" \
              \; set-option -t $paneTarget mouse on \
              \; set-option -t $paneTarget status off \
              \; set-option -t $paneTarget destroy-unattached off \
              \; set-option -w -t $paneTarget history-limit 50000 || { echo 'nodeterm: Could not prepare the terminal.'; exit 1; }
            echo 'created'
        """.trimIndent()
    }

    fun killSession(nodeId: String, socket: String, phoneCreation: String? = null): String {
        val target = target(nodeId)
        return """
            $PRELUDE
            $PHONE_GUARD
            [ -n "${'$'}NT_TMUX" ] || exit 127
            ${if (socket == TmuxNames.PHONE_SOCKET) "nt_phone_owned ${q(target)} || exit 2" else ""}
            ${phonePin(socket, phoneCreation)}
            "${'$'}NT_TMUX" -L ${socket(socket)} kill-session -t ${q("=$target")}
        """.trimIndent()
    }

    /**
     * What owns the node's pane: tmux's `#{pane_current_command}`, the fact the desktop's wake reads
     * (`PtyManager.paneCommand`) before it types a resume line. Prints nothing when there is no tmux
     * or no such session.
     */
    fun paneCommand(nodeId: String, socket: String, phoneCreation: String? = null): String {
        // A PANE target, like [sendKeys]: the exact-session form for a pane command is `=name:`.
        val pane = q("=" + target(nodeId) + ":")
        return """
            $PRELUDE
            $PHONE_GUARD
            [ -n "${'$'}NT_TMUX" ] || exit 127
            ${if (socket == TmuxNames.PHONE_SOCKET) "nt_phone_owned ${q(target(nodeId))} || exit 2" else ""}
            ${phonePin(socket, phoneCreation)}
            "${'$'}NT_TMUX" -L ${socket(socket)} display-message -p -t $pane '#{pane_current_command}'
        """.trimIndent()
    }

    /** Search on the computer, never transfer its full history to the phone. No copy-mode change. */
    fun searchHistory(nodeId: String, query: String, socket: String, phoneCreation: String? = null): String {
        require(TerminalHistory.validQuery(query)) { "invalid history query" }
        val target = q("=" + target(nodeId) + ":")
        val s = socket(socket)
        return """
            $PRELUDE
            $PHONE_GUARD
            [ -n "${'$'}NT_TMUX" ] || exit 127
            ${if (socket == TmuxNames.PHONE_SOCKET) "nt_phone_owned ${q(target(nodeId))} || exit 2" else ""}
            ${phonePin(socket, phoneCreation)}
            NT_PANE=${'$'}("${'$'}NT_TMUX" -L $s display-message -p -t $target '#{pane_id}') || exit ${'$'}?
            case "${'$'}NT_PANE" in %*) case "${'$'}{NT_PANE#%}" in ''|*[!0-9]*) exit 2;; esac;; *) exit 2;; esac
            umask 077
            NT_HISTORY_FILE=${'$'}(mktemp "${'$'}{TMPDIR:-/tmp}/nodeterm-history.XXXXXXXX") || exit 2
            trap 'rm -f "${'$'}NT_HISTORY_FILE"' EXIT HUP INT TERM
            # Bound the spool even before wc: POSIX shells use 512- or 1024-byte file blocks.
            (ulimit -f 102400; "${'$'}NT_TMUX" -L $s capture-pane -p -J -t "${'$'}NT_PANE" -S - > "${'$'}NT_HISTORY_FILE") || exit 3
            NT_HISTORY_SIZE=${'$'}(wc -c < "${'$'}NT_HISTORY_FILE") || exit 3
            [ "${'$'}NT_HISTORY_SIZE" -le ${TerminalHistory.CAPTURE_BYTES} ] || exit 4
            LC_ALL=C NT_HISTORY_QUERY=${q(query)} awk '
              BEGIN { query=ENVIRON["NT_HISTORY_QUERY"]; count=0; bytes=0; truncated=0; output="" }
              { sub(/\r${'$'}/, ""); if (index(${'$'}0, query)) {
                  value=(NR-1) "\t" ${'$'}0 "\n";
                  if (count < ${TerminalHistory.MAX_ROWS} && bytes+length(value) <= ${TerminalHistory.MAX_BYTES}) {
                    output=output value; bytes+=length(value); count++
                  } else truncated=1
                }
              }
              END { printf "NT-HISTORY-1\t%d\t%d\n%s", NR, truncated, output }
            ' "${'$'}NT_HISTORY_FILE"
        """.trimIndent()
    }

    /**
     * Type into a pane. `-l --` so text is literal and a leading `-` is never an option (the
     * leading-dash hazard documented in tmux-naming.ts). A lone ESC is sent as the `Escape` key.
     * Resolve the exact session's pane once and leave copy mode before typing: tmux otherwise
     * accepts the keys into copy mode and exits successfully without delivering the answer.
     */
    fun sendKeys(nodeId: String, keys: String, socket: String, phoneCreation: String? = null): String {
        // A PANE target: `=name` alone is refused ("can't find pane", measured on tmux 3.4); the
        // exact-session form for a pane command is `=name:` — the session's current window/pane.
        val pane = q("=" + target(nodeId) + ":")
        val s = socket(socket)
        val send = when (keys) {
            "\u001b" -> "\"${'$'}NT_TMUX\" -L $s send-keys -t \"${'$'}NT_PANE\" Escape"
            "\r" -> "\"${'$'}NT_TMUX\" -L $s send-keys -t \"${'$'}NT_PANE\" Enter"
            else -> "\"${'$'}NT_TMUX\" -L $s send-keys -t \"${'$'}NT_PANE\" -l -- ${q(keys)}"
        }
        return """
            $PRELUDE
            $PHONE_GUARD
            [ -n "${'$'}NT_TMUX" ] || exit 127
            ${if (socket == TmuxNames.PHONE_SOCKET) "nt_phone_owned ${q(target(nodeId))} || exit 2" else ""}
            ${phonePin(socket, phoneCreation)}
            NT_STATE=${'$'}("${'$'}NT_TMUX" -L $s display-message -p -t $pane '#{pane_id} #{pane_in_mode}') || exit ${'$'}?
            NT_PANE=${'$'}{NT_STATE% *}
            case "${'$'}NT_PANE" in %*) ;; *) exit 1 ;; esac
            case "${'$'}{NT_PANE#%}" in ''|*[!0-9]*) exit 1 ;; esac
            case "${'$'}{NT_STATE##* }" in
              0) ;;
              1) "${'$'}NT_TMUX" -L $s send-keys -t "${'$'}NT_PANE" -X cancel || exit ${'$'}? ;;
              *) exit 1 ;;
            esac
            $send
        """.trimIndent()
    }

    /**
     * Answer a held PermissionRequest hook (docs/hook-reply-approvals.md): write `allow`/`deny` to
     * `~/.nodeterm/pending/<id>.answer` atomically (temp + mv). Prints `gone` when the request file
     * is no longer there — the hook already timed out or someone else answered.
     */
    fun answerApproval(pendingId: String, allow: Boolean): String {
        require(PENDING_ID.matches(pendingId)) { "unsafe pending id" }
        val decision = if (allow) "allow" else "deny"
        return """
            d="${'$'}HOME/.nodeterm/pending"
            if [ ! -f "${'$'}d/$pendingId.json" ]; then echo gone; exit 0; fi
            umask 077
            printf '%s' '$decision' > "${'$'}d/$pendingId.answer.tmp.${'$'}${'$'}" && mv -f "${'$'}d/$pendingId.answer.tmp.${'$'}${'$'}" "${'$'}d/$pendingId.answer" && echo sent
        """.trimIndent()
    }

    /** Bounded exact request + checksum. Never read another node's ticket by a path alias. */
    fun readHookRequest(nodeId: String, pendingId: String): String {
        require(dev.nodeterm.protocol.model.HookReplies.belongsToNode(nodeId, pendingId))
        return """
            r="${'$'}HOME/.nodeterm/pending/$pendingId.json"
            [ -f "${'$'}r" ] || { echo gone; exit 0; }
            [ ! -L "${'$'}r" ] || exit 2
            [ "${'$'}(head -c ${dev.nodeterm.protocol.model.HookReplies.MAX_BYTES + 1} "${'$'}r" | wc -c)" -le ${dev.nodeterm.protocol.model.HookReplies.MAX_BYTES} ] || exit 2
            c=${'$'}(cksum < "${'$'}r") || exit 2
            [ "${'$'}{c#* }" -le ${dev.nodeterm.protocol.model.HookReplies.MAX_BYTES} ] || exit 2
            body=${'$'}(head -c ${dev.nodeterm.protocol.model.HookReplies.MAX_BYTES + 1} "${'$'}r") || exit 2
            [ "${'$'}c" = "${'$'}(cksum < "${'$'}r")" ] || exit 2
            printf '%s\n%s' "${'$'}c" "${'$'}body"
        """.trimIndent()
    }

    fun answerHook(nodeId: String, pendingId: String, checksum: String): String {
        require(dev.nodeterm.protocol.model.HookReplies.belongsToNode(nodeId, pendingId))
        require(Regex("^[0-9]+ [0-9]+$").matches(checksum))
        return """
            d="${'$'}HOME/.nodeterm/pending"
            r="${'$'}d/$pendingId.json"
            [ -f "${'$'}r" ] || { echo gone; exit 0; }
            [ ! -L "${'$'}r" ] || exit 2
            [ "${'$'}(cksum < "${'$'}r")" = ${q(checksum)} ] || exit 2
            umask 077
            t="${'$'}d/$pendingId.answer.tmp.${'$'}${'$'}"
            trap 'rm -f "${'$'}t"' 0 HUP INT TERM
            cat > "${'$'}t" || exit 2
            [ -f "${'$'}r" ] || { echo gone; exit 0; }
            [ ! -L "${'$'}r" ] || exit 2
            [ "${'$'}(cksum < "${'$'}r")" = ${q(checksum)} ] || exit 2
            mv -f "${'$'}t" "${'$'}d/$pendingId.answer" && echo sent
        """.trimIndent()
    }

    /** The read-ack the host's ack sweep consumes (src/core/ack-sweep.ts): content = event id,
     *  atomic, umask 077. The node id becomes a file name, so it is held to the tmux-name alphabet. */
    fun ackRead(nodeId: String, eventId: String): String {
        require(Regex("^[A-Za-z0-9_-]{1,200}$").matches(nodeId)) { "unsafe node id" }
        return """
            d="${'$'}HOME/.nodeterm/acks"
            umask 077
            mkdir -p "${'$'}d" && printf '%s' ${q(eventId)} > "${'$'}d/$nodeId.seen.tmp.${'$'}${'$'}" && mv -f "${'$'}d/$nodeId.seen.tmp.${'$'}${'$'}" "${'$'}d/$nodeId.seen"
        """.trimIndent()
    }

    /** `~/.nodeterm/relay.json` (relay-advertise.ts) for late relay adoption. */
    fun readRelayAdvertisement(): String = "cat \"\$HOME/.nodeterm/relay.json\" 2>/dev/null; exit 0"

    val PENDING_ID = Regex("^[A-Za-z0-9_-]{1,160}$")

    /** A socket name is spliced into `tmux -L`, so accept only the app's known sockets. */
    private fun socket(name: String): String {
        require(name in TmuxNames.SOCKETS) { "unknown tmux socket" }
        return name
    }

    private fun phonePin(socket: String, creation: String?): String =
        if (socket == TmuxNames.PHONE_SOCKET) "[ \"${'$'}nt_creation\" = ${q(creation ?: "")} ] || exit 2" else ""

    private fun target(nodeId: String): String {
        val t = TmuxNames.sessionName(nodeId)
        require(TmuxNames.isSessionName(t)) { "unsafe session target" }
        return t
    }
}
