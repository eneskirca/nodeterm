package dev.nodeterm.protocol

import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Audit A51: `allowBackup="false"` alone did not keep the phone's data on the phone. For an app that
 * targets Android 12 (API 31) or later, it stops cloud backup but NOT a device-to-device transfer;
 * only the `<device-transfer>` section of the manifest's data extraction rules does. The transfer
 * copied `nodeterm.hosts` (every paired computer, its SSH pin and the relay deviceId) to the new
 * phone, where the Keystore-sealed secrets could not follow.
 *
 * The rules are resources a JVM cannot hand to Android's backup manager, so this pins the files: the
 * manifest points at the rules, both sections exclude every domain, and every preferences file the
 * app opens is covered. What a real transfer copies is a device check. The deviceId half of the fix
 * (a new box key always comes with a new deviceId) is [PhoneIdentityTest].
 */
class BackupRulesTest {
    private val appMain = File(InteropHarness.repoRoot, "android/app/src/main")
    private val androidNs = "http://schemas.android.com/apk/res/android"

    private fun parse(file: File): Element =
        DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder().parse(file).documentElement

    private fun Element.children(tag: String): List<Element> =
        (0 until childNodes.length).map { childNodes.item(it) }.filterIsInstance<Element>().filter { it.tagName == tag }

    /** Every domain Android's backup rules know; each is its own tree, so each needs its own exclusion. */
    private val domains = listOf(
        "root", "file", "database", "sharedpref", "external",
        "device_root", "device_file", "device_database", "device_sharedpref"
    )

    private fun application(): Element = parse(File(appMain, "AndroidManifest.xml")).children("application").single()

    private fun rules(): Element {
        val ref = application().getAttributeNS(androidNs, "dataExtractionRules")
        assertEquals("@xml/data_extraction_rules", ref, "the manifest must name the data extraction rules")
        return parse(File(appMain, "res/xml/data_extraction_rules.xml"))
    }

    /** The (domain, path) pairs a section excludes. */
    private fun excluded(section: Element): Set<Pair<String, String>> =
        section.children("exclude").map { it.getAttribute("domain") to it.getAttribute("path") }.toSet()

    @Test
    fun `backups stay off, and the rules cover device transfer as well as the cloud`() {
        assertEquals("false", application().getAttributeNS(androidNs, "allowBackup"))
        val root = rules()
        assertEquals("data-extraction-rules", root.tagName)
        for (name in listOf("cloud-backup", "device-transfer")) {
            val section = assertNotNull(root.children(name).singleOrNull(), "<$name> is missing: that path copies the app's data")
            assertEquals(emptyList(), section.children("include"), "<$name> must not include anything back")
            val missing = domains.filter { (it to ".") !in excluded(section) }
            assertEquals(emptyList(), missing, "<$name> leaves these domains in: $missing")
        }
    }

    @Test
    fun `every preferences file the app opens is excluded from both`() {
        val names = appMain.walkTopDown().filter { it.extension == "kt" }
            .flatMap { Regex("""getSharedPreferences\(\s*"([^"]+)"""").findAll(it.readText()).map { m -> m.groupValues[1] } }
            .toSet()
        assertTrue("nodeterm.hosts" in names && "nodeterm.secure" in names, "found: $names")
        val root = rules()
        for (name in listOf("cloud-backup", "device-transfer")) {
            val ex = excluded(root.children(name).single())
            for (prefs in names) {
                // A sharedpref path names the FILE, with its .xml suffix.
                val covered = ("sharedpref" to ".") in ex || ("sharedpref" to "$prefs.xml") in ex
                assertTrue(covered, "<$name> does not exclude $prefs.xml")
            }
        }
    }
}
