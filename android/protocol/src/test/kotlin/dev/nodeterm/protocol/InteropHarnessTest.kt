package dev.nodeterm.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The interop harness itself (audits A60, A70). The fixture must not load the real `electron` package,
 * whose first `require` downloads the Electron binary when it is missing (after any fresh `npm ci`),
 * inside the harness's ready wait. A start whose ready wait fails must not leave the node process
 * behind: the caller never receives a handle to close. And the harness must run on Windows too: it
 * spawns only `node`, and a scratch home covers the home variable Windows reads.
 */
class InteropHarnessTest {
    private val needs = "node + repo node_modules (npm ci) are needed for interop tests"

    @Test
    fun `managed launch fixture uses real settings trust and spawn producers with scoped native boundaries`() {
        assumeTrue(InteropHarness.available(), needs)
        val source = InteropHarness.projectLaunchBundle.readText()
        val inputs = Json.parseToJsonElement(InteropHarness.projectLaunchBundleMeta.readText())
            .jsonObject["inputs"]!!.jsonObject.keys
        for (input in listOf("src/core/pty-manager.ts", "src/core/workspace-store.ts",
            "src/core/project-spawn-overrides.ts", "src/core/project-trust-store.ts",
            "src/main/remote/host-service.ts", "src/main/remote/host-new-sessions.ts",
            "android/protocol/src/test/interop/launch-os.ts", "android/protocol/src/test/interop/launch-native.ts")) {
            assertTrue(input in inputs, "managed launch fixture omits its real producer/boundary: $input")
        }
        assertFalse(Regex("""require\(\s*["'](?:node-pty|os)["']\s*\)""").containsMatchIn(source),
            "managed launch fixture escaped its native/profile isolation")
        assertTrue(source.contains("managed launch fixture refused a subprocess"),
            "managed launch fixture lacks its fail-closed manager subprocess boundary")
    }

    @Test
    fun `the bundle step runs node, never an npm shim`() {
        // A70: node_modules/.bin/esbuild is a sh script on Windows, which CreateProcess cannot run, so
        // the bundle step threw and every interop test errored there instead of skipping or running.
        val argv = InteropHarness.bundleCommand(File("out.cjs"))
        assertEquals("node", argv.first(), "the bundle step must spawn node: $argv")
        assertTrue(argv.none { it.contains("node_modules") }, "the bundle step names a node_modules file: $argv")
        assertTrue(File(InteropHarness.repoRoot, argv[1]).isFile, "no bundler script at ${argv[1]}")
    }

    @Test
    fun `a scratch home points the home variable of every OS at the dir`() {
        // A70: os.homedir() reads HOME on POSIX and USERPROFILE on Windows; pair mode writes a live
        // bearer token under it, so a run must never fall through to the contributor's real profile.
        val home = File("scratch-home")
        val env = InteropHarness.scratchHomeEnv(home)
        for (name in listOf("HOME", "USERPROFILE", "FIXTURE_HOME")) assertEquals(home.path, env[name], name)
    }

    @Test
    fun `the fixture bundle resolves electron to the stub and never requires the package`() {
        assumeTrue(InteropHarness.available(), needs)
        val source = InteropHarness.bundle.readText()
        assertFalse(
            Regex("""require\(\s*["']electron["']\s*\)""").containsMatchIn(source),
            "the bundle requires the real electron package; alias it to ${InteropHarness.ELECTRON_STUB}"
        )
        assertTrue(
            source.contains("is not available in the Android interop fixture"),
            "the bundle does not carry ${InteropHarness.ELECTRON_STUB}"
        )
    }

    @Test
    fun `a start whose ready wait fails kills the fixture process`() {
        assumeTrue(InteropHarness.available(), needs)
        var spawned: Process? = null
        try {
            val err = assertFailsWith<AssertionError> {
                InteropHarness.start("never-ready", readyTimeoutMs = 500, onSpawn = { spawned = it })
            }
            assertTrue(err.message.orEmpty().contains("not seen within 500ms"), err.message)
            val process = assertNotNull(spawned, "the fixture was never spawned")
            assertFalse(process.isAlive, "a failed start left the node process running")
        } finally {
            spawned?.destroyForcibly()
        }
    }
}
