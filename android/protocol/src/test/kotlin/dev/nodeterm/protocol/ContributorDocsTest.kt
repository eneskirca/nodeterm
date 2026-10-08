package dev.nodeterm.protocol

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Two setup lines in the contributor docs that sent a reader into a broken checkout, pinned against
 * the files they describe:
 *
 *  - Audit A71: android/README.md said "JDK 17+", but the Gradle the wrapper pins cannot run on every
 *    JDK after 17 (8.14.3 stops at 24; its embedded Kotlin compiler rejects "25" while compiling the
 *    build scripts). Every Gradle has a newest Java it runs on, so an open-ended claim is false from
 *    the next JDK release on. A stated range must end where the wrapper's Gradle does, start no lower
 *    than the bytecode the build targets, and include the JDK CI actually uses.
 *  - Audit A61: the docs told desktop contributors to run `npm ci --ignore-scripts` before the protocol
 *    tests. `npm ci` deletes `node_modules`, and the flag skips the node-pty patch and build, so a
 *    working desktop checkout came out with node-pty unpatched (and on Linux unbuilt). Their existing
 *    `npm install` was already enough. The flag is CI's, for a machine without the native toolchain;
 *    any paragraph that mentions it has to say how a desktop checkout recovers.
 *
 * The audit and the handover are logs that quote the old wording, so they are not read.
 */
class ContributorDocsTest {
    private val root = InteropHarness.repoRoot

    /**
     * Contributor-facing docs that say how to build or test the Android side. Each is named by a literal
     * path so that WorkflowPathFilterTest sees the read and fails while an edit to the doc would not run
     * the Android workflow (CONTRIBUTING.md was missing from its filter while this was a list of strings).
     */
    private val docs = listOf(
        File(root, "CONTRIBUTING.md"),
        File(root, "docs/android.md"),
        File(root, "android/README.md"),
        File(root, "android/tools/typecheck/README.md"),
    )

    /**
     * For each Java release, the first Gradle release that can RUN on it (not build for it through a
     * toolchain), from the compatibility matrix at docs.gradle.org/current/userguide/compatibility.html.
     * A doc that claims a JDK newer than the last entry fails until this table learns it.
     */
    private val firstGradleRunningOn = mapOf(
        17 to "7.3", 18 to "7.5", 19 to "7.6", 20 to "8.3", 21 to "8.5",
        22 to "8.8", 23 to "8.10", 24 to "8.14", 25 to "9.1",
    )

    @Test
    fun `every stated JDK requirement is a range the wrapper's Gradle can run on`() {
        val gradle = wrapperGradleVersion()
        val newestJdk = firstGradleRunningOn.filterValues { compareVersions(it, gradle) <= 0 }.keys.maxOrNull()
            ?: fail("the wrapper's Gradle $gradle is older than every entry of the table")
        val target = jvmTarget()
        val ci = ciJavaVersions()
        var ranges = 0
        for (doc in docs) {
            val path = doc.repoPath()
            val text = read(doc)
            openEnded.findAll(text).forEach {
                fail(
                    "$path says `${it.value}`, but the wrapper's Gradle $gradle runs on JDK $newestJdk at most. " +
                        "State a range (`JDK $target–$newestJdk`) instead (audit A71)."
                )
            }
            for (m in range.findAll(text)) {
                ranges++
                val (low, high) = m.destructured.toList().map(String::toInt)
                assertTrue(
                    high <= newestJdk,
                    "$path says `${m.value}`, but the wrapper's Gradle $gradle cannot run on JDK $high (newest: " +
                        "$newestJdk). Lower the range or move the wrapper (audit A71)."
                )
                assertTrue(low >= target, "$path says `${m.value}`, below the JVM target $target the build compiles for")
                assertTrue(
                    ci.all { it in low..high },
                    "$path says `${m.value}`, which leaves out the JDK $ci CI builds with"
                )
            }
        }
        assertTrue(range.containsMatchIn(read(File(root, "android/README.md"))), "android/README.md no longer states a JDK range")
        assertTrue(ranges >= 2, "found only $ranges JDK ranges in ${docs.map { it.repoPath() }}; has the reader stopped seeing them?")
    }

    @Test
    fun `a paragraph that mentions npm ci --ignore-scripts says how a desktop checkout recovers`() {
        var mentions = 0
        for (doc in docs) {
            val path = doc.repoPath()
            for (paragraph in read(doc).split(Regex("""\n\s*\n"""))) {
                if (!paragraph.contains("--ignore-scripts")) continue
                mentions++
                assertTrue(
                    paragraph.contains("npm run rebuild"),
                    "$path mentions `--ignore-scripts` without saying that `npm ci` deletes node_modules and leaves " +
                        "node-pty unpatched until `npm install` / `npm run rebuild` runs again (audit A61):\n$paragraph"
                )
            }
        }
        // Both docs name the flag so that a contributor who sees it in CI's workflow knows not to copy it.
        assertTrue(mentions >= 2, "found only $mentions paragraphs naming --ignore-scripts; has the wording moved?")
    }

    @Test
    fun `the version comparison orders Gradle releases numerically`() {
        assertTrue(compareVersions("8.14.3", "8.14") > 0)
        assertTrue(compareVersions("8.14", "8.8") > 0) // not a string comparison
        assertTrue(compareVersions("8.14.3", "9.1") < 0)
        assertEquals(0, compareVersions("9.1", "9.1.0"))
    }

    private fun File.repoPath() = relativeTo(root).invariantSeparatorsPath

    private fun wrapperGradleVersion(): String {
        val props = read(File(root, "android/gradle/wrapper/gradle-wrapper.properties"))
        return Regex("""distributionUrl=.*gradle-([0-9][0-9.]*)-(?:bin|all)\.zip""").find(props)?.groupValues?.get(1)
            ?: fail("no Gradle version in android/gradle/wrapper/gradle-wrapper.properties")
    }

    /** The JVM target the protocol module compiles for; the app and the type-check use the same. */
    private fun jvmTarget(): Int {
        val build = read(File(root, "android/protocol/build.gradle.kts"))
        return Regex("""JvmTarget\.JVM_(\d+)""").find(build)?.groupValues?.get(1)?.toInt()
            ?: fail("no JvmTarget in android/protocol/build.gradle.kts")
    }

    /** Every `java-version:` the Android workflow's setup-java steps pin. */
    private fun ciJavaVersions(): Set<Int> {
        val workflow = read(File(root, ".github/workflows/android.yml"))
        val versions = Regex("""java-version:\s*['"]?(\d+)""").findAll(workflow).map { it.groupValues[1].toInt() }.toSet()
        assertTrue(versions.isNotEmpty(), "no java-version in .github/workflows/android.yml")
        return versions
    }

    private companion object {
        /** `JDK 17+`, `JDK 17 or newer`, `JDK 17 or later`. */
        val openEnded = Regex("""JDK\s*\d+\s*(?:\+|or\s+(?:newer|later|above))""")

        /** `JDK 17–24` or `JDK 17-24`. */
        val range = Regex("""JDK\s*(\d+)\s*[–-]\s*(\d+)""")

        fun read(file: File) = file.readText().replace("\r\n", "\n")

        fun compareVersions(a: String, b: String): Int {
            val x = a.split('.').map(String::toInt)
            val y = b.split('.').map(String::toInt)
            for (i in 0 until maxOf(x.size, y.size)) {
                val c = (x.getOrElse(i) { 0 }).compareTo(y.getOrElse(i) { 0 })
                if (c != 0) return c
            }
            return 0
        }
    }
}
