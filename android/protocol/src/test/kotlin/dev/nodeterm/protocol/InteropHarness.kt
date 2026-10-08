package dev.nodeterm.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Runs `src/test/interop/host-fixture.ts` — the DESKTOP's own relay host / pairing code — in a node
 * child process. Skips (never fails) when this checkout has no node or no `npm ci` yet, so a
 * JVM-only contributor still gets a green protocol build; CI installs both and runs everything.
 *
 * The bundle aliases `electron` to `src/test/interop/electron-stub.ts` (audit A60): the real package's
 * `require` downloads the Electron binary when it is missing, as it is after any fresh `npm ci` (the
 * package has no install script), and that download ran inside the 20 s ready wait.
 * [InteropHarnessTest] pins the alias and the kill of a process whose ready wait failed.
 *
 * Every process it starts is `node` itself, bundling included (audit A70): npm's `.bin` shims are sh
 * scripts on Windows, which Java's ProcessBuilder (CreateProcess) cannot run.
 */
class InteropHarness private constructor(private val process: Process) : AutoCloseable {
    private val lines = LinkedBlockingQueue<JsonObject>()
    private val seen = ArrayList<JsonObject>()
    lateinit var ready: JsonObject
        private set

    private fun startReader() {
        Thread({
            process.inputStream.bufferedReader().forEachLine { line ->
                val obj = runCatching { Json.parseToJsonElement(line).jsonObject }.getOrNull()
                if (obj != null) lines.put(obj) else System.err.println("[fixture] $line")
            }
        }, "interop-stdout").apply { isDaemon = true }.start()
        Thread({
            process.errorStream.bufferedReader().forEachLine { System.err.println("[fixture:err] $it") }
        }, "interop-stderr").apply { isDaemon = true }.start()
    }

    /** Wait for the next event matching [predicate] (earlier non-matching events are kept for later waits). */
    fun await(timeoutMs: Long = 10_000, predicate: (JsonObject) -> Boolean): JsonObject {
        synchronized(seen) {
            seen.firstOrNull(predicate)?.let {
                seen.remove(it)
                return it
            }
        }
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val left = deadline - System.currentTimeMillis()
            if (left <= 0) throw AssertionError("fixture event not seen within ${timeoutMs}ms; saw: ${synchronized(seen) { seen.toList() }}")
            val next = lines.poll(left, TimeUnit.MILLISECONDS) ?: continue
            if (next["event"]?.toString() == "\"fatal\"") throw AssertionError("fixture died: $next")
            if (predicate(next)) return next
            synchronized(seen) { seen.add(next) }
        }
    }

    internal fun command(line: String) {
        process.outputStream.write((line + "\n").toByteArray(Charsets.UTF_8)); process.outputStream.flush()
    }

    fun awaitEvent(name: String, timeoutMs: Long = 10_000): JsonObject =
        await(timeoutMs) { it["event"]?.toString() == "\"$name\"" }

    /** Call only after an awaited producer control barrier; inspect every earlier leftover event. */
    internal fun drainEvents(): List<JsonObject> = synchronized(seen) {
        ArrayList(seen).also { out -> seen.clear(); lines.drainTo(out) }
    }

    override fun close() {
        // Taken before node exits: after that its children are re-parented and unreachable from here.
        val descendants = process.descendants().toList()
        process.destroy()
        if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly()
        descendants.forEach { it.destroy() }
    }

    companion object {
        val repoRoot: File = File(System.getProperty("nodeterm.repoRoot") ?: "../..").canonicalFile

        /** Where the fixture's `electron` import resolves to instead of the npm package. */
        const val ELECTRON_STUB = "android/protocol/src/test/interop/electron-stub.ts"

        /** Bundles host-fixture.ts through esbuild's JS API; see its header for why not the CLI (audit A70). */
        const val BUNDLER = "android/protocol/src/test/interop/bundle-fixture.cjs"

        /**
         * The bundle step's argv. Its program is `node`, never a file under node_modules: npm's
         * `.bin/esbuild` is a sh shim on Windows, which CreateProcess cannot run, so every interop test
         * errored there instead of running (audit A70). `node` resolves to node.exe on PATH.
         */
        internal fun bundleCommand(out: File): List<String> = listOf("node", BUNDLER, out.path, ELECTRON_STUB)

        internal val bundle: File by lazy {
            val out = File(repoRoot, "android/protocol/build/interop/host-fixture.cjs")
            File(out.path + ".meta.json").delete() // never read a previous build's metafile
            val proc = ProcessBuilder(bundleCommand(out)).directory(repoRoot).redirectErrorStream(true).start()
            val log = proc.inputStream.bufferedReader().readText()
            check(proc.waitFor() == 0) { "esbuild failed: $log" }
            out
        }

        /** The ack filesystem contract has no relay sockets/crypto dependencies. */
        private val ackBundle: File by lazy {
            val out = File(repoRoot, "android/protocol/build/interop/ack-fixture.cjs")
            val proc = ProcessBuilder(bundleCommand(out) + "android/protocol/src/test/interop/ack-fixture-runner.ts")
                .directory(repoRoot).redirectErrorStream(true).start()
            val log = proc.inputStream.bufferedReader().readText()
            check(proc.waitFor() == 0) { "esbuild failed: $log" }
            out
        }

        internal val projectLaunchBundle: File by lazy {
            val out = File(repoRoot, "android/protocol/build/interop/project-launch-fixture.cjs")
            val proc = ProcessBuilder(bundleCommand(out) + "android/protocol/src/test/interop/project-launch-fixture.ts")
                .directory(repoRoot).redirectErrorStream(true).start()
            val log = proc.inputStream.bufferedReader().readText()
            check(proc.waitFor() == 0) { "esbuild failed: $log" }
            out
        }

        /** Actual selected-profile SSH file service and WorkspaceStore; no relay sockets. */
        internal val sshActionsBundle: File by lazy {
            val out = File(repoRoot, "android/protocol/build/interop/ssh-actions-fixture.cjs")
            File(out.path + ".meta.json").delete()
            val proc = ProcessBuilder(bundleCommand(out) + "android/protocol/src/test/interop/ssh-actions-fixture.ts")
                .directory(repoRoot).redirectErrorStream(true).start()
            val log = proc.inputStream.bufferedReader().readText()
            check(proc.waitFor() == 0) { "esbuild failed: $log" }
            out
        }
        internal val sshActionsBundleMeta: File by lazy { File(sshActionsBundle.path + ".meta.json") }

        /** Actual selected Server config/platform/store/mirror, with a private OS-home abstraction. */
        internal val serverProfileBundle: File by lazy {
            val out = File(repoRoot, "android/protocol/build/interop/server-profile-fixture.cjs")
            File(out.path + ".meta.json").delete()
            val proc = ProcessBuilder(bundleCommand(out) + "android/protocol/src/test/interop/server-profile-fixture.ts")
                .directory(repoRoot).redirectErrorStream(true).start()
            val log = proc.inputStream.bufferedReader().readText()
            check(proc.waitFor() == 0) { "esbuild failed: $log" }
            out
        }
        internal val serverProfileBundleMeta: File by lazy { File(serverProfileBundle.path + ".meta.json") }

        /** Actual public relay-advertisement writer/remover, with a fixture-only OS-home adapter. */
        internal val relayAdvertisementBundle: File by lazy {
            val out = File(repoRoot, "android/protocol/build/interop/relay-advertisement-fixture.cjs")
            File(out.path + ".meta.json").delete()
            val proc = ProcessBuilder(bundleCommand(out) + "android/protocol/src/test/interop/relay-advertisement-fixture.ts")
                .directory(repoRoot).redirectErrorStream(true).start()
            val log = proc.inputStream.bufferedReader().readText()
            check(proc.waitFor() == 0) { "esbuild failed: $log" }
            out
        }
        internal val relayAdvertisementBundleMeta: File by lazy { File(relayAdvertisementBundle.path + ".meta.json") }

        /** Actual managed host transaction with an explicit native-process recorder boundary. */
        internal val managedSessionBundle: File by lazy {
            val out = File(repoRoot, "android/protocol/build/interop/managed-session-fixture.cjs")
            File(out.path + ".meta.json").delete()
            val proc = ProcessBuilder(bundleCommand(out) + "android/protocol/src/test/interop/managed-session-fixture.ts")
                .directory(repoRoot).redirectErrorStream(true).start()
            val log = proc.inputStream.bufferedReader().readText()
            check(proc.waitFor() == 0) { "esbuild failed: $log" }
            out
        }
        internal val managedSessionBundleMeta: File by lazy { File(managedSessionBundle.path + ".meta.json") }

        /**
         * esbuild's metafile for [bundle], which the bundler writes beside it: its `inputs` are the files
         * the bundle was built from, repo-relative and `/`-separated (audit A63, [WorkflowPathFilterTest]).
         */
        internal val bundleMeta: File by lazy { File(bundle.path + ".meta.json") }
        internal val ackBundleMeta: File by lazy { File(ackBundle.path + ".meta.json") }
        internal val projectLaunchBundleMeta: File by lazy { File(projectLaunchBundle.path + ".meta.json") }

        /**
         * Home-directory variables pointing a fixture at [home]. `os.homedir()` reads HOME on POSIX and
         * USERPROFILE on Windows, and pair mode writes `.nodeterm/agent.json` (a device with a live bearer
         * token) and `.ssh/authorized_keys` under it: with HOME alone, a Windows run would write into the
         * contributor's real profile (audit A70). FIXTURE_HOME is what the fixture checks `os.homedir()`
         * against before pair mode writes anything.
         */
        fun scratchHomeEnv(home: File): Map<String, String> =
            mapOf("HOME" to home.path, "USERPROFILE" to home.path, "FIXTURE_HOME" to home.path)

        internal fun available(mode: String = "relay"): Boolean {
            val node = runCatching { ProcessBuilder("node", "--version").start().waitFor() == 0 }.getOrDefault(false)
            // The esbuild PACKAGE (its JS API), not the .bin shim the harness no longer runs.
            return node && File(repoRoot, "node_modules/esbuild/package.json").exists() &&
                (mode == "ack-sweep" || mode == "ssh-actions" || mode == "managed-session" || mode == "server-profile" || mode == "relay-advertisement" || (File(repoRoot, "node_modules/ws").exists() &&
                    File(repoRoot, "node_modules/tweetnacl").exists()))
        }

        /**
         * Starts the fixture in [mode] and waits for its ready line. When that wait fails (a timeout, or
         * a `fatal` event), the process is killed before the error propagates: the caller never gets a
         * handle, so nothing else would ever close it. [onSpawn] is a test seam for exactly that check.
         */
        fun start(
            mode: String,
            env: Map<String, String> = emptyMap(),
            readyTimeoutMs: Long = 20_000,
            onSpawn: (Process) -> Unit = {}
        ): InteropHarness {
            assumeTrue(available(mode), "node + repo node_modules (npm ci) are needed for interop tests")
            val fixture = when (mode) {
                "ack-sweep" -> ackBundle
                "project-launch" -> projectLaunchBundle
                "ssh-actions" -> sshActionsBundle
                "managed-session" -> managedSessionBundle
                "server-profile" -> serverProfileBundle
                "relay-advertisement" -> relayAdvertisementBundle
                else -> bundle
            }
            val pb = ProcessBuilder("node", fixture.path, mode).directory(repoRoot)
            pb.environment().putAll(env)
            val h = InteropHarness(pb.start())
            try {
                onSpawn(h.process)
                h.startReader()
                h.ready = h.await(readyTimeoutMs) { it["ready"] != null }
            } catch (t: Throwable) {
                h.close()
                throw t
            }
            return h
        }
    }
}
