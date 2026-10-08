package dev.nodeterm.protocol

import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.io.File
import java.util.zip.ZipFile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Audit A37: the release build's R8 rules, `android/app/proguard-rules.pro`.
 *
 * R8 itself runs in CI (`:app:assembleRelease` plus `tools/check-r8-output.sh`, in
 * `.github/workflows/android.yml`); AGP needs Google Maven, so it cannot run everywhere these tests
 * do. This checks what a JVM can:
 *
 *  1. Missing classes. R8 fails the build on a class that code it compiles references and neither the
 *     app nor android.jar defines, unless a `-dontwarn` names the missing class or the class that
 *     references it. The jars the app gets through this module (sshj, BouncyCastle, EdDSA, OkHttp,
 *     kotlinx) are read here, every reference Android cannot resolve is collected, and each must be
 *     covered by the app's rules or by the consumer rules the jar itself ships. The previous rules
 *     missed three (sshj's GSSAPI classes and `LoginContext`, EdDSA's `X509Key`).
 *  2. Keeps for code reached by NAME, which R8's tracing cannot see and a successful build does not
 *     check: the WebView bridge (terminal.js calls its methods by name) and the WorkManager worker
 *     (instantiated from the class name WorkManager stored).
 *
 * "Android cannot resolve" is an approximation: not defined in the scanned jars, and either absent
 * from the JDK or in a package android.jar does not ship ([androidLacks]). It over-approximates R8,
 * which only reports references from code it keeps. The app's own dependencies (androidx, Compose,
 * zxing) are not on this classpath; CI's R8 run covers them. None of this proves a release APK works
 * on a device.
 */
class R8RulesTest {
    private val root = InteropHarness.repoRoot
    private val rulesFile = File(root, "android/app/proguard-rules.pro")
    private val appSrc = File(root, "android/app/src/main/kotlin")

    /** The runtime jars of this module, i.e. what the app ships from it (set by build.gradle.kts). */
    private val shippedJars: List<File> by lazy {
        val path = System.getProperty("nodeterm.runtimeClasspath")
            ?: error("nodeterm.runtimeClasspath is not set; run through Gradle (see protocol/build.gradle.kts)")
        path.split(File.pathSeparator).filter { it.endsWith(".jar") }.map(::File)
    }

    private fun rulesText(): String = rulesFile.readText().replace(Regex("#[^\n]*"), "")

    /** The scan of [shippedJars]; it must see the jars, or the tests below pass on nothing. */
    private val scan: Scan by lazy {
        scanShippedJars().also { assertTrue(it.classes > 1000, "only ${it.classes} classes scanned from $shippedJars") }
    }

    /**
     * App-rule `-dontwarn` patterns for dependencies of the app that are not on this module's classpath
     * (androidx, Compose, zxing), which the scan therefore cannot see used. Empty today.
     */
    private val appOnlyDontwarns = emptySet<String>()

    // ---- 1. missing classes ----------------------------------------------------------------------

    @Test
    fun `every class Android lacks that a shipped jar references is covered by a -dontwarn`() {
        val appRules = dontwarnFilters(rulesText())
        val rules = appRules + scan.consumerDontwarns
        val uncovered = scan.missing.mapNotNull { (missing, contexts) ->
            if (rules.any { it.matches(missing) }) return@mapNotNull null
            // R8 drops a missing-class report when every class referencing it is -dontwarn'ed too.
            val open = contexts.filterNot { ctx -> rules.any { it.matches(ctx) } }
            if (open.isEmpty()) null else "$missing  <- ${open.sorted().take(3).joinToString()}"
        }.sorted()
        assertEquals(
            emptyList(), uncovered,
            "R8 would fail the release build on these (missing class <- referenced from). Add a -dontwarn " +
                "to android/app/proguard-rules.pro once you have checked the code is never reached on a phone."
        )
    }

    @Test
    fun `every -dontwarn in the app rules still matches a reference in the shipped jars`() {
        val names = scan.missing.keys + scan.missing.values.flatten()
        val unused = dontwarnFilters(rulesText()).map { it.spec }.filter { it !in appOnlyDontwarns }
            .filter { spec -> ClassFilter(spec).let { f -> names.none { f.matches(it) } } }
        assertEquals(
            emptyList(), unused,
            "these -dontwarn rules match no missing reference in the shipped jars (a stale rule hides the next real " +
                "one): drop them, or, for an app-only dependency this classpath does not contain, list them in appOnlyDontwarns"
        )
    }

    // ---- 2. keeps for code reached by name --------------------------------------------------------

    @Test
    fun `the WebView bridge's @JavascriptInterface methods survive R8 with their annotation`() {
        val bridges = appSrc.walkTopDown().filter { it.extension == "kt" && "@JavascriptInterface" in it.readText() }.toList()
        assertTrue(bridges.isNotEmpty(), "no @JavascriptInterface in the app sources; was the bridge moved?")
        val rules = rulesText().replace(Regex("\\s+"), " ")
        assertTrue(
            Regex("""-keepclassmembers class \* \{ @android\.webkit\.JavascriptInterface <methods> ?; ?}""").containsMatchIn(rules),
            "terminal.js calls the bridge's methods by name; they need a -keepclassmembers rule"
        )
        assertTrue(
            Regex("""-keepattributes [^-]*RuntimeVisibleAnnotations""").containsMatchIn(rules),
            "Android exposes only methods still annotated @JavascriptInterface"
        )
    }

    @Test
    fun `every WorkManager worker keeps its name and its (Context, WorkerParameters) constructor`() {
        val workers = appSrc.walkTopDown().filter { it.extension == "kt" }.flatMap { f ->
            val text = f.readText()
            val pkg = Regex("""(?m)^package\s+([\w.]+)""").find(text)?.groupValues?.get(1).orEmpty()
            Regex("""class\s+(\w+)\s*\([^)]*\)\s*:\s*(?:CoroutineWorker|Worker|ListenableWorker)\s*\(""")
                .findAll(text).map { "$pkg.${it.groupValues[1]}" }
        }.toList()
        assertTrue(workers.isNotEmpty(), "no worker found in the app sources; was InboxWorker moved?")
        val rules = rulesText().replace(Regex("\\s+"), " ")
        for (w in workers) {
            // `-keep class` with no allowobfuscation: WorkManager stores the class name across releases.
            val keep = Regex(
                "-keep class " + Regex.escape(w) +
                    """ \{[^}]*public <init> ?\( ?android\.content\.Context ?, ?androidx\.work\.WorkerParameters ?\) ?;[^}]*}"""
            )
            assertTrue(keep.containsMatchIn(rules), "$w needs `-keep class $w { public <init>(android.content.Context, androidx.work.WorkerParameters); }`")
        }
    }

    @Test
    fun `exception class names survive where error text falls back to them`() {
        val sources = listOf(appSrc, File(root, "android/protocol/src/main/kotlin"))
        val users = sources.flatMap { dir -> dir.walkTopDown().filter { it.extension == "kt" && "javaClass.simpleName" in it.readText() }.toList() }
        if (users.isEmpty()) return
        assertTrue(
            Regex("""-keepnames class \* extends java\.lang\.Throwable""").containsMatchIn(rulesText().replace(Regex("\\s+"), " ")),
            "${users.map { it.name }} show e.javaClass.simpleName to the user; obfuscated it reads \"a\""
        )
    }

    @Test
    fun `the release build runs R8 and CI builds it, while debug stays unminified`() {
        val gradle = File(root, "android/app/build.gradle.kts").readText()
        val release = AppSourcePins.blockAfter(gradle, "release {")
        val debug = AppSourcePins.blockAfter(gradle, "debug {")
        assertTrue(Regex("""isMinifyEnabled\s*=\s*true""").containsMatchIn(release), "release must be minified:\n$release")
        assertTrue("proguard-rules.pro" in release, "release must use proguard-rules.pro:\n$release")
        assertTrue(!Regex("""isMinifyEnabled\s*=\s*true""").containsMatchIn(debug), "debug is the distributed APK and stays unminified")
        val ci = File(root, ".github/workflows/android.yml").readText()
        assertTrue(":app:assembleRelease" in ci, "CI must build the release APK so R8 runs on every change")
        assertTrue("tools/check-r8-output.sh" in ci, "CI must check the R8 keeps matched")
    }

    // ---- the scan ---------------------------------------------------------------------------------

    private class Scan(val classes: Int, val missing: Map<String, Set<String>>, val consumerDontwarns: List<ClassFilter>)

    /**
     * Packages the JDK has and android.jar (API 35) does not. Only what a shipped jar could plausibly
     * reference; the list decides nothing for a class that no jar references.
     */
    private val androidLacks = listOf(
        "sun.", "com.sun.", "jdk.", "org.ietf.jgss.", "javax.naming.", "java.lang.instrument.",
        "java.lang.management.", "javax.management.", "java.awt.", "javax.swing.", "javax.imageio.",
        "java.rmi.", "javax.rmi.", "javax.security.auth.kerberos.", "java.net.http.", "javax.script.",
        "javax.tools.", "javax.lang.model.", "javax.annotation.processing."
    )

    private fun androidLacks(name: String): Boolean =
        androidLacks.any { name.startsWith(it) } ||
            // android.jar's javax.security.auth.login holds LoginException and nothing else.
            (name.startsWith("javax.security.auth.login.") && name != "javax.security.auth.login.LoginException")

    private fun inJdk(name: String): Boolean =
        ClassLoader.getPlatformClassLoader().getResource(name.replace('.', '/') + ".class") != null

    private fun scanShippedJars(): Scan {
        val defined = HashSet<String>()
        val refs = HashMap<String, MutableSet<String>>() // referenced class -> classes referencing it
        val consumer = ArrayList<ClassFilter>()
        var count = 0
        for (jar in shippedJars) ZipFile(jar).use { zip ->
            for (e in zip.entries()) {
                val n = e.name
                if (n.endsWith(".pro") && (n.startsWith("META-INF/proguard/") || n.startsWith("META-INF/com.android.tools/"))) {
                    consumer += dontwarnFilters(zip.getInputStream(e).readBytes().decodeToString().replace(Regex("#[^\n]*"), ""))
                }
                // D8/R8 ignore everything under META-INF (multi-release versions included) and module-info.
                if (!n.endsWith(".class") || n.startsWith("META-INF/") || n.endsWith("module-info.class")) continue
                val (self, used) = classReferences(zip.getInputStream(e).readBytes())
                defined += self
                count++
                for (r in used) if (r != self) refs.getOrPut(r) { HashSet() } += self
            }
        }
        val missing = refs.filterKeys { r ->
            r !in defined && !r.startsWith("android.") && !r.startsWith("dalvik.") && (!inJdk(r) || androidLacks(r))
        }
        return Scan(count, missing, consumer)
    }

    /** This class's name and every class its constant pool and member descriptors name. */
    private fun classReferences(bytes: ByteArray): Pair<String, Set<String>> {
        val input = DataInputStream(ByteArrayInputStream(bytes))
        require(input.readInt() == 0xCAFEBABE.toInt()) { "not a class file" }
        input.readUnsignedShort(); input.readUnsignedShort()
        val n = input.readUnsignedShort()
        val utf8 = arrayOfNulls<String>(n)
        val classNameAt = IntArray(n) // CONSTANT_Class #i -> the Utf8 holding its name
        val descIdx = ArrayList<Int>()
        var i = 1
        while (i < n) {
            when (val tag = input.readUnsignedByte()) {
                1 -> utf8[i] = input.readUTF()
                3, 4 -> input.readInt()
                5, 6 -> { input.readLong(); i++ } // takes two slots
                7 -> classNameAt[i] = input.readUnsignedShort()
                8, 19, 20 -> input.readUnsignedShort()
                16 -> descIdx += input.readUnsignedShort() // MethodType
                9, 10, 11, 17, 18 -> { input.readUnsignedShort(); input.readUnsignedShort() }
                12 -> { input.readUnsignedShort(); descIdx += input.readUnsignedShort() } // NameAndType
                15 -> { input.readUnsignedByte(); input.readUnsignedShort() }
                else -> error("constant pool tag $tag")
            }
            i++
        }
        input.readUnsignedShort() // access
        val self = utf8[classNameAt[input.readUnsignedShort()]] ?: error("no this_class")
        input.readUnsignedShort() // super_class, a CONSTANT_Class like any other
        repeat(input.readUnsignedShort()) { input.readUnsignedShort() }
        repeat(2) { // fields, then methods: their descriptors name types no instruction may touch
            repeat(input.readUnsignedShort()) {
                input.readUnsignedShort(); input.readUnsignedShort()
                descIdx += input.readUnsignedShort()
                repeat(input.readUnsignedShort()) { input.readUnsignedShort(); input.skipBytes(input.readInt()) }
            }
        }
        val names = HashSet<String>()
        val inDescriptor = Regex("L([^;]+);")
        for (idx in classNameAt) {
            val s = if (idx == 0) continue else utf8[idx] ?: continue
            if (s.startsWith("[")) inDescriptor.findAll(s).forEach { names += it.groupValues[1] } else names += s
        }
        for (idx in descIdx) utf8[idx]?.let { d -> inDescriptor.findAll(d).forEach { names += it.groupValues[1] } }
        return self.replace('/', '.') to names.map { it.replace('/', '.') }.toSet()
    }

    // ---- ProGuard class filters -------------------------------------------------------------------

    /** A `-dontwarn` argument: a comma list of `?`/`*`/`**` patterns, each optionally negated with `!`. */
    private class ClassFilter(val spec: String) {
        private val parts = spec.split(',').map { it.trim() }.filter { it.isNotEmpty() }.ifEmpty { listOf("**") }.map { p ->
            val negated = p.startsWith("!")
            negated to Regex(glob(p.removePrefix("!")))
        }

        fun matches(name: String): Boolean {
            for ((negated, re) in parts) if (re.matches(name)) return !negated
            return false
        }

        private fun glob(g: String): String = buildString {
            var i = 0
            while (i < g.length) {
                when {
                    g.startsWith("**", i) -> { append(".*"); i += 2; continue }
                    g[i] == '*' -> append("[^.]*")
                    g[i] == '?' -> append("[^.]")
                    else -> append(Regex.escape(g[i].toString()))
                }
                i++
            }
        }
    }

    private fun dontwarnFilters(rules: String): List<ClassFilter> =
        rules.lines().map { it.trim() }.filter { it.startsWith("-dontwarn") }
            .map { ClassFilter(it.removePrefix("-dontwarn").trim()) }
}
