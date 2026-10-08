package dev.nodeterm.protocol

import org.junit.jupiter.api.Assumptions
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * What the docs admit about the app that has never run on a phone, pinned against the files that make
 * it true:
 *
 *  - Audit A65: android/README.md marked every feature ✓ with no word that nothing had been checked on
 *    a device, and docs/android.md had no device checklist, although CLAUDE.md asks for a numbered one
 *    for whatever could not be run. The checklist must exist, be numbered, name the finding each item
 *    checks, and cover every finding the design notes leave to a device ("a device check", "only
 *    type-checked", "on a device"); the README's feature table must point at it.
 *  - Audit A50: the only APK to install is the debug build, which AGP marks debuggable, so adb access
 *    to the phone yields its pairing credentials. While the release build type has no signing config
 *    (so there is no release to install instead), the README must say so.
 *    Its recovery must give the phone a new identity (uninstall, or clear its storage) before it pairs
 *    again, since a re-pair keeps the same keys (review of A50).
 *  - The camera-app pairing check must name the desktop's switch to the link QR while the QR defaults
 *    to raw JSON (review of A65).
 *
 * The audit and the handover are logs, so only the audit's section headings are read (for the ids).
 */
class DeviceChecklistDocsTest {
    // Read by literal paths, so WorkflowPathFilterTest makes the Android workflow run when one changes.
    private val notes = read(File(InteropHarness.repoRoot, "docs/android.md"))
    private val readme = read(File(InteropHarness.repoRoot, "android/README.md"))

    @Test
    fun `continuation findings with three digits retain their full identity`() {
        assertEquals(setOf("A09", "A100", "A108", "A1000"),
            findingIds("A09 A100 A108 A1000 A9 AA100 A100suffix"))
        assertEquals(listOf("A09", "A100", "A108"),
            auditHeadingIds("## A09\n## A100\n## A108\n### A109\n## A9\n## A100suffix"))
    }

    @Test
    fun `the device checklist is numbered from 1 and every item names a finding the audit has`() {
        val items = checklistItems()
        assertTrue(
            items.size >= 23,
            "the checklist has ${items.size} items; it started from the handover's 23, so has it been gutted?"
        )
        assertEquals((1..items.size).toList(), items.map { it.first }, "checklist items must be numbered 1, 2, 3, … in order")
        val known = auditIds()
        for ((n, text) in items) {
            val ids = findingIds(text)
            assertTrue(ids.isNotEmpty(), "checklist item $n names no audit finding (A65 marks a baseline check):\n$text")
            val unknown = ids - known
            assertTrue(unknown.isEmpty(), "checklist item $n names $unknown, which the audit does not have:\n$text")
        }
    }

    @Test
    fun `every finding the design notes leave to a device has a checklist item`() {
        val listed = checklistItems().flatMap { findingIds(it.second) }.toSet()
        val outside = notes.replace(checklistSection(), "")
        var deferring = 0
        for (paragraph in outside.split(Regex("""\n\s*\n"""))) {
            if (!leftToDevice.containsMatchIn(paragraph)) continue
            deferring++
            val missing = findingIds(paragraph) - listed
            assertTrue(
                missing.isEmpty(),
                "docs/android.md leaves $missing to a device, but the device checklist has no item for it:\n$paragraph"
            )
        }
        // The notes defer the ⌨ chip, Settings back, the lock screen, live notifications, device
        // transfer, the keyboard insets and more; if none is found, the reader has stopped seeing them.
        assertTrue(deferring >= 6, "found only $deferring paragraphs that leave something to a device")
    }

    @Test
    fun `the README's feature table points at the device checklist`() {
        assertTrue(
            notes.lines().any { it == "## Device checklist" },
            "docs/android.md has no `## Device checklist` heading, which the README's #device-checklist link needs"
        )
        val section = section(readme, "## What it does")
        val table = section.indexOf("\n|")
        assertTrue(table >= 0, "android/README.md's \"What it does\" has no table")
        assertTrue(
            section.substring(0, table).contains("../docs/android.md#device-checklist"),
            "android/README.md's feature table must say, before its first row, that no row has been checked on " +
                "a device, and link the device checklist (audit A65):\n$section"
        )
    }

    @Test
    fun `while no release build is signed, the README says the debug APK is debuggable`() {
        val gradle = read(File(InteropHarness.repoRoot, "android/app/build.gradle.kts")).lines().joinToString("\n") { it.substringBefore("//") }
        val release = AppSourcePins.blockAfter(gradle, "release {")
        Assumptions.assumeFalse(
            Regex("""\bsigningConfig\b""").containsMatchIn(release),
            "the release build type is signed now: point the README at the release instead of this warning"
        )
        val security = section(readme, "## Security")
        assertTrue(
            Regex("""debuggable""").containsMatchIn(security) && "run-as" in security,
            "android/README.md's Security section must warn that the debug APK is debuggable, so adb access " +
                "(`run-as`, a debugger) yields the phone's pairing credentials (audit A50):\n$security"
        )
    }

    @Test
    fun `the README's recovery after adb access gives the phone a new identity before it pairs again`() {
        // Review of A50: the first text said "revoke the phone on each computer and pair it again". That
        // gives back what the warning says was taken: the SSH seed and the relay box secret are
        // get-or-create (NodetermApp, PhoneIdentity), nothing in the app removes them (Forget drops a
        // relay token only), and the desktop appends whatever key a pairing sends and re-pins the box
        // key. Only an uninstall or clearing the app's storage makes new ones.
        val protocolMain = File(InteropHarness.repoRoot, "android/protocol/src/main/kotlin")
        val app = (AppSourcePins.appSrc.walkTopDown() + protocolMain.walkTopDown())
            .filter { it.extension == "kt" }
            .joinToString("\n") { it.readText() }
        assertTrue(
            "getOrCreate32(SecureStore.SSH_SEED)" in app,
            "the app no longer gets-or-creates its SSH seed; re-check the README's recovery after adb access"
        )
        Assumptions.assumeFalse(
            Regex("""remove\(\s*(SecureStore\.)?SSH_SEED\b|remove\(\s*(PhoneIdentity\.)?BOX_SECRET\b""").containsMatchIn(app),
            "the app can drop its own identity now: point the README's recovery at that instead of an uninstall"
        )
        val security = section(readme, "## Security")
        // Markdown wraps anywhere, so the phrases are looked for with the line breaks folded away.
        val flat = security.replace(Regex("""\s+"""), " ")
        val revoke = flat.indexOf("Settings → Phone → Revoke")
        assertTrue(revoke >= 0, "android/README.md's Security section no longer tells the user to revoke the phone:\n$security")
        val after = flat.substring(revoke)
        val renew = Regex("""\b[Uu]ninstall\b.*?\bclear its storage\b""").find(after)
        val pair = Regex("""\b[Pp]air\b""").find(after)
        assertTrue(
            renew != null && pair != null && renew.range.first < pair.range.first,
            "android/README.md's recovery after adb access must have the phone uninstall the app or clear its " +
                "storage (a new SSH key, box key and device id) after the revoke and before it pairs again: a " +
                "re-pair alone trusts the same keys again:\n$security"
        )
    }

    @Test
    fun `while the pairing QR defaults to JSON, the camera-app check names the desktop's switch`() {
        // Review of A65: item 7 had the tester scan the desktop's QR with the camera app, "which hands the
        // nodeterm://pair link to the app". The QR is raw JSON unless the user picks the URL form on the
        // desktop, so a tester following it would record a false failure.
        val pairQr = read(File(InteropHarness.repoRoot, "src/shared/pair-qr.ts"))
        val default = Regex("""DEFAULT_PAIR_QR_FORM\s*:\s*PairQrForm\s*=\s*'(\w+)'""").find(pairQr)?.groupValues?.get(1)
            ?: fail("src/shared/pair-qr.ts no longer declares DEFAULT_PAIR_QR_FORM as a literal")
        Assumptions.assumeTrue(default == "json", "the pairing QR is a link by default now: item 7 can drop the switch")
        val phone = read(File(InteropHarness.repoRoot, "src/renderer/components/settings/sections/PhoneSection.tsx"))
        val switch = Regex("""qrForm === 'url'\s*\?\s*'[^']*'\s*:\s*"([^"]+)"""").find(phone)?.groupValues?.get(1)
            ?: fail("PhoneSection.tsx no longer has the JSON → URL QR switch this test reads its label from")
        val items = checklistItems().filter { "nodeterm://pair" in it.second }
        assertTrue(items.isNotEmpty(), "no checklist item checks the `nodeterm://pair` link from the camera app")
        for ((n, text) in items) {
            val flat = text.replace(Regex("""\s+"""), " ")
            assertTrue(
                "\"$switch\"" in flat && "Settings → Phone" in flat,
                "checklist item $n has the camera app open the `nodeterm://pair` link, but the desktop's QR is raw " +
                    "JSON unless \"$switch\" is chosen in its Settings → Phone; the item must say so:\n$text"
            )
        }
    }

    /** (number, text) for each item of docs/android.md's device checklist, continuation lines included. */
    private fun checklistItems(): List<Pair<Int, String>> {
        val items = mutableListOf<Pair<Int, StringBuilder>>()
        var open = false
        for (line in checklistSection().lines()) {
            val start = itemStart.find(line)
            when {
                start != null -> {
                    items += start.groupValues[1].toInt() to StringBuilder(line)
                    open = true
                }
                open && line.isNotBlank() && line.first().isWhitespace() -> items.last().second.append('\n').append(line)
                else -> open = false
            }
        }
        if (items.isEmpty()) fail("docs/android.md's device checklist has no numbered items")
        return items.map { it.first to it.second.toString() }
    }

    private fun checklistSection(): String = section(notes, "## Device checklist")

    /** From the line [heading] to the next `## ` heading (subsections included). */
    private fun section(text: String, heading: String): String {
        val start = text.lines().indexOf(heading)
        if (start < 0) fail("no `$heading` heading")
        val lines = text.lines()
        val end = (start + 1 until lines.size).firstOrNull { lines[it].startsWith("## ") } ?: lines.size
        return lines.subList(start, end).joinToString("\n")
    }

    private fun auditIds(): Set<String> =
        auditHeadingIds(read(File(InteropHarness.repoRoot, "docs/android-audit-2026-09.md")))
            .toSet()
            .also { assertTrue(it.size >= 70, "found only ${it.size} findings in the audit; has its heading format changed?") }

    private fun auditHeadingIds(text: String): List<String> = text.lines()
        .mapNotNull { Regex("""^## (A\d{2,})$""").find(it)?.groupValues?.get(1) }

    private fun findingIds(text: String): Set<String> = Regex("""\bA\d{2,}\b""").findAll(text).map { it.value }.toSet()

    private fun read(file: File) = file.readText().replace("\r\n", "\n")

    private companion object {
        val itemStart = Regex("""^(\d+)\.\s""")

        /** How docs/android.md says that only a phone can settle something. */
        val leftToDevice = Regex("""device check|type-checked|on a device""", RegexOption.IGNORE_CASE)
    }
}
