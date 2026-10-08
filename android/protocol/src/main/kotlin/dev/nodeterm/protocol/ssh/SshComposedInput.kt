package dev.nodeterm.protocol.ssh

import dev.nodeterm.protocol.host.ComposedInput
import dev.nodeterm.protocol.model.TmuxNames
import java.util.UUID

/** A receipt captured while THIS tmux viewer attaches, never resolved from a later selected node. */
internal data class SshInputViewer(
    val tty: String, val viewerPid: Long, val viewerCreated: String, val serverPid: Long,
    val session: String, val sessionCreated: String, val sessionId: String, val paneId: String, val panePid: Long,
    val viewerBirth: String, val serverBirth: String, val paneBirth: String,
) {
    val tuple: String get() = listOf(tty, viewerPid, viewerCreated, serverPid, session, sessionCreated, sessionId, paneId, panePid).joinToString("|")
}

/** Native tmux owns paste framing and the final client/pane gate in one command queue. */
internal object SshComposedInput {
    private const val FORMAT = "#{client_tty}|#{client_pid}|#{client_created}|#{pid}|#{session_name}|#{session_created}|#{session_id}|#{pane_id}|#{pane_pid}"
    private val number = Regex("^[1-9][0-9]*$")
    private fun birthValid(value: String) = value.length <= 128 &&
        (Regex("^linux:[0-9a-f-]{36}:[0-9]+$").matches(value) || Regex("^darwin:[A-Za-z]{3} [A-Za-z]{3} [0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$").matches(value))

    fun parse(raw: String, tty: String, nodeId: String): SshInputViewer? {
        val fields = raw.trim().split('|')
        if (fields.size != 13 || fields[0] != "NT-COMPOSED-VIEW" || fields[1] != tty || !ManagedViewHandshake.validTty(tty) ||
            fields[5] != TmuxNames.sessionName(nodeId) || !Regex("^\\$[0-9]+$").matches(fields[7]) ||
            !Regex("^%[0-9]+$").matches(fields[8]) || listOf(2, 3, 4, 6, 9).any { !number.matches(fields[it]) } ||
            listOf(10, 11, 12).any { !birthValid(fields[it]) }) return null
        val viewerPid = fields[2].toLongOrNull() ?: return null
        val serverPid = fields[4].toLongOrNull() ?: return null
        val panePid = fields[9].toLongOrNull() ?: return null
        return SshInputViewer(tty, viewerPid, fields[3], serverPid, fields[5], fields[6], fields[7], fields[8], panePid, fields[10], fields[11], fields[12])
    }

    private val birthFunction = """
        nt_input_birth() {
          case "${'$'}1" in ''|*[!0-9]*) return 1 ;; esac
          if [ -r "/proc/${'$'}1/stat" ]; then
            nt_boot=${'$'}(cat /proc/sys/kernel/random/boot_id) || return 1
            nt_stat=${'$'}(cat "/proc/${'$'}1/stat") || return 1
            nt_rest=${'$'}{nt_stat##*) }; set -- ${'$'}nt_rest
            [ "${'$'}#" -ge 20 ] || return 1; shift 19
            case "${'$'}1" in ''|*[!0-9]*) return 1 ;; esac
            printf 'linux:%s:%s' "${'$'}nt_boot" "${'$'}1"
          else
            nt_started=${'$'}(LC_ALL=C ps -o lstart= -p "${'$'}1" 2>/dev/null | awk '{ ${'$'}1=${'$'}1; print }') || return 1
            [ -n "${'$'}nt_started" ] || return 1
            printf 'darwin:%s' "${'$'}nt_started"
          fi
        }
    """.trimIndent()

    private fun clients(socket: String, session: String, tty: String) =
        "\"\$NT_TMUX\" -L ${SshScripts.q(socket)} list-clients -t ${SshScripts.q("=$session")} -F ${SshScripts.q(FORMAT)} | awk -F '|' -v tty=${SshScripts.q(tty)} '\$1 == tty { print }'"

    fun capture(nodeId: String, socket: String, tty: String, creation: String?): String {
        require(ManagedViewHandshake.validTty(tty))
        val query = clients(socket, TmuxNames.sessionName(nodeId), tty)
        return """
            ${SshScripts.composedPrelude(nodeId, socket, creation)}
            $birthFunction
            nt_wait=0; nt_row=''
            while [ "${'$'}nt_wait" -lt 30 ]; do
              nt_row=${'$'}($query) || exit 3
              [ -n "${'$'}nt_row" ] && break
              nt_wait=${'$'}((nt_wait + 1)); sleep 0.1
            done
            [ -n "${'$'}nt_row" ] || exit 3
            nt_viewer=${'$'}(printf '%s' "${'$'}nt_row" | cut -d '|' -f 2)
            nt_server=${'$'}(printf '%s' "${'$'}nt_row" | cut -d '|' -f 4)
            nt_pane=${'$'}(printf '%s' "${'$'}nt_row" | cut -d '|' -f 9)
            nt_vbirth=${'$'}(nt_input_birth "${'$'}nt_viewer") || exit 3
            nt_sbirth=${'$'}(nt_input_birth "${'$'}nt_server") || exit 3
            nt_pbirth=${'$'}(nt_input_birth "${'$'}nt_pane") || exit 3
            [ "${'$'}($query)" = "${'$'}nt_row" ] || exit 3
            printf 'NT-COMPOSED-VIEW|%s|%s|%s|%s\n' "${'$'}nt_row" "${'$'}nt_vbirth" "${'$'}nt_sbirth" "${'$'}nt_pbirth"
        """.trimIndent()
    }

    fun send(nodeId: String, socket: String, creation: String?, viewer: SshInputViewer, input: ComposedInput): String {
        require(input.valid() && parse("NT-COMPOSED-VIEW|${viewer.tuple}|${viewer.viewerBirth}|${viewer.serverBirth}|${viewer.paneBirth}", viewer.tty, nodeId) == viewer)
        require(input !is ComposedInput.Paste || input.text.isEmpty() || !input.enter) { "Paste and Enter require separate guarded dispatches" }
        val pane = viewer.paneId
        val buffer = "nt-paste-" + UUID.randomUUID().toString().replace("-", "")
        val parts = listOf("#{==:#{pid},${viewer.serverPid}}", "#{==:#{session_id},${viewer.sessionId}}",
            "#{==:#{session_created},${viewer.sessionCreated}}", "#{==:#{pane_id},$pane}", "#{==:#{pane_pid},${viewer.panePid}}")
        val client = listOf("#{==:#{client_tty},${viewer.tty}}", "#{==:#{client_pid},${viewer.viewerPid}}",
            "#{==:#{client_created},${viewer.viewerCreated}}", "#{==:#{client_session},${viewer.session}}", "#{==:#{pid},${viewer.serverPid}}",
            "#{==:#{session_id},${viewer.sessionId}}", "#{==:#{session_created},${viewer.sessionCreated}}",
            "#{==:#{pane_id},$pane}", "#{==:#{pane_pid},${viewer.panePid}}")
            .reduce { a, b -> "#{&&:$a,$b}" }
        val condition = (parts + "#{L:#{?$client,1,}}").reduce { a, b -> "#{&&:$a,$b}" }
        val cancel = "if-shell -F -t $pane '#{pane_in_mode}' 'send-keys -t $pane -X cancel'"
        val write = when (input) {
            is ComposedInput.Control -> "send-keys -t $pane -H ${input.text[0].code.toString(16).padStart(2, '0')}"
            is ComposedInput.Paste -> (if (input.text.isNotEmpty()) "paste-buffer -d -p -r -b $buffer -t $pane ; " else "") +
                (if (input.enter) "send-keys -t $pane Enter ; " else "") + "display-message -p nt-composed-delivered"
        }
        val yes = "$cancel ; $write" + if (input is ComposedInput.Control) " ; display-message -p nt-composed-delivered" else ""
        val no = "display-message -p nt-composed-refused"
        val query = clients(socket, viewer.session, viewer.tty)
        val hasBuffer = input is ComposedInput.Paste && input.text.isNotEmpty()
        return """
            ${SshScripts.composedPrelude(nodeId, socket, creation)}
            $birthFunction
            [ "${'$'}($query)" = ${SshScripts.q(viewer.tuple)} ] || { printf 'nt-composed-refused\n'; exit 0; }
            [ "${'$'}(nt_input_birth ${viewer.viewerPid})" = ${SshScripts.q(viewer.viewerBirth)} ] &&
            [ "${'$'}(nt_input_birth ${viewer.serverPid})" = ${SshScripts.q(viewer.serverBirth)} ] &&
            [ "${'$'}(nt_input_birth ${viewer.panePid})" = ${SshScripts.q(viewer.paneBirth)} ] || { printf 'nt-composed-refused\n'; exit 0; }
            ${if (hasBuffer) "trap '\"\$NT_TMUX\" -L ${SshScripts.q(socket)} delete-buffer -b $buffer >/dev/null 2>&1 || :' EXIT HUP INT TERM" else ""}
            "${'$'}NT_TMUX" -L ${SshScripts.q(socket)} ${if (hasBuffer) "load-buffer -b $buffer - \\;" else ""} \
              if-shell -F -t ${SshScripts.q(pane)} ${SshScripts.q(condition)} ${SshScripts.q(yes)} ${SshScripts.q(no)}
        """.trimIndent()
    }
}
