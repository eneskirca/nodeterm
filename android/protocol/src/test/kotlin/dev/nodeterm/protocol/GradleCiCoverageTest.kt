package dev.nodeterm.protocol

import java.io.File
import java.util.Properties
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Audit A69: the Gradle/Kotlin build had none of the supply-chain coverage the npm side has. This pins
 * the three pieces that closed it, all in CI config nothing else checks:
 *
 *  1. Every CI job that runs `./gradlew` runs `gradle/actions/setup-gradle` first, with wrapper
 *     validation on: it checks the committed `android/gradle/wrapper/gradle-wrapper.jar` against
 *     Gradle's published checksums before CI executes it. And exactly one job writes the Gradle cache
 *     the jobs share (android.yml says why).
 *  2. CodeQL analyses the Kotlin. A `java-kotlin` analysis with build mode `none` reads Java sources
 *     only, and everything under android/ is Kotlin, so it would scan nothing while looking like
 *     coverage; the Kotlin has to be compiled between CodeQL's `init` and `analyze`. The job is in
 *     android.yml, not security.yml: security.yml has no workflow_dispatch and runs on no feature
 *     branch, so a job there could first run on somebody's pull request into main (android.yml says why
 *     and what its path filter costs).
 *  3. Dependabot watches every Gradle build under android/ exactly once: a build another build
 *     includes is covered by that build's entry (Dependabot follows `includeBuild`), and a second
 *     entry would open each of its bumps twice. Except the builds in [notWatched].
 *  4. The protocol's network and crypto stack ([networkAndCrypto]) comes in a Dependabot PR that
 *     carries nothing else. In one group with every androidx/Compose/AGP/Kotlin bump it could only land
 *     when all of them build, and an androidx release that demands a higher compileSdk than the app's
 *     keeps that PR red until someone fixes it by hand (review of A69).
 *
 * The YAML is read as text, in the block style this repo's workflows use, as [WorkflowPathFilterTest]
 * does; what these readers do not understand fails rather than being guessed.
 */
class GradleCiCoverageTest {
    private val androidWorkflow = File(InteropHarness.repoRoot, ".github/workflows/android.yml")

    /** The workflows whose jobs run `./gradlew`: android.yml alone, the Kotlin CodeQL job included. */
    private val workflows = listOf(androidWorkflow)
    private val dependabot = File(InteropHarness.repoRoot, ".github/dependabot.yml")
    private val androidSettings = File(InteropHarness.repoRoot, "android/settings.gradle.kts")

    /** Gradle builds under android/ that Dependabot deliberately does not watch, with why. */
    private val notWatched = mapOf(
        "android/tools/typecheck" to "the offline type-check is not run by CI, and its pins mirror or stand in " +
            "for the app's, so they move by hand with the app's (see .github/dependabot.yml)",
    )

    /**
     * The libraries the phone's connections and keys rest on, as Dependabot names them, with what each
     * is for. Their bumps must not wait on an unrelated one (item 4 above).
     */
    private val networkAndCrypto = mapOf(
        "com.squareup.okhttp3:okhttp" to "the relay socket",
        "com.hierynomus:sshj" to "the direct-SSH transport",
        "net.i2p.crypto:eddsa" to "the phone's Ed25519 identity",
        "org.bouncycastle:bcprov-jdk18on" to "the full BouncyCastle provider sshj needs on Android",
    )

    @Test
    fun `every job that runs gradlew validates the wrapper first`() {
        var gradleJobs = 0
        for (file in workflows) {
            for ((id, job) in jobs(read(file))) {
                val steps = steps(job)
                val firstGradlew = steps.indexOfFirst(::runsGradlew)
                if (firstGradlew < 0) continue
                gradleJobs++
                val setup = steps.indexOfFirst(::isSetupGradle)
                assertTrue(
                    setup in 0 until firstGradlew,
                    "${file.name} job `$id` runs ./gradlew without a gradle/actions/setup-gradle step before it. That " +
                        "step validates android/gradle/wrapper/gradle-wrapper.jar, a committed binary CI is about " +
                        "to execute (audit A69)."
                )
                assertTrue(
                    steps[setup].none { Regex("""^validate-wrappers:\s*['"]?false""").containsMatchIn(it) },
                    "${file.name} job `$id` turns setup-gradle's wrapper validation off"
                )
            }
        }
        // android.yml's protocol, app, app-release and CodeQL (Kotlin) jobs.
        assertTrue(gradleJobs >= 4, "found only $gradleJobs jobs running ./gradlew; has the reader stopped seeing them?")
    }

    @Test
    fun `exactly one job writes the Gradle cache the jobs share`() {
        // The basic provider's key is the same for every job (a hash of the build files), and the first
        // job to save a key keeps it: with several writers, whichever finished first decided what was
        // cached. The enhanced provider keys per job, so the rule applies to basic steps only.
        val basic = workflows.flatMap { file ->
            jobs(read(file)).flatMap { (id, job) ->
                steps(job).filter { isSetupGradle(it) && value(it, "cache-provider") == "basic" }.map { "${file.name}:$id" to it }
            }
        }
        if (basic.isEmpty()) return
        val writers = basic.filter { (_, step) -> value(step, "cache-read-only") != "true" && value(step, "cache-disabled") != "true" }
        assertEquals(
            1, writers.size,
            "setup-gradle steps with cache-provider: basic that write the shared cache: ${writers.map { it.first }}; " +
                "exactly one may (the others set cache-read-only: true; android.yml says why)"
        )
    }

    @Test
    fun `private beta checks require the beta branch or opt in and tested unsigned release inputs`() {
        betaPolicy(read(androidWorkflow))
    }

    @Test
    fun `private beta checks execute the composed input host regressions`() {
        composedInputCoverage(read(androidWorkflow))
    }

    @Test
    fun `private beta checks execute every native history regression`() {
        historyScrollCoverage(read(androidWorkflow))
    }

    @Test
    fun `the history coverage reader rejects removal of each distinct regression`() {
        val yaml = read(androidWorkflow)
        assertEquals(8, historyScrollPaths.size, "Every distinct history layer has a mandatory regression")
        assertEquals(8, historyScrollPaths.toSet().size)
        historyScrollCoverage(yaml)
        for (path in historyScrollPaths) {
            val changed = yaml.lines().filterNot { it.trim() == path }.joinToString("\n")
            assertTrue(changed != yaml, "the control must actually contain $path")
            assertFailsWith<AssertionError>(path) { historyScrollCoverage(changed) }
        }
        historyScrollCoverage(yaml)
    }

    @Test
    fun `the release shrinker supports the declared Kotlin compiler and Gradle wrapper`() {
        androidToolchain(
            read(File(InteropHarness.repoRoot, "android/build.gradle.kts")),
            read(File(InteropHarness.repoRoot, "android/gradle/wrapper/gradle-wrapper.properties")),
        )
    }

    @Test
    fun `CodeQL compiles and analyses the app's and the protocol module's Kotlin`() {
        val kotlinJobs = jobs(read(androidWorkflow)).filter { (_, job) ->
            steps(job).any { isCodeqlInit(it) && "java-kotlin" in value(it, "languages").orEmpty() }
        }
        assertEquals(
            1, kotlinJobs.size,
            "android.yml must have one CodeQL job for java-kotlin (audit A69); it lives there, where a feature " +
                "branch can run it, not in security.yml"
        )
        val (id, job) = kotlinJobs.entries.single()
        val steps = steps(job)
        val init = steps.indexOfFirst(::isCodeqlInit)
        val analyze = steps.indexOfFirst { uses(it)?.startsWith("github/codeql-action/analyze@") == true }
        assertTrue(analyze > init, "job `$id`: no github/codeql-action/analyze after init")
        val mode = value(steps[init], "build-mode")
        assertTrue(
            mode == "manual" || mode == "autobuild",
            "job `$id`: build-mode is ${mode ?: "not set"}; for java-kotlin only a build (manual or autobuild) " +
                "extracts Kotlin, and android/ holds no Java to read without one"
        )
        assertTrue(
            job.any { it.trim().replace(" ", "") == "security-events:write" },
            "job `$id` needs security-events: write to upload its results"
        )
        if (mode == "manual") {
            val build = steps.subList(init + 1, analyze).filter(::runsGradlew)
            assertTrue(build.isNotEmpty(), "job `$id`: build-mode manual, but no ./gradlew step between init and analyze")
            val command = build.joinToString(" ") { it.joinToString(" ") }
            assertTrue(Regex("""compile\w*Kotlin""").containsMatchIn(command), "job `$id` does not compile Kotlin: $command")
            // The app is compiled from android/ (the root build); the protocol module comes with it as an
            // included build, or has to be named on its own.
            val app = Regex(""":app:compile\w*Kotlin""").containsMatchIn(command)
            val protocolIncluded = "includeBuild(\"protocol\")" in stripComments(read(androidSettings))
            assertTrue(app, "job `$id` does not compile the app (its Keystore and WebView code): $command")
            assertTrue(
                protocolIncluded || "-p protocol" in command,
                "job `$id` compiles the app, but android/settings.gradle.kts no longer includes the protocol " +
                    "build, so the protocol module's Kotlin is not analysed: $command"
            )
        }
    }

    @Test
    fun `Dependabot watches each Gradle build under android once`() {
        val root = InteropHarness.repoRoot
        val androidDir = androidSettings.parentFile
        val builds = androidDir.walkTopDown()
            .onEnter { it.name != "build" && it.name != ".gradle" && it.name != "node_modules" }
            .filter { it.isFile && it.name.startsWith("settings.gradle") }
            .map { it.parentFile.relativeTo(root).invariantSeparatorsPath }
            .toSortedSet()
        assertTrue("android" in builds && "android/protocol" in builds, "found only these Gradle builds: $builds")

        val directories = gradleDirectories(read(dependabot))
        val covered = directories.flatMap { dir ->
            val build = File(root, dir.removePrefix("/"))
            assertTrue(
                File(build, "settings.gradle.kts").isFile || File(build, "build.gradle.kts").isFile,
                "Dependabot's gradle directory $dir holds no Gradle build"
            )
            coveredBuilds(build).map { it.relativeTo(root).invariantSeparatorsPath }
        }
        for (build in builds) {
            val times = covered.count { it == build }
            val reason = notWatched[build]
            if (reason != null) {
                assertEquals(0, times, "Dependabot watches $build, which is deliberately not watched: $reason")
            } else {
                assertEquals(
                    1, times,
                    "Dependabot's gradle entries (directories $directories) cover the Gradle build $build $times " +
                        "times; it must be exactly once (audit A69: none leaves it without update PRs, two open " +
                        "each of its bumps twice)"
                )
            }
        }
    }

    @Test
    fun `the protocol's network and crypto stack comes in a Dependabot PR of its own`() {
        val root = InteropHarness.repoRoot
        val entries = gradleEntries(read(dependabot))
        val scripts = gradleDirectories(read(dependabot)).flatMap { dir ->
            coveredBuilds(File(root, dir.removePrefix("/"))).flatMap(::buildScripts)
        }
        assertTrue(scripts.size >= 3, "found only these build scripts in the watched builds: $scripts")
        val declared = scripts.flatMap { declaredDependencies(read(it)) }.toSet()
        for ((dependency, why) in networkAndCrypto) {
            assertTrue(
                dependency in declared,
                "$dependency ($why) is no longer declared in a Gradle build Dependabot watches; update networkAndCrypto"
            )
        }
        val others = declared - networkAndCrypto.keys
        assertTrue(
            others.any { it.startsWith("androidx.") } && others.any { it.startsWith("com.android.") },
            "found no androidx library or Android Gradle plugin among $declared; has the reader stopped seeing them?"
        )

        for (entry in entries) {
            val groups = dependabotGroups(entry)
            for ((dependency, why) in networkAndCrypto) {
                for (type in listOf("major", "minor", "patch")) {
                    val taking = groups.filter { takes(it, dependency, type) }
                    // No group takes it: it gets PRs of its own, which nothing else can hold back.
                    val group = taking.firstOrNull() ?: continue
                    // dependabot-core (DependencyGroupEngine, read from its source) gives a dependency several
                    // groups take only to the strictly most specific one, and on a tie to all of them; a run
                    // then skips what an earlier group, or a group whose PR is still open, already handled.
                    // A first group that is also strictly the most specific gets it under both rules.
                    val rivals = taking.drop(1).filter { specificity(it, dependency) >= specificity(group, dependency) }
                    assertTrue(
                        rivals.isEmpty(),
                        "a $type bump of $dependency ($why) is taken first by Dependabot group `${group.name}`, but " +
                            "${rivals.map { it.name }} name it at least as specifically, so which PR carries it depends " +
                            "on the rule Dependabot applies; keep the stack's own group first and more specific than " +
                            "any catch-all"
                    )
                    val shared = others.filter { takes(group, it, type) }
                    assertTrue(
                        shared.isEmpty(),
                        "a $type bump of $dependency ($why) lands in Dependabot group `${group.name}` together with " +
                            "$shared, so it only lands when every one of those builds (an androidx release that " +
                            "demands a higher compileSdk than the app's keeps such a PR red); give the network and " +
                            "crypto stack a group of its own, listed before the catch-all"
                    )
                }
            }
        }
    }

    @Test
    fun `the readers find what they are asked for and refuse what they do not understand`() {
        val workflow = """
            name: x
            on:
              push:
            jobs:
              # a comment
              one:
                runs-on: ubuntu-latest
                permissions:
                  security-events: write
                steps:
                  - uses: actions/checkout@v7
                  # a comment naming ./gradlew
                  - uses: gradle/actions/setup-gradle@v6
                    with:
                      cache-read-only: true
                  - name: Build
                    run: |
                      # a shell comment naming ./gradlew
                      ./gradlew build
              two:
                steps:
                  - name: Build ./gradlew in the name only
                    run: echo nothing
        """.trimIndent()
        val jobs = jobs(workflow)
        assertEquals(listOf("one", "two"), jobs.keys.toList())
        val steps = steps(jobs.getValue("one"))
        assertEquals(3, steps.size)
        assertEquals(listOf(false, false, true), steps.map(::runsGradlew))
        assertEquals("true", value(steps[1], "cache-read-only"))
        assertEquals(listOf(false), steps(jobs.getValue("two")).map(::runsGradlew))

        val config = """
            version: 2
            updates:
              - package-ecosystem: npm
                directory: /
                ignore:
                  - dependency-name: electron
              - package-ecosystem: "gradle"
                directory: '/android'
        """.trimIndent()
        assertEquals(listOf("/android"), gradleDirectories(config))
        assertFailsWith<AssertionError> {
            gradleDirectories("updates:\n  - package-ecosystem: gradle\n    directories:\n      - /android\n")
        }
        assertEquals(
            listOf("protocol", "../x"),
            includedBuilds("// includeBuild(\"commented\")\nincludeBuild(\"protocol\")\n  includeBuild('../x')\ninclude(\":app\")\n")
        )

        val grouped = """
            updates:
              - package-ecosystem: gradle
                directory: /android
                schedule:
                  interval: weekly
                groups:
                  # a comment
                  net:
                    patterns:
                      - "com.squareup.okhttp3:*"
                      - 'org.bouncycastle:*'
                    update-types: [minor, patch]
                  rest:
                    patterns: ["*"]
                    exclude-patterns: [androidx.*]
                  majors:
                    update-types: [major]
              - package-ecosystem: npm
                directory: /
        """.trimIndent()
        val entries = gradleEntries(grouped)
        assertEquals(listOf("/android"), gradleDirectories(grouped))
        val (net, rest, majors) = dependabotGroups(entries.single())
        assertEquals(DependabotGroup("net", listOf("com.squareup.okhttp3:*", "org.bouncycastle:*"), emptyList(), listOf("minor", "patch")), net)
        assertEquals(DependabotGroup("rest", listOf("*"), listOf("androidx.*"), null), rest)
        assertEquals(DependabotGroup("majors", null, emptyList(), listOf("major")), majors)
        assertTrue(takes(net, "com.squareup.okhttp3:okhttp", "minor"))
        assertTrue(!takes(net, "com.squareup.okhttp3:okhttp", "major"))
        assertTrue(!takes(rest, "androidx.core:core-ktx", "minor"), "an exclude pattern wins")
        assertTrue(takes(majors, "androidx.core:core-ktx", "major"), "a group without patterns takes every dependency")
        assertTrue(wildcardMatches("com.squareup.okhttp3:*", "Com.Squareup.OkHttp3:okhttp"), "matching ignores case")
        assertTrue(!wildcardMatches("com.squareup.okhttp3:*", "com.squareup.okhttp3x:okhttp"))
        assertTrue(!wildcardMatches("a.b", "aXb"), "only * is a wildcard")
        assertEquals(1, specificity(rest, "com.squareup.okhttp3:okhttp"))
        assertEquals(107, specificity(net, "com.squareup.okhttp3:okhttp"))
        assertEquals(0, specificity(net, "androidx.core:core-ktx"))
        assertEquals(500, specificity(majors, "androidx.core:core-ktx"))
        assertEquals(1000, specificity(DependabotGroup("x", listOf("a:b"), emptyList(), null), "a:b"))
        assertFailsWith<AssertionError> {
            dependabotGroups(gradleEntries(grouped.replace("update-types: [major]", "dependency-type: production")).single())
        }
        assertFailsWith<AssertionError> {
            dependabotGroups(gradleEntries(grouped.replace("patterns: [\"*\"]", "patterns: \"*\"")).single())
        }

        val script = """
            plugins {
                id("com.android.application") version "8.9.1" apply false
                kotlin("jvm") version "2.2.0"
                id("org.jetbrains.kotlin.plugin.compose")
            }
            dependencies {
                // implementation("commented:out:1.0")
                implementation(platform("androidx.compose:compose-bom:2025.06.00"))
                implementation("androidx.compose.ui:ui")
                api("com.squareup.okhttp3:okhttp:4.12.0")
                systemProperty("x:y", "z")
                inputs.file(rootDir.resolve("../app/build.gradle.kts"))
            }
        """.trimIndent()
        assertEquals(
            setOf(
                "androidx.compose:compose-bom", "androidx.compose.ui:ui", "com.squareup.okhttp3:okhttp",
                "com.android.application", "org.jetbrains.kotlin.jvm",
            ),
            declaredDependencies(script).toSet()
        )
    }

    companion object {
        private fun read(file: File) = file.readText().replace("\r\n", "\n")

        private fun indent(line: String) = line.length - line.trimStart().length
        private fun skip(line: String) = line.isBlank() || line.trimStart().startsWith("#")

        /**
         * Kotlin 2.2 metadata requires R8 8.10.21, bundled in AGP 8.10; AGP 8.9 could finish a
         * release while reporting metadata parsing errors. AGP 8.10 requires Gradle 8.11.1.
         * Sources: https://developer.android.com/build/kotlin-support and
         * https://developer.android.com/build/releases/agp-8-10-0-release-notes
         * Extend this check from the release notes when either plugin moves to another minor.
         */
        internal fun androidToolchain(build: String, wrapper: String) {
            fun version(raw: String): List<Int> {
                assertTrue(Regex("[0-9]+\\.[0-9]+\\.[0-9]+").matches(raw), "unsupported toolchain version: $raw")
                return raw.split('.').map(String::toInt)
            }
            fun plugin(id: String): List<Int> {
                val declaration = Regex("""id\(["']${Regex.escape(id)}["']\)\s+version\s+["']([^"']+)["']""")
                    .findAll(stripComments(build)).toList()
                assertEquals(1, declaration.size, "expected one literal version for plugin $id")
                return version(declaration.single().groupValues[1])
            }
            fun atLeast(actual: List<Int>, minimum: List<Int>): Boolean = actual.zip(minimum)
                .firstOrNull { (a, b) -> a != b }?.let { (a, b) -> a > b } ?: true

            val kotlin = plugin("org.jetbrains.kotlin.android")
            assertEquals(listOf(2, 2), kotlin.take(2), "update the R8 compatibility check for this Kotlin minor")
            val agp = plugin("com.android.application")
            assertTrue(atLeast(agp, listOf(8, 10, 0)), "Kotlin 2.2 requires AGP 8.10 or newer for supported R8 metadata")
            assertEquals(listOf(8, 10), agp.take(2), "verify the Gradle minimum for this AGP minor and extend this check")
            val properties = Properties().apply { load(wrapper.reader()) }
            val distribution = properties.getProperty("distributionUrl").orEmpty()
            val gradle = Regex("""/gradle-([0-9]+\.[0-9]+\.[0-9]+)-(?:bin|all)\.zip$""")
                .find(distribution)?.groupValues?.get(1)?.let(::version)
                ?: throw AssertionError("the wrapper must declare a stable Gradle distribution: $distribution")
            assertEquals(8, gradle[0], "verify AGP 8.10 compatibility before moving to another Gradle major")
            assertTrue(atLeast(gradle, listOf(8, 11, 1)), "AGP 8.10 requires Gradle 8.11.1 or newer")
        }

        /** CI prepares verified release inputs; local signing never becomes a public artifact. */
        internal fun betaPolicy(yaml: String) {
            val allJobs = jobs(yaml)
            val beta = allJobs["beta-checks"] ?: throw AssertionError("no private beta checks job")
            val header = beta.takeWhile { it.trim() != "steps:" }.map(String::trim)
            fun expression(value: String?): String = value.orEmpty().removePrefix("${'$'}{{")
                .removeSuffix("}}").filterNot(Char::isWhitespace)
            val gate = "(github.event_name=='workflow_dispatch'&&inputs.prepare_beta)||" +
                "(github.event_name=='push'&&github.ref=='refs/heads/claude/android-ios-parity-75kfem')"
            assertEquals(
                gate,
                expression(value(header, "if")),
                "private beta checks must require this beta branch's push or an opted-in manual dispatch",
            )
            val needs = value(header, "needs") ?: throw AssertionError("private beta checks have no prerequisites")
            assertTrue(needs.startsWith("[") && needs.endsWith("]"), "beta prerequisites must be an explicit job list")
            val prerequisites = needs.removeSurrounding("[", "]").split(',').map { it.trim().removeSurrounding("'").removeSurrounding("\"") }
            assertTrue(
                prerequisites.containsAll(listOf("protocol", "app-release")),
                "private beta checks must wait for protocol tests and the unsigned R8 release",
            )

            val lines = yaml.lines()
            val env = lines.indexOfFirst { it.trimEnd() == "env:" && indent(it) == 0 }
            assertTrue(env >= 0, "the beta branch needs workflow-level version defaults")
            val envLines = lines.drop(env + 1).takeWhile { skip(it) || indent(it) > 0 }.map(String::trim)
            val versionCode = value(envLines, "NODETERM_BETA_VERSION_CODE")?.toLongOrNull()
            assertTrue(versionCode != null && versionCode in 2..2_100_000_000L, "the beta version code must exceed the initial public debug build")
            val versionName = value(envLines, "NODETERM_BETA_VERSION_NAME").orEmpty()
            assertTrue(Regex("[0-9]+\\.[0-9]+\\.[0-9]+-beta\\.[1-9][0-9]*").matches(versionName), "the branch's version name must identify a beta")
            val dispatch = lines.indexOfFirst { it.trim() == "workflow_dispatch:" && indent(it) == 2 }
            assertTrue(dispatch >= 0, "private beta inputs must be declared on workflow_dispatch")
            val dispatchLines = lines.drop(dispatch + 1).takeWhile { skip(it) || indent(it) > 2 }
            val prepare = dispatchLines.indexOfFirst { it.trim() == "prepare_beta:" }
            assertTrue(prepare >= 0, "manual dispatch must expose the beta opt-in")
            val prepareLines = dispatchLines.drop(prepare + 1).takeWhile { skip(it) || indent(it) > indent(dispatchLines[prepare]) }.map(String::trim)
            assertEquals("boolean", value(prepareLines, "type"), "beta opt-in must be boolean")
            assertEquals("false", value(prepareLines, "default"), "ordinary manual runs must not prepare a beta")

            val release = allJobs["app-release"] ?: throw AssertionError("no unsigned release job")
            val releaseBuild = steps(release).single { runsGradlew(it) && it.any { line -> ":app:assembleRelease" in line } }
            val validator = releaseBuild.indexOfFirst { "python3 tools/check-beta-version.py" in it }
            val build = releaseBuild.indexOfFirst { ":app:assembleRelease" in it }
            assertTrue(validator >= 0 && validator < build, "selected beta versions must pass the shared packager rules before Gradle builds")
            val provenance = steps(beta).single { value(it, "BETA_VERSION_CODE") != null && value(it, "BETA_VERSION_NAME") != null }
            for ((key, input, default) in listOf(
                Triple("NODETERM_ANDROID_VERSION_CODE", "beta_version_code", "NODETERM_BETA_VERSION_CODE"),
                Triple("NODETERM_ANDROID_VERSION_NAME", "beta_version_name", "NODETERM_BETA_VERSION_NAME"),
            )) {
                assertEquals(
                    "($gate)&&(inputs.$input||env.$default)||''",
                    expression(value(releaseBuild, key)),
                    "release version overrides must use the same beta gate and version defaults",
                )
                assertEquals(
                    "inputs.$input||env.$default",
                    expression(value(provenance, key.removePrefix("NODETERM_ANDROID_").let { "BETA_$it" })),
                    "release provenance must use the build's version fallback",
                )
                for ((id, job) in allJobs) {
                    if (id == "app-release") continue
                    assertTrue(steps(job).none { value(it, key) != null }, "job $id exports a beta release version override")
                }
            }

            val releaseUpload = steps(release).single {
                uses(it)?.startsWith("actions/upload-artifact@") == true && value(it, "name") == "nodeterm-android-release-unsigned"
            }
            assertEquals("android/app/build/outputs/apk/release/*-unsigned.apk", value(releaseUpload, "path"))
            assertEquals("error", value(releaseUpload, "if-no-files-found"), "a missing unsigned APK must fail the release input job")
            for ((id, job) in allJobs) {
                for (step in steps(job)) {
                    if (id in setOf("app-release", "beta-checks")) {
                        assertTrue(step.none { "secrets." in it }, "beta build inputs must not receive a signing secret")
                    }
                    if (uses(step)?.startsWith("actions/upload-artifact@") != true) continue
                    val path = value(step, "path").orEmpty()
                    if (".apk" !in path && "/apk" !in path) continue
                    // Existing public debug builds are deliberately signed with the repository key
                    // (A10). Beta/release artifacts must contain unsigned build inputs only.
                    if (id == "app" && path == "android/app/build/outputs/apk/debug/*.apk") continue
                    assertTrue(
                        id == "app-release" && path == "android/app/build/outputs/apk/release/*-unsigned.apk",
                        "job $id uploads an APK outside the unsigned release input contract: $path",
                    )
                }
            }
        }

        /** A128: a release candidate must run the host submission tests, including real tmux. */
        internal fun composedInputCoverage(yaml: String) {
            val beta = jobs(yaml)["beta-checks"] ?: throw AssertionError("no private beta checks job")
            val matching = steps(beta).filter { value(it, "name") == "Phone delivery and ack tests" }
            assertEquals(1, matching.size, "private beta checks need exactly one phone delivery test step")
            val step = matching.single()
            val run = step.indexOfFirst { it.startsWith("run:") }
            assertTrue(run >= 0 && step[run] == "run: >-", "phone delivery tests must use the understood folded command")
            val arguments = step.drop(run + 1).takeWhile { !Regex("^[A-Za-z_-]+:").containsMatchIn(it) }
                .flatMap { it.split(Regex("\\s+")).filter(String::isNotEmpty) }
            assertTrue(arguments.all { Regex("[A-Za-z0-9./=_-]+").matches(it) }, "extend the command reader before introducing shell syntax")
            assertEquals(listOf("npx", "vitest", "run"), arguments.take(3), "phone delivery checks must execute Vitest")
            for (path in listOf(
                "src/core/composed-tmux.test.ts",
                "src/core/composed-tmux.realtmux.test.ts",
                "src/core/pty-composed-input.test.ts",
                "src/core/composed-pty.test.ts",
                "src/core/session-host-composed.test.ts",
                "src/core/native-windows-pane.test.ts",
                "src/session-host/composed-input-host.test.ts",
                "src/main/remote/host-composed-input.test.ts",
            )) {
                assertEquals(1, arguments.drop(3).count { it == path }, "private beta phone delivery checks must execute $path exactly once")
            }
        }

        internal val historyScrollPaths = listOf(
            "src/core/history-scroll-view.test.ts",
            "src/core/native-history-scroll.test.ts",
            "src/core/pty-history-scroll.test.ts",
            "src/core/session-host-history-scroll.test.ts",
            "src/session-host/terminal-scroll.test.ts",
            "src/session-host/history-scroll-host.test.ts",
            "src/main/remote/host-history-scroll.test.ts",
            "src/main/remote/android-history-fixture.test.ts",
        )

        /** A129: all backend, snapshot and public relay layers execute in the private beta gate. */
        internal fun historyScrollCoverage(yaml: String) {
            val beta = jobs(yaml)["beta-checks"] ?: throw AssertionError("no private beta checks job")
            val step = steps(beta).single { value(it, "name") == "Phone delivery and ack tests" }
            val run = step.indexOfFirst { it.startsWith("run:") }
            assertTrue(run >= 0 && step[run] == "run: >-", "history tests require the understood folded command")
            val arguments = step.drop(run + 1).takeWhile { !Regex("^[A-Za-z_-]+:").containsMatchIn(it) }
                .flatMap { it.split(Regex("\\s+")).filter(String::isNotEmpty) }
            assertTrue(arguments.all { Regex("[A-Za-z0-9./=_-]+").matches(it) }, "extend the reader before adding shell syntax")
            assertEquals(listOf("npx", "vitest", "run"), arguments.take(3))
            for (path in historyScrollPaths)
                assertEquals(1, arguments.drop(3).count { it == path }, "private beta history checks must execute $path exactly once")
        }

        /** The top-level `jobs:` of a workflow, as each job's non-comment lines (its id line excluded). */
        internal fun jobs(yaml: String): Map<String, List<String>> {
            val lines = yaml.lines()
            val start = lines.indexOfFirst { it.trimEnd() == "jobs:" }
            if (start < 0) throw AssertionError("no top-level `jobs:`")
            val out = LinkedHashMap<String, MutableList<String>>()
            var jobIndent = -1
            for (line in lines.drop(start + 1)) {
                if (skip(line)) continue
                val ind = indent(line)
                if (ind == 0) break
                if (jobIndent < 0) jobIndent = ind
                if (ind == jobIndent) {
                    val id = Regex("""([A-Za-z0-9_-]+):""").matchEntire(line.trim())?.groupValues?.get(1)
                        ?: throw AssertionError("unexpected line in jobs: $line")
                    out[id] = ArrayList()
                } else if (ind > jobIndent) {
                    out.values.last().add(line)
                } else {
                    throw AssertionError("unexpected indentation in jobs: $line")
                }
            }
            return out
        }

        /** A job's steps, each as its trimmed lines (the first without its `- `). */
        internal fun steps(job: List<String>): List<List<String>> {
            val s = job.indexOfFirst { it.trim() == "steps:" }
            if (s < 0) return emptyList()
            val stepsIndent = indent(job[s])
            val out = ArrayList<MutableList<String>>()
            var itemIndent = -1
            for (line in job.drop(s + 1)) {
                if (skip(line)) continue
                val ind = indent(line)
                if (ind <= stepsIndent) break
                if (itemIndent < 0) itemIndent = ind
                val text = line.trim()
                if (ind == itemIndent) {
                    if (!text.startsWith("- ")) throw AssertionError("unexpected line in steps: $line")
                    out.add(arrayListOf(text.removePrefix("- ").trim()))
                } else if (ind > itemIndent) {
                    out.last().add(text)
                } else {
                    throw AssertionError("unexpected indentation in steps: $line")
                }
            }
            return out
        }

        /** The value of `key:` among a step's (or an update entry's) lines, unquoted; null when absent. */
        internal fun value(lines: List<String>, key: String): String? =
            lines.firstOrNull { it.startsWith("$key:") }?.removePrefix("$key:")?.trim()?.removeSurrounding("'")?.removeSurrounding("\"")

        private fun uses(step: List<String>) = value(step, "uses")
        private fun isSetupGradle(step: List<String>) = uses(step)?.startsWith("gradle/actions/setup-gradle@") == true
        private fun isCodeqlInit(step: List<String>) = uses(step)?.startsWith("github/codeql-action/init@") == true

        /** Whether a step's `run:` invokes the wrapper (a step's name does not count). */
        internal fun runsGradlew(step: List<String>): Boolean {
            val run = step.indexOfFirst { it.startsWith("run:") }
            return run >= 0 && step.drop(run).any { "gradlew" in it }
        }

        /**
         * The `updates:` entries of a dependabot.yml, each as its non-comment lines: the first trimmed and
         * without its `- `, the others with their indentation (the nesting of `groups:` needs it).
         */
        private fun updateEntries(yaml: String): List<List<String>> {
            val lines = yaml.lines().filterNot(::skip)
            val start = lines.indexOfFirst { it.trimEnd() == "updates:" }
            if (start < 0) throw AssertionError("no top-level `updates:`")
            val entries = ArrayList<MutableList<String>>()
            var itemIndent = -1
            for (line in lines.drop(start + 1)) {
                val ind = indent(line)
                if (ind == 0) break
                if (itemIndent < 0) itemIndent = ind
                val text = line.trim()
                if (ind == itemIndent) {
                    if (!text.startsWith("- ")) throw AssertionError("unexpected line in updates: $line")
                    entries.add(arrayListOf(text.removePrefix("- ").trim()))
                } else if (ind > itemIndent) {
                    entries.last().add(line)
                } else {
                    throw AssertionError("unexpected indentation in updates: $line")
                }
            }
            return entries
        }

        /** The `package-ecosystem: gradle` entries of a dependabot.yml, as [updateEntries] gives them. */
        internal fun gradleEntries(yaml: String): List<List<String>> =
            updateEntries(yaml).filter { value(it.map(String::trim), "package-ecosystem") == "gradle" }.onEach { entry ->
                if (entry.any { it.trim().startsWith("directories:") }) {
                    throw AssertionError("`directories:` is not understood by this reader; extend it")
                }
            }

        /** The `directory:` of each `package-ecosystem: gradle` entry of a dependabot.yml. */
        internal fun gradleDirectories(yaml: String): List<String> = gradleEntries(yaml).map { entry ->
            value(entry.map(String::trim), "directory") ?: throw AssertionError("a gradle entry without a directory: $entry")
        }

        /**
         * One Dependabot group, as far as it decides what it takes: [patterns] null when the group has none
         * (it takes every dependency), [updateTypes] null when it takes every update type.
         */
        internal data class DependabotGroup(
            val name: String,
            val patterns: List<String>?,
            val excludePatterns: List<String>,
            val updateTypes: List<String>?,
        )

        /** The `groups:` of one update entry (from [gradleEntries]), in file order. */
        internal fun dependabotGroups(entry: List<String>): List<DependabotGroup> {
            val at = entry.indexOfFirst { it.trim() == "groups:" }
            if (at < 0) return emptyList()
            if (at == 0) throw AssertionError("an update entry that starts with `groups:` is not understood by this reader")
            val block = entry.drop(at + 1).takeWhile { indent(it) > indent(entry[at]) }
            val groups = ArrayList<Pair<String, MutableList<String>>>()
            var groupIndent = -1
            for (line in block) {
                val ind = indent(line)
                if (groupIndent < 0) groupIndent = ind
                if (ind == groupIndent) {
                    val name = Regex("""([A-Za-z0-9_.-]+):""").matchEntire(line.trim())?.groupValues?.get(1)
                        ?: throw AssertionError("unexpected line in groups: $line")
                    groups.add(name to ArrayList())
                } else if (ind > groupIndent) {
                    groups.last().second.add(line)
                } else {
                    throw AssertionError("unexpected indentation in groups: $line")
                }
            }
            return groups.map { (name, body) -> group(name, body) }
        }

        private fun group(name: String, body: List<String>): DependabotGroup {
            val rules = HashMap<String, List<String>>()
            var keyIndent = -1
            var i = 0
            while (i < body.size) {
                val line = body[i++]
                if (keyIndent < 0) keyIndent = indent(line)
                if (indent(line) != keyIndent) throw AssertionError("unexpected indentation in group $name: $line")
                val (key, rest) = Regex("""([a-z-]+):\s*(.*)""").matchEntire(line.trim())?.destructured
                    ?: throw AssertionError("unexpected line in group $name: $line")
                if (key !in setOf("patterns", "exclude-patterns", "update-types")) {
                    // dependency-type, applies-to, group-by... change what a group takes; extend this reader.
                    throw AssertionError("`$key` in Dependabot group $name is not understood by this reader; extend it")
                }
                val items = if (rest.isNotEmpty()) {
                    if (!rest.startsWith("[") || !rest.endsWith("]")) throw AssertionError("group $name: `$key` is not a list: $rest")
                    rest.removeSurrounding("[", "]").split(",").map(String::trim).filter(String::isNotEmpty)
                } else {
                    val block = ArrayList<String>()
                    while (i < body.size && indent(body[i]) > keyIndent) {
                        val item = body[i++].trim()
                        if (!item.startsWith("- ")) throw AssertionError("unexpected line in group $name: $item")
                        block.add(item.removePrefix("- ").trim())
                    }
                    block
                }
                rules[key] = items.map { item ->
                    if ('#' in item) throw AssertionError("group $name: a comment inside `$key` is not understood: $item")
                    item.removeSurrounding("'").removeSurrounding("\"")
                }
            }
            return DependabotGroup(name, rules["patterns"], rules["exclude-patterns"].orEmpty(), rules["update-types"])
        }

        /** dependabot-core's WildcardMatcher: `*` matches any run of characters, the rest itself, ignoring case. */
        internal fun wildcardMatches(pattern: String, name: String): Boolean =
            Regex(pattern.lowercase().split("*").joinToString(".*") { Regex.escape(it) }).matches(name.lowercase())

        /** Whether [group] takes an [updateType] update of [name] (dependabot-core's DependencyGroup#contains?). */
        internal fun takes(group: DependabotGroup, name: String, updateType: String): Boolean =
            (group.updateTypes == null || updateType in group.updateTypes) &&
                group.excludePatterns.none { wildcardMatches(it, name) } &&
                (group.patterns == null || group.patterns.any { wildcardMatches(it, name) })

        /**
         * How specifically [group] names [name], by dependabot-core's PatternSpecificityCalculator: an exact
         * pattern 1000, one without `*` 500, no patterns 500, `*` alone 1, other wildcards
         * 100 - 10 per `*` + one per character past five.
         */
        internal fun specificity(group: DependabotGroup, name: String): Int {
            val patterns = group.patterns ?: return 500
            return patterns.filter { wildcardMatches(it, name) }.maxOfOrNull { p ->
                when {
                    p == name -> 1000
                    p == "*" -> 1
                    '*' !in p -> 500
                    else -> maxOf(100 - 10 * p.count { it == '*' } + maxOf(p.length - 5, 0), 1)
                }
            } ?: 0
        }

        /** The build scripts of one Gradle build: its own and its subprojects', not those of builds inside it. */
        private fun buildScripts(build: File): List<File> = build.canonicalFile.let { dir ->
            dir.walkTopDown()
                .onEnter {
                    it == dir || (it.name !in setOf("build", ".gradle", "node_modules") &&
                        listOf("settings.gradle.kts", "settings.gradle").none { s -> File(it, s).isFile })
                }
                .filter { it.isFile && (it.name == "build.gradle.kts" || it.name == "build.gradle") }
                .toList()
        }

        /**
         * The dependencies a build script declares, named as Dependabot names them: `group:artifact` for a
         * library (from any call with one "group:artifact[:version]" argument, `platform(...)` included)
         * and the plugin id for a plugin with a version (`kotlin("jvm")` is org.jetbrains.kotlin.jvm).
         */
        internal fun declaredDependencies(script: String): List<String> {
            val text = stripComments(script)
            val libraries = Regex("""\b\w+\(\s*"([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?::[A-Za-z0-9_.+-]*)?"\s*\)""")
                .findAll(text).map { "${it.groupValues[1]}:${it.groupValues[2]}" }
            val plugins = Regex("""\bid\(\s*"([^"]+)"\s*\)\s+version\s+"""").findAll(text).map { it.groupValues[1] }
            val kotlinPlugins = Regex("""\bkotlin\(\s*"([^"]+)"\s*\)\s+version\s+"""").findAll(text)
                .map { "org.jetbrains.kotlin.${it.groupValues[1]}" }
            return (libraries + plugins + kotlinPlugins).toList()
        }

        private fun stripComments(kts: String) =
            kts.replace(Regex("""(?s)/\*.*?\*/"""), "").lines().joinToString("\n") { it.replace(Regex("""(^|\s)//.*$"""), "") }

        /** The builds a settings script includes with `includeBuild(...)`, as written (Dependabot's reading). */
        internal fun includedBuilds(settings: String): List<String> =
            Regex("""(?:^|\s)includeBuild\s*\(\s*["']([^"']+)["']\s*\)""").findAll(stripComments(settings)).map { it.groupValues[1] }.toList()

        /** [build] and every build it includes, transitively: what one Dependabot gradle entry covers. */
        private fun coveredBuilds(build: File, seen: MutableSet<File> = HashSet()): List<File> {
            val dir = build.canonicalFile
            if (!seen.add(dir)) return emptyList()
            val settings = listOf("settings.gradle.kts", "settings.gradle").map { File(dir, it) }.firstOrNull { it.isFile }
                ?: return listOf(dir)
            return listOf(dir) + includedBuilds(read(settings)).flatMap { coveredBuilds(File(dir, it), seen) }
        }
    }
}
