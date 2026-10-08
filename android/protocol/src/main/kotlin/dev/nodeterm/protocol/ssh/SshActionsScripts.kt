package dev.nodeterm.protocol.ssh

/** Files are private to the authenticated OS user; no hook bearer or second workspace writer. */
internal object SshActionsScripts {
    const val MAX_BYTES = 128 * 1024
    const val UNAVAILABLE = "NT-ACTIONS-UNAVAILABLE"
    private fun q(value: String) = SshScripts.q(value)
    private val guards = """
        umask 077
        uid=$(id -u) || exit 3
        meta() { stat -c '%u %a %h %s %d %i' -- "${'$'}1" 2>/dev/null || stat -f '%u %Lp %l %z %d %i' "${'$'}1" 2>/dev/null; }
        dir() {
          [ -d "${'$'}1" ] && [ ! -L "${'$'}1" ] || return 1
          mask=${'$'}2; m=$(meta "${'$'}1") || return 1; set -- ${'$'}m
          [ "${'$'}1" = "${'$'}uid" ] || return 1
          mode=${'$'}2; [ ${'$'}((0${'$'}mode & ${'$'}mask)) -eq 0 ]
        }
        read_private() {
          [ -f "${'$'}1" ] && [ ! -L "${'$'}1" ] || return 1
          before=$(meta "${'$'}1") || return 1; set -- "${'$'}1" ${'$'}before
          [ "${'$'}2" = "${'$'}uid" ] && [ ${'$'}((0${'$'}3 & 077)) -eq 0 ] && [ "${'$'}4" = 1 ] && [ "${'$'}5" -le 131072 ] || return 1
          value=$(head -c 131073 "${'$'}1") || return 1
          after=$(meta "${'$'}1") || return 1
          [ "${'$'}before" = "${'$'}after" ] || return 1
        }
        clock() { seconds=$(date +%s) || return 1; now=${'$'}((seconds * 1000)); }
        unavailable() { echo NT-ACTIONS-UNAVAILABLE; exit 3; }
    """.trimIndent()

    fun validProfile(path: String): Boolean = path.startsWith('/') && path.length <= 4096 && path.none { it.code < 32 || it.code in 127..159 }

    fun probe(userData: String): String {
        require(validProfile(userData))
        return guards + "\n" + """
            ud=${q(userData)}
            root="${'$'}ud/ssh-actions"
            dir "${'$'}ud" 022 && dir "${'$'}root" 077 && read_private "${'$'}root/advertisement.json" || unavailable
            clock || unavailable
            printf 'NT-ACTIONS-1\t%s\n%s\n' "${'$'}now" "${'$'}value"
        """.trimIndent()
    }

    /** Final attachment reads the same selected profile and a fresh unchanged service identity. */
    fun adoptionGuard(userData: String, ad: SshActions.Advertisement): String {
        require(validProfile(userData))
        val identity = ad.raw.replace(Regex("\"updatedAt\":\\d+"), "\"updatedAt\":0")
        return guards + "\n" + """
            ud=${q(userData)}; root="${'$'}ud/ssh-actions"; directory="${'$'}root/${ad.instance}"
            expected=${q(identity)}
            nt_managed_ad() {
              dir "${'$'}ud" 022 && dir "${'$'}root" 077 && dir "${'$'}directory" 077 && read_private "${'$'}root/advertisement.json" || return 1
              identity=$(printf '%s' "${'$'}value" | sed 's/"updatedAt":[0-9][0-9]*/"updatedAt":0/')
              [ "${'$'}identity" = "${'$'}expected" ] || return 1
              stamp=$(printf '%s' "${'$'}value" | sed -n 's/.*"updatedAt":\([0-9][0-9]*\).*/\1/p')
              case "${'$'}stamp" in ''|*[!0-9]*) return 1;; esac
              clock || return 1
              [ "${'$'}stamp" -le ${'$'}((now + 30000)) ] && [ "${'$'}stamp" -ge ${'$'}((now - 15000)) ]
            }
            nt_managed_ad || unavailable
        """.trimIndent()
    }

    /** Heartbeats may replace the descriptor; only immutable identity/capability fields are pinned. */
    fun submit(userData: String, ad: SshActions.Advertisement, nonce: String): String {
        require(validProfile(userData) && SshActions.UUID.matches(nonce))
        val identity = ad.raw.replace(Regex("\"updatedAt\":\\d+"), "\"updatedAt\":0")
        return guards + "\n" + """
            ud=${q(userData)}; root="${'$'}ud/ssh-actions"; instance=${q(ad.instance)}
            expected=${q(identity)}; directory="${'$'}root/${'$'}instance"
            check_ad() {
              dir "${'$'}ud" 022 && dir "${'$'}root" 077 && dir "${'$'}directory" 077 && read_private "${'$'}root/advertisement.json" || return 1
              identity=$(printf '%s' "${'$'}value" | sed 's/"updatedAt":[0-9][0-9]*/"updatedAt":0/')
              [ "${'$'}identity" = "${'$'}expected" ] || return 1
              stamp=$(printf '%s' "${'$'}value" | sed -n 's/.*"updatedAt":\([0-9][0-9]*\).*/\1/p')
              case "${'$'}stamp" in ''|*[!0-9]*) return 1;; esac
              clock || return 1
              [ "${'$'}stamp" -le ${'$'}((now + 30000)) ] && [ "${'$'}stamp" -ge ${'$'}((now - 15000)) ]
            }
            check_ad || unavailable
            tmp="${'$'}directory/.${nonce}.upload"; request="${'$'}directory/${nonce}.request"; response="${'$'}directory/${nonce}.response"
            [ ! -e "${'$'}request" ] && [ ! -L "${'$'}request" ] && [ ! -e "${'$'}response" ] && [ ! -L "${'$'}response" ] || { echo NT-ACTIONS-UNCERTAIN; exit 4; }
            (set -C; : > "${'$'}tmp") 2>/dev/null || { echo NT-ACTIONS-UNCERTAIN; exit 4; }
            trap 'rm -f "${'$'}tmp"' EXIT HUP INT TERM
            # The client limits UTF-8 input before dispatch; cap stdin again on the host.
            head -c 131073 > "${'$'}tmp" || exit 4
            size=$(wc -c < "${'$'}tmp"); [ "${'$'}size" -le 131072 ] || exit 4
            check_ad || unavailable
            # Rename publishes one complete regular file; -n refuses an existing nonce without overwriting it.
            mv -n "${'$'}tmp" "${'$'}request" || { echo NT-ACTIONS-UNCERTAIN; exit 4; }
            [ ! -e "${'$'}tmp" ] || { echo NT-ACTIONS-UNCERTAIN; exit 4; }
            i=0
            while [ "${'$'}i" -lt 30 ]; do
              if [ -e "${'$'}response" ] || [ -L "${'$'}response" ]; then
                read_private "${'$'}response" || { echo NT-ACTIONS-UNCERTAIN; exit 4; }
                printf 'NT-ACTIONS-REPLY\n%s\n' "${'$'}value"; exit 0
              fi
              check_ad || { echo NT-ACTIONS-UNCERTAIN; exit 4; }
              i=${'$'}((i + 1)); sleep 0.5
            done
            echo NT-ACTIONS-UNCERTAIN; exit 4
        """.trimIndent()
    }
}
