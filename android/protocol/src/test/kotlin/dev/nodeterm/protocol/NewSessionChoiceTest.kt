package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.ManagedAccount
import dev.nodeterm.protocol.model.MirrorSettings
import dev.nodeterm.protocol.model.NewSessionChoice
import dev.nodeterm.protocol.model.ProjectInfo
import dev.nodeterm.protocol.model.ProjectsSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A42: the New-session dialog remembered the user's taps while the host listing was re-fetched under
 * it (every 8 s). Start looked the remembered project up with `first {}`, so a project closed or
 * removed on the desktop meanwhile threw NoSuchElementException inside the click handler; and a
 * removed account was still sent to the desktop under a picker showing no row selected.
 *
 * The selection rules are pure and tested here against listings that change between taps. The
 * dialog's wiring (it draws and starts with the same derived answer, and never looks a pick up with
 * `first {}`) cannot run on a JVM, so it is pinned in the app's source ([AppSourcePins]); nothing
 * here has run on a device.
 */
class NewSessionChoiceTest {
    private fun project(id: String, cwd: String? = "/w/$id", ssh: String? = null, closed: Boolean = false, defaultAccount: String? = null) =
        ProjectInfo(id, id.uppercase(), null, cwd, ssh, closed, emptyList(), null, defaultAccountId = defaultAccount)

    private fun listing(vararg projects: ProjectInfo) = ProjectsSnapshot(projects.toList(), emptySet(), null, 0)

    private fun settings(vararg accountIds: String) = MirrorSettings(
        "manual",
        false,
        accountIds.map { ManagedAccount(it, "/Users/me/Library/Application Support/nodeterm/claude-accounts/$it") },
        emptyList()
    )

    @Test
    fun `only open projects on this computer with a folder are offered (A14)`() {
        val offered = NewSessionChoice.offeredProjects(
            listing(
                project("a"),
                project("closed", closed = true),
                project("remote", ssh = "me@box"),
                project("inline", cwd = null),
                // A27: run here over SSH by another desktop, whose canvas this computer cannot register in.
                project("driven").copy(drivenRemotely = true),
                project("b")
            )
        )
        assertEquals(listOf("a", "b"), offered.map { it.id })
    }

    @Test
    fun `the picked project is used while it is still offered`() {
        val offered = NewSessionChoice.offeredProjects(listing(project("a"), project("b")))
        assertEquals("b", NewSessionChoice.project(offered, "b")?.id)
        assertEquals("a", NewSessionChoice.project(offered, "a")?.id)
        assertEquals("a", NewSessionChoice.project(offered, null)?.id, "no pick yet: the first project, as preselected")
    }

    @Test
    fun `a picked project that disappears from the listing falls back to one that is shown, instead of crashing Start`() {
        // The user picks B; the next re-list no longer has it (closed on the desktop).
        val picked = "b"
        val relisted = NewSessionChoice.offeredProjects(listing(project("a"), project("b", closed = true), project("c")))
        val selected = NewSessionChoice.project(relisted, picked)
        // Start and the radio use this one answer: a project that is on screen, never the hidden B.
        assertEquals("a", selected?.id)
        assertTrue(selected in relisted)
        // Removed outright, or turned into an SSH or cwd-less project: the same.
        assertEquals("a", NewSessionChoice.project(NewSessionChoice.offeredProjects(listing(project("a"))), picked)?.id)
        assertEquals("a", NewSessionChoice.project(NewSessionChoice.offeredProjects(listing(project("a"), project("b", cwd = null))), picked)?.id)
        // It comes back: the user's pick is honoured again.
        assertEquals("b", NewSessionChoice.project(NewSessionChoice.offeredProjects(listing(project("a"), project("b"))), picked)?.id)
    }

    @Test
    fun `with no project left to start in there is no selection, so Start is off`() {
        assertNull(NewSessionChoice.project(emptyList(), "b"))
        assertNull(NewSessionChoice.project(emptyList(), null))
        assertNull(NewSessionChoice.project(NewSessionChoice.offeredProjects(listing(project("b", closed = true))), "b"))
    }

    @Test
    fun `the picked account is used while the host still has it, and System is always there`() {
        val p = project("a", defaultAccount = "acct-1")
        val s = settings("acct-1", "acct-2")
        assertEquals("acct-2", NewSessionChoice.account(s, p, "acct-2"))
        assertEquals("acct-1", NewSessionChoice.account(s, p, "acct-1"))
        assertNull(NewSessionChoice.account(s, p, null), "System was picked")
    }

    @Test
    fun `a picked account the desktop removed falls back to the project's default, then to System`() {
        val p = project("a", defaultAccount = "acct-1")
        // acct-2 was picked, then removed on the desktop: the project default still exists.
        assertEquals("acct-1", NewSessionChoice.account(settings("acct-1"), p, "acct-2"))
        // Both gone (or every account gone, when the picker is not even drawn): System, never a stale id.
        assertNull(NewSessionChoice.account(settings("acct-3"), p, "acct-2"))
        assertNull(NewSessionChoice.account(settings(), p, "acct-1"))
        assertNull(NewSessionChoice.account(null, p, "acct-1"))
        // No project selected at all: nothing to take a default from.
        assertNull(NewSessionChoice.account(settings("acct-1"), null, "gone"))
    }

    private val dialog get() = AppSourcePins.blockAfter(AppSourcePins.ui("SessionsTab.kt"), "fun NewSessionDialog(")

    @Test
    fun `the dialog draws and starts with the selection derived from the current listing`() {
        val src = dialog
        assertTrue(src.contains("val projects = NewSessionChoice.offeredProjects(snapshot)"), "the dialog filters projects on its own")
        assertTrue(src.contains("val selected = NewSessionChoice.project(projects, projectId)"), "the selection is not derived from the listing")
        // No lookup that can throw on a vanished pick.
        assertFalse(src.contains(".first {"), "a remembered pick is looked up with first {}")
        assertFalse(src.contains("!!"), "a remembered pick is asserted non-null")
        // The radio shown as selected is the one Start uses.
        assertTrue(src.contains("RadioButton(selected = selected?.id == p.id, onClick = { projectId = p.id })"), "the project radio is not drawn from the selection")
        AppSourcePins.assertInOrder(
            src,
            "TextButton(enabled = selected != null",
            "val p = selected ?: return@start",
            "projectId = p.id"
        )
        assertTrue(src.contains("if (projects.isEmpty())"), "an empty project list is not explained")
    }

    @Test
    fun `the account picker draws and starts with the same derived account`() {
        val src = dialog
        assertTrue(src.contains("remember(selected?.id)"), "the account pick does not follow the selected project")
        assertTrue(src.contains("val accountId = NewSessionChoice.account(settings, selected, accountPick)"), "the account is not derived from the listing")
        assertTrue(src.contains("RadioButton(selected = accountId == id, onClick = { accountPick = id })"), "the account radio is not drawn from the derived account")
        // A `val`, so no tap can overwrite it with an id the listing no longer has.
        assertTrue(src.contains("val acct = if (a == Agent.CLAUDE) accountId else null"), "Start does not use the derived account")
    }

    @Test
    fun `the New session button is offered by the same rule as the dialog's list`() {
        val host = AppSourcePins.ui("HostScreen.kt")
        assertTrue(host.contains("NewSessionChoice.offeredProjects(snapshot).isNotEmpty()"), "HostScreen keeps its own copy of the project rule")
    }
}
