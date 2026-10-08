package dev.nodeterm.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Audit A63: `.github/workflows/android.yml` runs only when a changed file matches the `paths` filter
 * of its `push` or `pull_request` trigger. The interop tests run the desktop's own code, bundled from
 * `host-fixture.ts`, so a change to any file in that bundle changes what they test. The first filter
 * covered `android/`, `src/main/remote/` and the `src/main/pairing-*.ts` files only: 35 of the 49 desktop
 * sources in the bundle (all of src/core and src/shared, and `src/main/windows-ssh-keys.ts`) could
 * change with no Android run at all.
 *
 * This reads the inputs of the very bundle the interop tests run (the bundler writes esbuild's
 * metafile beside it) and checks that both filters match each one, plus the files the workflow uses
 * without bundling them. It holds by induction: a change that adds a file to the bundle has to edit a
 * file already in it (an import), the bundler's aliases (under android/) or tsconfig.json, so it runs
 * the workflow, and this test then fails until the new path is listed.
 *
 * The second test does the same for the repo files the protocol tests read, found by [repoReads]; a
 * read it cannot resolve to a path has to be explained in `computedReads`.
 *
 * The filter semantics are GitHub's (`*` stays within one path segment, `**` crosses them); syntax this
 * reader does not implement is refused rather than guessed.
 */
class WorkflowPathFilterTest {
    private val root = InteropHarness.repoRoot
    private val workflowPath = ".github/workflows/android.yml"
    private val workflow by lazy { File(root, workflowPath).readText().replace("\r\n", "\n") }
    private val triggers = listOf("push", "pull_request")

    /**
     * Files the workflow depends on that are not in the bundle's metafile, with why:
     * - tsconfig.json: esbuild applies the root tsconfig's compilerOptions to every file it bundles
     *   (it does not follow the references, so tsconfig.node.json is not read);
     * - package.json, package-lock.json: `npm ci` installs esbuild, ws and tweetnacl from them, and
     *   they stand in for every node_modules input of the bundle;
     * - the workflow file itself.
     */
    private val unbundledInputs = listOf("tsconfig.json", "package.json", "package-lock.json", "src/server/index.ts", workflowPath)

    /**
     * Test files that read a repo file through a computed path, which [repoReads] cannot resolve, with
     * why the paths they read run the workflow anyway. Any other computed read fails the test: it is how
     * ContributorDocsTest came to read CONTRIBUTING.md with that file missing from the filter (review
     * of A61/A71), because it read its docs as `File(root, path)` over a list of strings.
     */
    private val computedReads = mapOf(
        "WorkflowPathFilterTest.kt" to "the bundle's metafile inputs and the paths this test requires, which it checks itself",
        "GradleCiCoverageTest.kt" to "the gradle directories .github/dependabot.yml names (in the filter); each must " +
            "hold a Gradle build, and this repo's are all under android/",
        "InteropHarnessTest.kt" to "the bundler script InteropHarness.bundleCommand names, under android/",
    )

    @Test
    fun `every file the fixture bundle is built from runs the workflow`() {
        assumeTrue(InteropHarness.available(), "node + repo node_modules (npm ci) are needed for interop tests")
        // Reading it builds the bundle first; the bundler writes the metafile beside it.
        val meta = Json.parseToJsonElement(InteropHarness.bundleMeta.readText()).jsonObject
        val inputs = meta.getValue("inputs").jsonObject.keys
        assertTrue(inputs.any { it.startsWith("src/main/remote/") }, "the metafile names no desktop source: $inputs")
        val required = inputs.map { input ->
            if (input.startsWith("node_modules/")) {
                "package-lock.json"
            } else {
                assertTrue(File(root, input).isFile, "metafile input $input is not a repo file")
                input
            }
        }.toSortedSet()
        assertCovered(required, "bundled into host-fixture.ts")
    }

    @Test
    fun `every file the ack consumer fixture is built from runs the workflow`() {
        assumeTrue(InteropHarness.available("ack-sweep"), "node + esbuild are needed for ack interop tests")
        val meta = Json.parseToJsonElement(InteropHarness.ackBundleMeta.readText()).jsonObject
        val inputs = meta.getValue("inputs").jsonObject.keys
        assertTrue("src/core/ack-sweep.ts" in inputs, "the fixture does not run the actual ack consumer")
        val required = inputs.map { if (it.startsWith("node_modules/")) "package-lock.json" else it }.toSortedSet()
        assertCovered(required, "bundled into ack-fixture-runner.ts")
    }

    @Test
    fun `every actual SSH actions producer file runs the workflow`() {
        assumeTrue(InteropHarness.available("ssh-actions"), "node + esbuild are needed for SSH actions interop")
        val meta = Json.parseToJsonElement(InteropHarness.sshActionsBundleMeta.readText()).jsonObject
        val inputs = meta.getValue("inputs").jsonObject.keys
        assertTrue("src/core/ssh-actions.ts" in inputs, "fixture must run the actual selected-profile service")
        assertTrue("src/core/workspace-store.ts" in inputs, "fixture must run the actual save queue")
        val required = inputs.map { if (it.startsWith("node_modules/")) "package-lock.json" else it }.toSortedSet()
        assertCovered(required, "bundled into ssh-actions-fixture.ts")
    }

    @Test
    fun `the actual relay advertisement writer and remover run the workflow`() {
        assumeTrue(InteropHarness.available("relay-advertisement"), "node + esbuild are needed for advertisement interop")
        val inputs = Json.parseToJsonElement(InteropHarness.relayAdvertisementBundleMeta.readText()).jsonObject
            .getValue("inputs").jsonObject.keys
        for (required in listOf("src/main/remote/relay-advertise.ts", "src/core/fs-atomic.ts")) {
            assertTrue(required in inputs, "fixture must execute actual producer $required")
        }
        assertCovered(inputs.map { if (it.startsWith("node_modules/")) "package-lock.json" else it }.toSortedSet(),
            "bundled into relay-advertisement-fixture.ts")
    }

    @Test
    fun `every actual managed creation producer file runs the workflow`() {
        assumeTrue(InteropHarness.available("managed-session"), "node + esbuild are needed for managed creation interop")
        val inputs = Json.parseToJsonElement(InteropHarness.managedSessionBundleMeta.readText()).jsonObject
            .getValue("inputs").jsonObject.keys
        for (required in listOf("src/core/managed-terminal-plan.ts", "src/core/managed-terminals.ts",
            "src/core/pty-manager.ts", "src/core/workspace-store.ts", "src/core/ssh-actions.ts")) {
            assertTrue(required in inputs, "fixture must execute actual producer $required")
        }
        assertTrue("android/protocol/src/test/interop/managed-native.ts" in inputs,
            "native recorder boundary must be explicit, rather than a saved receipt fixture")
        assertCovered(inputs.map { if (it.startsWith("node_modules/")) "package-lock.json" else it }.toSortedSet(),
            "bundled into managed-session-fixture.ts")
    }

    @Test
    fun `every actual custom Server profile producer file runs the workflow and invalidates Gradle tests`() {
        assumeTrue(InteropHarness.available("server-profile"), "node + esbuild are needed for Server profile interop")
        val inputs = Json.parseToJsonElement(InteropHarness.serverProfileBundleMeta.readText()).jsonObject
            .getValue("inputs").jsonObject.keys
        for (required in listOf("src/server/config.ts", "src/server/platform-server.ts",
            "src/core/workspace-store.ts", "src/core/agent-status-mirror.ts", "src/core/ssh-actions.ts",
            "src/core/managed-terminals.ts", "android/protocol/src/test/interop/server-profile-os.ts")) {
            assertTrue(required in inputs, "fixture must execute actual producer $required")
        }
        assertFalse("src/server/index.ts" in inputs,
            "this component fixture must not start the full Server boot/hook lifecycle")
        assertCovered(inputs.map { if (it.startsWith("node_modules/")) "package-lock.json" else it }.toSortedSet(),
            "bundled into server-profile-fixture.ts")

        val build = File(root, "android/protocol/build.gradle.kts").readText()
            .replace(Regex("//[^\n]*"), "")
        val directoryLoop = Regex("""for\s*\(dir\s+in\s+listOf\(([^)]*)\)\)\s*\{\s*inputs\.dir\(rootDir\.resolve\("\.\./\.\./\${'$'}dir"\)\)\.withPathSensitivity\(PathSensitivity\.RELATIVE\)\s*}""")
            .find(build) ?: fail("the protocol test task must declare its actual desktop source directories as Gradle inputs")
        val directories = Regex("\"([^\"]+)\"").findAll(directoryLoop.groupValues[1]).map { it.groupValues[1] }.toSet()
        val files = Regex("""inputs\.file\(rootDir\.resolve\("\.\./\.\./([^"${'$'}]+)"\)\)\.withPathSensitivity\(PathSensitivity\.RELATIVE\)""")
            .findAll(build).map { it.groupValues[1] }.toSet()
        val missed = inputs.filter { it.startsWith("src/") && it !in files && directories.none { dir -> it.startsWith("$dir/") } }
        assertTrue(missed.isEmpty(), "these actual Server producer inputs leave local Gradle tests up to date: $missed")
    }

    @Test
    fun `managed creation producer inputs also invalidate Gradle protocol tests`() {
        assumeTrue(InteropHarness.available("managed-session"), "node + esbuild are needed for managed creation interop")
        val inputs = Json.parseToJsonElement(InteropHarness.managedSessionBundleMeta.readText()).jsonObject
            .getValue("inputs").jsonObject.keys.filter { it.startsWith("src/") }
        val build = File(root, "android/protocol/build.gradle.kts").readText()
            .replace(Regex("//[^\n]*"), "")
        val directoryLoop = Regex("""for\s*\(dir\s+in\s+listOf\(([^)]*)\)\)\s*\{\s*inputs\.dir\(rootDir\.resolve\("\.\./\.\./\${'$'}dir"\)\)\.withPathSensitivity\(PathSensitivity\.RELATIVE\)\s*}""")
            .find(build) ?: fail("the protocol test task must declare its actual desktop source directories as Gradle inputs")
        val directories = Regex("\"([^\"]+)\"").findAll(directoryLoop.groupValues[1]).map { it.groupValues[1] }.toSet()
        val missed = inputs.filter { input -> directories.none { input.startsWith(it + "/") } }
        assertTrue(missed.isEmpty(), "these actual managed producer inputs leave local Gradle tests up to date: $missed")
    }

    @Test
    fun `the files the workflow uses without bundling them run it`() {
        // Repo files the protocol tests read (ResumeOfferTest reads a src/shared file, ContributorDocsTest
        // reads CONTRIBUTING.md): each read by a literal path must run the workflow, and a read by a
        // computed path must be explained in computedReads.
        val testSources = File(root, "android/protocol/src/test/kotlin")
        val reads = testSources.walkTopDown().filter { it.extension == "kt" }.flatMap { file ->
            repoReads(file.readText()).map { file.name to it }
        }.toList()
        val literalReads = reads.mapNotNull { it.second }.toSortedSet()
        assertTrue(literalReads.isNotEmpty(), "found no repo file read by a literal path in $testSources")
        val computed = reads.filter { it.second == null }.map { it.first }.toSortedSet()
        val unexplained = computed - computedReads.keys
        assertTrue(
            unexplained.isEmpty(),
            "these test files read a repo file through a computed path, so this test cannot check that editing " +
                "the file runs the workflow: $unexplained. Name each file by a literal path from " +
                "InteropHarness.repoRoot (or from a val bound to it), or list the test file in computedReads " +
                "with why its paths are in the filter anyway."
        )
        val stale = computedReads.keys - computed
        assertTrue(stale.isEmpty(), "computedReads lists $stale, which read no repo file through a computed path now; remove it")
        val required = (unbundledInputs + literalReads).toSortedSet()
        for (path in required) assertTrue(File(root, path).exists(), "$path does not exist; update this test")
        assertCovered(required, "read by the workflow or its tests")
    }

    @Test
    fun `the read scanner sees literal, aliased and computed reads`() {
        // Built from a template so that this file's own source names no repo file by a literal path.
        val h = "InteropHarness" + ".repoRoot"
        val source = """
            /** File($h, "in/a/kdoc.md") is not a read. */
            class X {
                // File($h, "in/a/comment.md") is not either
                private val base = $h
                var dir: File = $h
                private val other = File("/tmp")
                val a = File($h, "CONTRIBUTING.md")
                val b = File( base , "docs/android.md" )
                val c = base.resolve("android/README.md")
                val d = File(dir, "src/shared/types.ts")
                val e = $h.resolve("docs/SERVER.md")
                val f = File(base, path)
                val g = File(base, "docs/" + name)
                val i = File($h, "x/${'$'}name.md")
                val j = File(other, "not/the/repo.md")
                val k = other.base.resolve("not/an/alias.md")
            }
        """.trimIndent()
        assertEquals(
            listOf("CONTRIBUTING.md", "docs/android.md", "android/README.md", "src/shared/types.ts", "docs/SERVER.md", null, null, null),
            repoReads(source)
        )
    }

    @Test
    fun `the glob matcher follows GitHub's path filter syntax`() {
        assertTrue(globRegex("android/**").matches("android/protocol/src/test/interop/host-fixture.ts"))
        assertTrue(globRegex("src/main/*.ts").matches("src/main/windows-ssh-keys.ts"))
        assertFalse(globRegex("src/main/*.ts").matches("src/main/remote/host-service.ts"), "* must not cross /")
        assertFalse(globRegex("src/main/pairing-*.ts").matches("src/main/windows-ssh-keys.ts"))
        assertFalse(globRegex("tsconfig.json").matches("tsconfigXjson"), ". is literal")
        assertFalse(globRegex("tsconfig.json").matches("sub/tsconfig.json"), "a pattern is anchored")
        for (bad in listOf("src/**/*.ts?", "src/[ab].ts", "!src/**", "src/+.ts", "src/{a,b}.ts")) {
            assertFailsWith<IllegalArgumentException>(bad) { globRegex(bad) }
        }
    }

    @Test
    fun `the filter reader finds each trigger's paths and nothing else`() {
        val yaml = """
            name: x
            # a comment
            on:
              push:
                branches: [main]
                paths:
                  # a comment inside the list
                  - 'a/**'

                  - "b/*.ts"
                  - c.json
              pull_request:
              workflow_dispatch:
            jobs:
              paths:
                - 'not/a/trigger'
        """.trimIndent()
        assertEquals(listOf("a/**", "b/*.ts", "c.json"), pathFilter(yaml, "push"))
        assertNull(pathFilter(yaml, "pull_request"), "a trigger without paths runs on every change")
        assertFailsWith<AssertionError> { pathFilter(yaml, "merge_group") }
        val ignoring = "on:\n  push:\n    paths-ignore:\n      - 'docs/**'\n"
        assertFailsWith<AssertionError> { pathFilter(ignoring, "push") }
    }

    @Test
    fun `Android workflow pushes only main and retains PR and manual entry points`() {
        androidTriggerPolicy(workflow)
    }

    @Test
    fun `the trigger policy reads ref filters as data and rejects widened entry points`() {
        val yaml = """
            name: x
            on:
              # merge_group and branches: [feature] in comments are not triggers or filters.
              push:
                branches: ["main"]
                paths:
                  - 'android/**'
              pull_request:
                paths:
                  - 'android/**'
              workflow_dispatch:
                inputs:
                  merge_group:
                    description: A nested input name is not a workflow trigger.
            jobs:
              nested:
                on:
                  push:
                    branches: [feature]
        """.trimIndent()
        androidTriggerPolicy(yaml)
        androidTriggerPolicy(yaml.replace("branches: [\"main\"]", "branches:\n      - 'main'"))
        val mutations = mapOf(
            "unrestricted pushes" to yaml.replace("    branches: [\"main\"]\n", ""),
            "additional branch" to yaml.replace("[\"main\"]", "[main, feature]"),
            "branch wildcard" to yaml.replace("[\"main\"]", "['main*']"),
            "other branch" to yaml.replace("[\"main\"]", "[feature]"),
            "tag pushes" to yaml.replace("    branches: [\"main\"]", "    branches: [main]\n    tags: ['v*']"),
            "missing PR" to yaml.replace("  pull_request:", "  pull_request_target:"),
            "merge queue" to yaml.replace("  workflow_dispatch:", "  merge_group:\n  workflow_dispatch:"),
            "missing manual entry" to yaml.replace("  workflow_dispatch:", "  schedule:"),
        )
        for ((name, changed) in mutations) {
            assertFalse(changed == yaml, "$name must change the actual configuration data")
            assertFailsWith<AssertionError>(name) { androidTriggerPolicy(changed) }
        }
    }

    private fun assertCovered(required: Set<String>, what: String) {
        for (trigger in triggers) {
            val patterns = pathFilter(workflow, trigger) ?: continue // no filter: every change runs it
            val regexes = patterns.map { globRegex(it) }
            val missed = required.filter { path -> regexes.none { it.matches(path) } }
            assertTrue(
                missed.isEmpty(),
                "$workflowPath: the $trigger paths filter does not match these files $what, so a change to " +
                    "one runs no Android test (audit A63). Add them (or a glob) to the push and pull_request " +
                    "paths and to the comment above them:\n  ${missed.joinToString("\n  ")}"
            )
        }
    }

    companion object {
        /**
         * The repo files [source] (a Kotlin test file) reads, one entry per read in source order: the path
         * when it is a string literal, null when it is computed. A read is `File(<root>, …)` or
         * `<root>.resolve(…)`, where <root> is `InteropHarness.repoRoot` or a `val`/`var` the same file binds
         * to it. Whole-line and block comments are skipped. The scan is textual: a root handed in through a
         * parameter is not seen, and a string that quotes a read counts as a computed one (the safe side).
         */
        internal fun repoReads(source: String): List<String?> {
            val code = source.replace(Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL), " ")
                .lines().filterNot { it.trimStart().startsWith("//") }.joinToString("\n")
            val aliases = Regex("""\b(?:val|var)\s+(\w+)\s*(?::\s*File\s*)?=\s*InteropHarness\.repoRoot(?![\w.])""")
                .findAll(code).map { Regex.escape(it.groupValues[1]) }
            val root = (sequenceOf("""InteropHarness\.repoRoot""") + aliases).joinToString("|")
            val read = Regex("""(?:\bFile\(\s*(?:$root)\s*,|(?<![\w.])(?:$root)\.resolve\()\s*(?:"([^"\\$]*)"\s*\))?""")
            return read.findAll(code).map { it.groups[1]?.value }.toList()
        }

        /**
         * The `paths:` list of [trigger] under the workflow's top-level `on:`, or null when the trigger
         * has none (it then runs on every change). Only the block style this repo's workflows use is
         * understood; `paths-ignore` is refused.
         */
        internal fun pathFilter(yaml: String, trigger: String): List<String>? {
            fun indent(line: String) = line.length - line.trimStart().length
            fun skip(line: String) = line.isBlank() || line.trimStart().startsWith("#")
            val lines = yaml.lines()
            val on = lines.indexOfFirst { it.trimEnd() == "on:" }
            if (on < 0) throw AssertionError("no top-level `on:` block")
            var i = on + 1
            var triggerIndent = -1
            while (i < lines.size) {
                val line = lines[i]
                if (!skip(line)) {
                    if (indent(line) == 0) break
                    if (line.trim() == "$trigger:") {
                        triggerIndent = indent(line)
                        break
                    }
                }
                i++
            }
            if (triggerIndent < 0) throw AssertionError("no `$trigger:` trigger under `on:`")
            var paths: MutableList<String>? = null
            var pathsIndent = -1
            i++
            while (i < lines.size) {
                val line = lines[i]
                i++
                if (skip(line)) continue
                val ind = indent(line)
                if (ind <= triggerIndent) break
                val text = line.trim()
                if (paths != null && ind > pathsIndent) {
                    if (!text.startsWith("- ")) throw AssertionError("unexpected line in the $trigger paths list: $line")
                    paths.add(text.removePrefix("- ").trim().removeSurrounding("'").removeSurrounding("\""))
                    continue
                }
                if (text.startsWith("paths-ignore:")) throw AssertionError("paths-ignore is not understood by this reader")
                if (text == "paths:") {
                    paths = ArrayList()
                    pathsIndent = ind
                } else if (text.startsWith("paths:")) {
                    throw AssertionError("only a block `paths:` list is understood: $line")
                }
            }
            return paths
        }

        /** A68: inspect trigger data, separately from A63's path coverage. */
        internal fun androidTriggerPolicy(yaml: String) {
            fun indent(line: String) = line.length - line.trimStart().length
            fun skip(line: String) = line.isBlank() || line.trimStart().startsWith("#")
            val lines = yaml.lines()
            val on = lines.indices.filter { lines[it].trimEnd() == "on:" }
            assertEquals(1, on.size, "expected one top-level block-style on declaration")
            val events = linkedMapOf<String, MutableList<String>>()
            var current: MutableList<String>? = null
            for (line in lines.drop(on.single() + 1)) {
                if (skip(line)) continue
                val depth = indent(line)
                if (depth == 0) break
                if (depth == 2) {
                    val event = Regex("([a-z_]+):").matchEntire(line.trim())?.groupValues?.get(1)
                        ?: fail("unsupported workflow trigger declaration: $line")
                    assertFalse(event in events, "duplicate trigger $event")
                    current = mutableListOf<String>().also { events[event] = it }
                } else {
                    assertTrue(depth > 2 && current != null, "invalid trigger indentation: $line")
                    current!!.add(line)
                }
            }
            assertEquals(setOf("push", "pull_request", "workflow_dispatch"), events.keys,
                "retain PR and manual dispatch, and do not add merge_group or another event")

            fun fields(event: String): Map<String, String> {
                val result = linkedMapOf<String, String>()
                for (line in events.getValue(event).filter { indent(it) == 4 }) {
                    val field = Regex("([a-z_][a-z_-]*):\\s*(.*)").matchEntire(line.trim())
                        ?: fail("unsupported $event field: $line")
                    val key = field.groupValues[1]
                    assertFalse(key in result, "duplicate $event field $key")
                    result[key] = field.groupValues[2]
                }
                return result
            }
            val push = fields("push")
            assertEquals(setOf("branches", "paths"), push.keys,
                "push must select branches and paths, with no tag or ignore filters")
            assertEquals(setOf("paths"), fields("pull_request").keys,
                "retain the PR path filter without introducing a target-branch restriction")

            fun literal(raw: String): String {
                val trimmed = raw.trim()
                val value = if (trimmed.length >= 2 && trimmed.first() in listOf('\'', '"') &&
                    trimmed.last() == trimmed.first()) trimmed.substring(1, trimmed.length - 1) else trimmed
                assertTrue(Regex("[A-Za-z0-9_./*?!+-]+").matches(value), "unsupported branch pattern $raw")
                return value
            }
            val rawBranches = push.getValue("branches")
            val branches = if (rawBranches.startsWith("[") && rawBranches.endsWith("]")) {
                val contents = rawBranches.substring(1, rawBranches.length - 1)
                if (contents.isBlank()) emptyList() else contents.split(',').map(::literal)
            } else {
                assertTrue(rawBranches.isEmpty(), "branches must be a literal inline or block list")
                val block = events.getValue("push")
                val at = block.indexOfFirst { indent(it) == 4 && it.trim() == "branches:" }
                assertTrue(at >= 0, "no branches list")
                block.drop(at + 1).takeWhile { indent(it) > 4 }.map { line ->
                    assertTrue(indent(line) == 6 && line.trimStart().startsWith("- "),
                        "unsupported branch list entry: $line")
                    literal(line.trim().removePrefix("- "))
                }
            }
            assertEquals(listOf("main"), branches, "push must admit only main, not feature branches or tags")
            val paths = pathFilter(yaml, "push") ?: fail("push must retain its path filter")
            assertTrue(paths.isNotEmpty(), "push path filter must not disable all changed-file runs")
            assertEquals(paths, pathFilter(yaml, "pull_request"), "push and PR must retain the same input coverage")
        }

        /** A GitHub Actions path pattern as a regex over a repo-relative, `/`-separated path. */
        internal fun globRegex(pattern: String): Regex {
            val unsupported = pattern.firstOrNull { it in "?+[]!{}" }
            require(unsupported == null) { "path filter syntax '$unsupported' in $pattern is not implemented here" }
            val out = StringBuilder()
            var i = 0
            while (i < pattern.length) {
                if (pattern.startsWith("**", i)) {
                    out.append(".*")
                    i += 2
                } else if (pattern[i] == '*') {
                    out.append("[^/]*")
                    i++
                } else {
                    out.append(Regex.escape(pattern[i].toString()))
                    i++
                }
            }
            return Regex(out.toString())
        }
    }
}
