import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.2.0"
    `java-library`
}

group = "dev.nodeterm"
version = "0.1.0"

java {
    // Android's D8 accepts Java 17 bytecode; building with a newer JDK is fine, targeting it is not.
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        freeCompilerArgs.add("-Xjsr305=strict")
    }
}

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    api("com.squareup.okhttp3:okhttp:4.12.0")
    // Direct-SSH transport (LAN pairing). sshj brings its own BouncyCastle + EdDSA; on Android the
    // app re-registers the full BouncyCastle provider at startup (see NodetermApp).
    api("com.hierynomus:sshj:0.39.0")
    // sshj declares EdDSA runtime-only; the phone's Ed25519 identity is built with it directly.
    api("net.i2p.crypto:eddsa:0.3.0")

    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.11.4")
    // A real SSH server for the direct-SSH transport tests (runs /bin/sh + a sandboxed tmux).
    testImplementation("org.apache.sshd:sshd-core:2.14.0")
    testRuntimeOnly("org.slf4j:slf4j-simple:2.0.16")
}

tasks.test {
    useJUnitPlatform()
    // Interop tests drive this repo's TypeScript host code through node. They locate the repo root
    // from here and skip themselves (with a reason) when node or node_modules are missing.
    systemProperty("nodeterm.repoRoot", rootDir.resolve("../..").canonicalPath)
    // Files some tests run or read that are not on the test classpath: the node drivers, the app's
    // terminal page (TerminalJs*Test), the app's sources (the source pins in TerminalKeyboardChipTest,
    // SettingsLeaveTest and R8RulesTest), the release build's R8 rules, its build type and the CI
    // workflow that runs R8 (R8RulesTest), the CI config GradleCiCoverageTest checks: that workflow
    // (every job that runs Gradle is in it), the Dependabot config, the root build's settings and the
    // build scripts whose dependencies it matches against the Dependabot groups (the app's is named
    // above), and the contributor docs and the wrapper's Gradle version ContributorDocsTest checks
    // against each other, and the audit whose finding ids DeviceChecklistDocsTest checks the device
    // checklist against.
    // Declared so a change to one of them re-runs the tests instead of leaving them "up to date".
    inputs.dir("src/test/interop").withPathSensitivity(PathSensitivity.RELATIVE)
    // The desktop code the interop fixture bundles (the same dirs as android.yml's path filter). Without
    // them a desktop change, say to the projects.list assembly or the agent-status mirror the relay
    // tests read (audit A64), left the tests "up to date" locally and was never run against.
    for (dir in listOf("src/core", "src/shared", "src/main", "src/session-host")) {
        inputs.dir(rootDir.resolve("../../$dir")).withPathSensitivity(PathSensitivity.RELATIVE)
    }
    // The custom-profile fixture uses the actual Server path resolver/platform without starting
    // Server services. These imported sources must also invalidate the locally cached test task.
    inputs.file(rootDir.resolve("../../src/server/config.ts")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file(rootDir.resolve("../../src/server/platform-server.ts")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file(rootDir.resolve("../../src/server/proxy-trust.ts")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file(rootDir.resolve("../../tsconfig.json")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.dir(rootDir.resolve("../app/src/main/assets/terminal")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.dir(rootDir.resolve("../app/src/main/kotlin")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file(rootDir.resolve("../app/proguard-rules.pro")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file(rootDir.resolve("../app/build.gradle.kts")).withPathSensitivity(PathSensitivity.RELATIVE)
    // The app's manifest (BackupRulesTest, DictationTest) and the type-check's build, whose android-all
    // pin DictationTest reads the recognizer's error codes from.
    inputs.file(rootDir.resolve("../app/src/main/AndroidManifest.xml")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file(rootDir.resolve("../tools/typecheck/build.gradle.kts")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file(rootDir.resolve("../../.github/workflows/android.yml")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file(rootDir.resolve("../../.github/dependabot.yml")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file(rootDir.resolve("../settings.gradle.kts")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file(rootDir.resolve("../build.gradle.kts")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file(rootDir.resolve("build.gradle.kts")).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file(rootDir.resolve("../gradle/wrapper/gradle-wrapper.properties")).withPathSensitivity(PathSensitivity.RELATIVE)
    for (doc in listOf(
        "CONTRIBUTING.md", "docs/android.md", "android/README.md", "android/tools/typecheck/README.md",
        "docs/android-audit-2026-09.md",
    )) {
        inputs.file(rootDir.resolve("../../$doc")).withPathSensitivity(PathSensitivity.RELATIVE)
    }
    // R8RulesTest reads the jars this module ships to the app (its runtime classpath, not the test one)
    // for the classes they reference that Android lacks (audit A37).
    val shippedJars: FileCollection = configurations.runtimeClasspath.get()
    inputs.files(shippedJars).withPropertyName("shippedJars").withNormalizer(ClasspathNormalizer::class.java)
    jvmArgumentProviders.add(CommandLineArgumentProvider { listOf("-Dnodeterm.runtimeClasspath=${shippedJars.asPath}") })
    systemProperty("org.slf4j.simpleLogger.defaultLogLevel", "warn")
    testLogging {
        events("failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
