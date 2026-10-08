package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.TmuxNames
import dev.nodeterm.protocol.ssh.HostBrowse
import dev.nodeterm.protocol.ssh.PhoneTerminals
import dev.nodeterm.protocol.ssh.SshScripts
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhoneTerminalsTest {
    private val id = "phone-12345678-1234-1234-1234-123456789abc"
    private val folder = "/srv/it's a \$(touch injection) folder"
    private val fingerprint = PhoneTerminals.fingerprint(id, folder)
    private fun record(session: String = TmuxNames.sessionName(id), node: String = id,
                       creation: String = fingerprint, cwd: String = folder, marker: String = fingerprint) =
        listOf(session, node, creation, cwd, marker, folder).joinToString("\t")

    @Test
    fun `phone ids are reserved canonical UUIDs, and folders are shell tokens not commands`() {
        assertTrue(PhoneTerminals.validId(id))
        for (invalid in listOf("term-existing", "phone-short", id.uppercase(), "$id-extra", "$id\n", "phone-../bad")) {
            assertFalse(PhoneTerminals.validId(invalid), invalid)
            assertFailsWith<IllegalArgumentException> { SshScripts.createTerminal(invalid, folder) }
        }
        assertTrue(PhoneTerminals.validCwd(folder))
        for (invalid in listOf("relative", "~/repo", "/bad\nfolder", "/bad\t", "/bad\u0000", "/bad\u007f", "/bad\u0085", "/" + "x".repeat(4096))) {
            assertFailsWith<IllegalArgumentException> { SshScripts.createTerminal(id, invalid) }
        }
        assertNotEquals(fingerprint, PhoneTerminals.fingerprint(id, "/elsewhere"))
        assertNotEquals(PhoneTerminals.fingerprint(id, null), PhoneTerminals.fingerprint(id, "/home"))
        assertEquals(fingerprint, PhoneTerminals.fingerprint(id, folder))
    }

    @Test
    fun `only complete matching owned metadata is a phone terminal`() {
        assertEquals(PhoneTerminals.Entry(id, folder, fingerprint), PhoneTerminals.parse(record()))
        for (bad in listOf(record(session = "nt-other"), record(node = "term-other"), record(creation = ""),
                           record(marker = "a".repeat(64)), record(cwd = "relative"), record(cwd = "/bad\tpath"),
                           record(creation = "a".repeat(64), marker = "a".repeat(64)),
                           record(cwd = "/bad\npath"), record() + "\textra")) {
            assertNull(PhoneTerminals.parse(bad), bad)
        }
    }

    @Test
    fun `home creation has a distinct valid atomic tuple`() {
        val fp = PhoneTerminals.fingerprint(id, null)
        val line = listOf(TmuxNames.sessionName(id), id, fp, "/home/test", fp, "HOME").joinToString("\t")
        assertEquals(PhoneTerminals.Entry(id, "/home/test", fp), PhoneTerminals.parse(line))
    }

    @Test
    fun `phone-only browse is usable without a desktop and preserves cwd across listings`() {
        val raw = "${SshScripts.META_START}\nud=\n${SshScripts.META_END}\n" +
            "${SshScripts.PHONE_MARK}\n${record()}\n${record()}\n${record(marker = "")}\n${SshScripts.END_MARK}\n"
        val out = HostBrowse.split(raw)
        assertFalse(out.nothingFound(1))
        val snapshot = HostBrowse.assemble(ProjectsSnapshot.EMPTY, out, 1)
        val project = snapshot.projects.single()
        assertEquals(PhoneTerminals.PROJECT_ID, project.id)
        assertEquals(PhoneTerminals.PROJECT_NAME, project.name)
        assertNull(project.cwd, "this is not a desktop-owned project to register nodes in")
        assertEquals(id, project.nodes.single().id)
        assertEquals(folder, project.nodes.single().cwd)
        assertNull(project.nodes.single().agentId)
        assertTrue(snapshot.isLive(id))
        assertEquals(TmuxNames.PHONE_SOCKET, snapshot.socketOf(id))
        assertNull(snapshot.statusOf(id), "a plain shell invents no managed agent status")
    }
}
