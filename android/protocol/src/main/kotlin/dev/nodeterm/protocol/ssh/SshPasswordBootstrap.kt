package dev.nodeterm.protocol.ssh

import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.HostUnansweredException
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.pairing.SshIdentity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.method.AuthPassword
import net.schmizz.sshj.userauth.password.PasswordFinder
import net.schmizz.sshj.userauth.password.Resource
import java.io.IOException
import java.net.InetAddress
import java.net.Socket
import java.security.PublicKey
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.SocketFactory
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Optional, password-only enrollment for a computer added by SSH address. Inspection sends no
 * authentication. The caller must show the fingerprint and obtain the user's confirmation before
 * calling [Inspection.confirm]. No password, private key or SSH identity is persisted here.
 *
 * Enrollment installs only the supplied retained identity's public line. It closes the password
 * connection and proves a new, pinned public-key login before returning a record the caller may save.
 * Keyboard-interactive, MFA and password changes are deliberately not attempted.
 */
object SshPasswordBootstrap {
    const val INSPECT_TIMEOUT_MS = 15_000L
    const val INSTALL_TIMEOUT_MS = 45_000L
    private const val MAX_TIMEOUT_MS = 60_000L
    private const val MAX_OUTPUT = 4096
    private val workers = Executors.newCachedThreadPool { r ->
        Thread(r, "nodeterm-ssh-enrollment").apply { isDaemon = true }
    }

    class Inspection internal constructor(val address: ManualHost.Address, val fingerprint: String) {
        /** Call only following an explicit user confirmation of this displayed fingerprint. */
        fun confirm(fingerprint: String): ConfirmedHost {
            require(fingerprint == this.fingerprint) { "Confirm the fingerprint inspected for this computer." }
            return ConfirmedHost(address, fingerprint)
        }
    }

    class ConfirmedHost internal constructor(val address: ManualHost.Address, val fingerprint: String) {
        internal val used = AtomicBoolean(false)
    }

    /** Connect and complete key exchange, then close without offering any authentication method. */
    suspend fun inspect(
        address: ManualHost.Address,
        timeoutMs: Long = INSPECT_TIMEOUT_MS,
        socketFactory: SocketFactory? = null
    ): Inspection = operation(timeoutMs, { HostException("SSH host key inspection timed out. ${ManualHost.UNREACHABLE_ADVICE}") }) { resources ->
        val observed = VerifiedKey(null)
        val client = resources.client(observed, socketFactory, timeoutMs)
        try {
            client.connect(address.host, address.port)
            resources.check()
            Inspection(address, observed.fingerprint ?: throw HostException("The SSH server did not present a host key."))
        } catch (e: Exception) {
            observed.mismatch?.let { throw it }
            if (e is HostException || e is CancellationException) throw e
            throw HostException("Could not inspect this computer's SSH host key. ${ManualHost.UNREACHABLE_ADVICE}")
        }
    }

    /**
     * Consumes [confirmed] once and clears the caller's [password] buffer, including on failure.
     * Passwords remain memory-only; the SSH library/JVM may make transient copies that cannot be erased.
     * A lost command acknowledgement is uncertain and is never replayed. Check the computer or try a
     * normal key connection instead. Cancelling leaves any already-installed public key in place.
     */
    suspend fun install(
        confirmed: ConfirmedHost,
        identity: SshIdentity,
        password: CharArray,
        id: String = ManualHost.newId(),
        now: Long = System.currentTimeMillis(),
        timeoutMs: Long = INSTALL_TIMEOUT_MS,
        socketFactory: SocketFactory? = null
    ): PairedHost {
        val secret = password.copyOf()
        password.fill('\u0000')
        try {
            require(secret.isNotEmpty() && secret.size <= 4096) { "Enter a password of at most 4096 characters." }
            require(HostKeyAnchors.isFingerprint(confirmed.fingerprint)) { "Confirm a valid SSH host fingerprint first." }
            check(confirmed.used.compareAndSet(false, true)) { "This enrollment was already attempted. Inspect and confirm again before another attempt." }
            val dispatched = AtomicBoolean(false)
            return operation(timeoutMs, {
                if (dispatched.get()) HostUnansweredException(UNCONFIRMED)
                else HostException("Password enrollment timed out. ${ManualHost.UNREACHABLE_ADVICE}")
            }) { resources ->
                val address = confirmed.address
                val observed = VerifiedKey(confirmed.fingerprint)
                val client = resources.client(observed, socketFactory, timeoutMs)
                try {
                    client.connect(address.host, address.port)
                    resources.check()
                    // SSHClient.authPassword also offers keyboard-interactive. Use password only,
                    // once, and never answer an unsolicited MFA or password-change prompt.
                    client.auth(address.user, AuthPassword(object : PasswordFinder {
                        private var offered = false
                        override fun reqPassword(resource: Resource<*>): CharArray {
                            resources.check()
                            check(!offered) { "The server requested another password attempt." }
                            offered = true
                            return secret
                        }
                        override fun shouldRetry(resource: Resource<*>): Boolean = false
                    }))
                    secret.fill('\u0000')
                    resources.check()
                    client.startSession().use { session ->
                        // Even loss of the exec acknowledgement may mean the write ran.
                        dispatched.set(true)
                        val command = session.exec(installCommand(identity))
                        command.outputStream.close()
                        // Both windows must drain: a server writing stderr first must not stall
                        // stdout. Each is capped and none of the server's text is surfaced.
                        val errors = workers.submit { drain(command.errorStream) }
                        try {
                            drain(command.inputStream)
                            errors.get()
                        } finally {
                            errors.cancel(true)
                        }
                        command.join(5, TimeUnit.SECONDS)
                        resources.check()
                        if (command.exitStatus == null) throw IOException("The computer did not confirm the key installation.")
                        if (command.exitStatus != 0) throw HostException("The computer could not install this phone's public key. Check ~/.ssh and authorized_keys permissions on the computer.")
                    }
                    // Independent public-key authentication, with the confirmed host pin. Never
                    // fall back to the password or pin the first server accepting the new key.
                    resources.close(client)
                    resources.check()
                    val pin = object : HostKeyPin {
                        override fun pinned(): String = confirmed.fingerprint
                        override fun pin(fingerprint: String) = Unit
                    }
                    SshHostConnection.connect(address.host, address.port, address.user, identity, pin,
                        timeoutMs.toInt(), resources.sockets(socketFactory)).use { resources.check() }
                    resources.check()
                    ManualHost.record(address, confirmed.fingerprint, id, now)
                } catch (e: Exception) {
                    observed.mismatch?.let { throw it }
                    if (e is CancellationException || e is HostKeyChangedException) throw e
                    if (dispatched.get() && e !is HostException) throw HostUnansweredException(UNCONFIRMED)
                    if (dispatched.get()) throw HostException(
                        "Enrollment did not complete a new login with the phone's key. The public key may already be installed; no computer was saved. Check ~/.ssh and authorized_keys permissions on the computer."
                    )
                    if (SshHostConnection.isAuthRefusal(e)) throw HostException(
                        "The computer did not accept the password. Password-only SSH login must be enabled; keyboard-interactive and MFA are not supported."
                    )
                    if (e is HostException) throw e
                    throw HostException("Password enrollment could not connect. ${ManualHost.UNREACHABLE_ADVICE}")
                }
            }
        } finally {
            secret.fill('\u0000')
        }
    }

    private const val UNCONFIRMED = "The computer did not confirm enrollment. Its public key may already be installed. Try connecting with the phone's key or check authorized_keys on the computer; this attempt will not be repeated."

    private fun drain(input: java.io.InputStream) {
        val buffer = ByteArray(512)
        var size = 0
        while (true) {
            val n = input.read(buffer)
            if (n < 0) return
            size += n
            if (size > MAX_OUTPUT) throw IOException("Enrollment output exceeded its limit.")
        }
    }

    /** Fixed public-key command; the password and private seed never enter shell text or stdin. */
    internal fun installCommand(identity: SshIdentity): String {
        // GNU/Linux and BSD/macOS stat spell these public inode checks differently. Neither reads
        // any existing key contents; reject unsafe paths before the legacy manual command's chmod.
        val guard = "nt_uid=\$(id -u) || exit 2; " +
            "nt_owner() { stat -c %u \"\$1\" 2>/dev/null || stat -f %u \"\$1\" 2>/dev/null; }; " +
            "nt_links() { stat -c %h \"\$1\" 2>/dev/null || stat -f %l \"\$1\" 2>/dev/null; }; " +
            "[ ! -L \"\$HOME/.ssh\" ] && " +
            "{ [ ! -e \"\$HOME/.ssh\" ] || { [ -d \"\$HOME/.ssh\" ] && [ \"\$(nt_owner \"\$HOME/.ssh\")\" = \"\$nt_uid\" ]; }; } && " +
            "[ ! -L \"\$HOME/.ssh/authorized_keys\" ] && " +
            "{ [ ! -e \"\$HOME/.ssh/authorized_keys\" ] || { [ -f \"\$HOME/.ssh/authorized_keys\" ] && " +
            "[ \"\$(nt_owner \"\$HOME/.ssh/authorized_keys\")\" = \"\$nt_uid\" ] && " +
            "[ \"\$(nt_links \"\$HOME/.ssh/authorized_keys\")\" = 1 ]; }; } || exit 2; "
        val blob = ManualHost.authorizedKeysLine(identity).split(' ')[1]
        // Only the algorithm/blob immediately after the first optional-options token is a key.
        // A later comment must never suppress installation; an existing restricted declaration
        // must never cause an unrestricted duplicate. Unterminated options fail closed.
        val scanner = """
            function boundary(s, i, quoted, escaped, c) {
                quoted=0; escaped=0;
                for (i=1; i<=length(s); i++) {
                    c=substr(s,i,1);
                    if (escaped) { escaped=0; continue; }
                    if (quoted && c=="\\") { escaped=1; continue; }
                    if (c=="\"") { quoted=!quoted; continue; }
                    if (!quoted && c ~ /[[:space:]]/) return i;
                }
                if (quoted || escaped) return -1;
                return length(s)+1;
            }
            {
                line=${'$'}0; sub(/^[[:space:]]+/,"",line);
                if (line=="" || substr(line,1,1)=="#") next;
                cut=boundary(line);
                if (cut<0) { ambiguous=1; next; }
                algorithm=substr(line,1,cut-1);
                rest=substr(line,cut); sub(/^[[:space:]]+/,"",rest);
                if (algorithm!="ssh-ed25519") {
                    if (algorithm ~ /^(ssh-|ecdsa-|sk-)/) next;
                    cut=boundary(rest);
                    if (cut<0) { ambiguous=1; next; }
                    algorithm=substr(rest,1,cut-1);
                    rest=substr(rest,cut); sub(/^[[:space:]]+/,"",rest);
                }
                cut=boundary(rest);
                if (algorithm=="ssh-ed25519" && cut>0 && substr(rest,1,cut-1)==nt_key) found=1;
            }
            END { if (ambiguous) exit 2; exit !found; }
        """.trimIndent()
        val existing = "if [ -f \"\$HOME/.ssh/authorized_keys\" ]; then awk -v nt_key='$blob' " +
            SshScripts.q(scanner) + " \"\$HOME/.ssh/authorized_keys\"; nt_scan=\$?; " +
            "case \$nt_scan in 0) exit 0 ;; 1) ;; *) exit 2 ;; esac; fi; "
        return "/bin/sh -c " + SshScripts.q(guard + existing + ManualHost.installCommand(ManualHost.authorizedKeysLine(identity)))
    }

    private class VerifiedKey(private val expected: String?) : HostKeyVerifier {
        var fingerprint: String? = null
        var mismatch: HostKeyChangedException? = null
        override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
            val actual = SshHostConnection.hostKeyFingerprint(key)
            val want = expected ?: fingerprint
            if (want != null && want != actual) {
                mismatch = HostKeyChangedException(want, actual)
                return false
            }
            fingerprint = actual
            return true
        }
        override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
    }

    private class Resources {
        private var cancelled = false
        private val sockets = ArrayList<Socket>()
        private val clients = ArrayList<SSHClient>()
        @Synchronized fun check() { if (cancelled) throw CancellationException("SSH enrollment cancelled") }
        @Synchronized private fun remember(socket: Socket): Socket {
            if (cancelled) { socket.close(); throw CancellationException("SSH enrollment cancelled") }
            sockets += socket
            return socket
        }
        fun sockets(factory: SocketFactory?) = object : SocketFactory() {
            private val delegate = factory ?: SocketFactory.getDefault()
            override fun createSocket(): Socket = remember(delegate.createSocket())
            override fun createSocket(host: String, port: Int): Socket = remember(delegate.createSocket(host, port))
            override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket = remember(delegate.createSocket(host, port, local, localPort))
            override fun createSocket(host: InetAddress, port: Int): Socket = remember(delegate.createSocket(host, port))
            override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket = remember(delegate.createSocket(host, port, local, localPort))
        }
        @Synchronized fun client(verifier: HostKeyVerifier, factory: SocketFactory?, timeoutMs: Long): SSHClient {
            check()
            return SSHClient().also {
                it.socketFactory = sockets(factory)
                it.addHostKeyVerifier(verifier)
                it.connectTimeout = timeoutMs.toInt()
                it.timeout = timeoutMs.toInt()
                clients += it
            }
        }
        fun close(client: SSHClient) { runCatching { client.close() } }
        fun cancel() {
            val owned = synchronized(this) { cancelled = true; sockets.toList() }
            owned.forEach { runCatching { it.close() } }
        }
        fun finish() {
            cancel()
            clients.forEach(::close)
        }
    }

    private data class Completed<T>(val value: T)

    private suspend fun <T> operation(timeoutMs: Long, timeoutFailure: () -> HostException, work: (Resources) -> T): T {
        require(timeoutMs in 1..MAX_TIMEOUT_MS) { "SSH enrollment timeout must be between 1 and $MAX_TIMEOUT_MS ms." }
        return withTimeoutOrNull(timeoutMs) {
            suspendCancellableCoroutine<Completed<T>> { continuation ->
                val resources = Resources()
                var task: Future<*>? = null
                continuation.invokeOnCancellation { resources.cancel(); task?.cancel(true) }
                task = workers.submit {
                    try {
                        val result = work(resources)
                        resources.finish()
                        if (continuation.isActive) continuation.resume(Completed(result))
                    } catch (e: Exception) {
                        if (continuation.isActive) continuation.resumeWithException(e)
                    } finally {
                        resources.finish()
                    }
                }
                if (!continuation.isActive) task?.cancel(true)
            }
        }?.value ?: throw timeoutFailure()
    }
}
