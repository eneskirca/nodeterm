package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.ResumeOffer
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.Agent
import dev.nodeterm.protocol.model.Launch
import dev.nodeterm.protocol.model.ManagedAccount
import dev.nodeterm.protocol.model.MirrorSettings
import dev.nodeterm.protocol.model.Pane
import dev.nodeterm.protocol.model.ProjectsParser
import dev.nodeterm.protocol.model.ProjectsSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import java.io.File

/**
 * Audit A76 (and A15, and the A41 review): what the terminal screen offers to type after an attach,
 * and what it keeps across a reattach. The screen (TerminalController) is only type-checked; these
 * pin the rule it delegates to.
 */
class ResumeOfferTest {
    private val account = "/Users/me/Library/Application Support/node-terminal/claude-accounts/acct-1"

    /**
     * The `projects.list` blob as the desktop serves it: one project with a managed-account Claude
     * node in a subfolder, and a mirror entry [entry] for that node (the mirror's own JSON).
     */
    private fun snapshot(entry: String?): ProjectsSnapshot = ProjectsParser.parseBlob(
        """{"version":2,"projects":[{"id":"p1","name":"Repo","cwd":"/repo","defaultPermissionMode":"plan",
             "nodes":[{"id":"n1","kind":"terminal","title":"Claude","agentId":"claude","accountId":"acct-1",
                       "cwd":"./sub","agentSessionId":"minted-1"}]}]}
        ${ProjectsParser.PROJECTS_MARK}
        nt-n1
        ${ProjectsParser.STATUS_MARK}
        {"v":1,"updatedAt":1,"nodes":{${entry?.let { "\"n1\":$it" } ?: ""}},
         "settings":{"claudePermissionMode":"acceptEdits","autoSupported":true,
                     "claudeAccounts":[{"id":"acct-1","dir":"$account"}]}}"""
    )

    /** A node Eco put to sleep: the CLI exited (no live state), the flag carries it. */
    private val sleeping = """{"agentId":"claude","sessionId":"sid-7","hibernated":true,"updatedAt":5}"""
    private val awake = """{"state":"done","agentId":"claude","sessionId":"sid-7","updatedAt":5}"""

    @Test
    fun `a cold attach offers the cold-restore resume line (A15)`() {
        // Only the relay creates a session (an SSH attach is never fresh); the rule itself does not
        // look at the transport.
        for (transport in TransportKind.entries) {
            val offer = assertNotNull(ResumeOffer.afterAttach(fresh = true, transport, snapshot(awake), "n1"))
            assertEquals(ResumeOffer.Kind.RESUME, offer.kind)
            assertEquals(
                "cd '/repo/sub' && CLAUDE_CONFIG_DIR='$account' claude --resume sid-7 --permission-mode plan",
                offer.command
            )
            assertEquals(offer.command + "\r", offer.keys, "a pane created just now has no half-typed line to clear")
            assertEquals("Resume", offer.button)
        }
    }

    /** What the pane's foreground command reads while Eco's shell owns it (a login shell). */
    private val shell = "-zsh"

    @Test
    fun `a Sleeping session opened over SSH offers the desktop's wake line (A76)`() {
        assertTrue(ResumeOffer.wantsPane(fresh = false, TransportKind.SSH, snapshot(sleeping), "n1"), "the pane is read first")
        val offer = assertNotNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, snapshot(sleeping), "n1", paneCommand = shell))
        assertEquals(ResumeOffer.Kind.WAKE, offer.kind)
        // No cd and no account prefix, although the node has both: the pane's shell is the one the CLI
        // exited back to, already in the node's folder and under the account's env.
        assertEquals("claude --resume sid-7 --permission-mode plan", offer.command)
        assertEquals("\u0015claude --resume sid-7 --permission-mode plan\r", offer.keys, "the prompt's line is cleared first")
        assertEquals("Wake Claude Code", offer.button)
        assertTrue("sleeping" in offer.message)
    }

    @Test
    fun `a Sleeping session opened through the relay offers nothing, since the desktop wakes it on attach`() {
        // host-service reports the attach (`remoteViewer.attached` → `agent:wake`); an offer as well
        // would type `--resume` into the CLI the desktop just started.
        assertFalse(ResumeOffer.wantsPane(fresh = false, TransportKind.RELAY, snapshot(sleeping), "n1"))
        assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.RELAY, snapshot(sleeping), "n1", paneCommand = shell))
    }

    @Test
    fun `a warm attach of an awake session offers nothing, on either transport`() {
        for (transport in TransportKind.entries) {
            assertFalse(ResumeOffer.wantsPane(fresh = false, transport, snapshot(awake), "n1"), "no pane read for a node that is awake")
            assertNull(ResumeOffer.afterAttach(fresh = false, transport, snapshot(awake), "n1", paneCommand = shell))
            assertNull(ResumeOffer.afterAttach(fresh = false, transport, snapshot(null), "n1", paneCommand = shell))
        }
    }

    @Test
    fun `a cold pane wins over a stale Sleeping flag`() {
        // The shell the CLI exited to went with the old tmux session; the new pane needs the full line.
        val offer = assertNotNull(ResumeOffer.afterAttach(fresh = true, TransportKind.RELAY, snapshot(sleeping), "n1"))
        assertEquals(ResumeOffer.Kind.RESUME, offer.kind)
        assertTrue(offer.command.startsWith("cd '/repo/sub' && "))
    }

    @Test
    fun `a paused node is only ever offered, and a deep pause offers nothing`() {
        // A shallow "Pause session" is an Eco exit plus `paused`, and the mirror carries only the
        // `hibernated` half: the phone sees Sleeping. The desktop never wakes a paused node on its own,
        // but its PAUSED chip is an explicit Resume, and a tapped offer is that same explicit Resume.
        val shallow = assertNotNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, snapshot(sleeping), "n1", paneCommand = shell))
        assertEquals(ResumeOffer.Kind.WAKE, shallow.kind)
        // "Pause & end session" recycles the tmux session and leaves `hibernated` unset: no offer.
        val deep = """{"agentId":"claude","sessionId":"sid-7","updatedAt":5}"""
        assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, snapshot(deep), "n1", paneCommand = shell))
    }

    @Test
    fun `a Sleeping entry with no agent or session of its own falls back to the node's`() {
        // `setNodeHibernated` can create an entry that carries only the flag.
        val bare = """{"hibernated":true,"updatedAt":5}"""
        val offer = assertNotNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, snapshot(bare), "n1", paneCommand = "bash"))
        assertEquals("claude --resume minted-1 --permission-mode plan", offer.command)
    }

    @Test
    fun `no offer for an id that cannot reach a command line, or an agent the phone cannot resume`() {
        val unsafe = """{"agentId":"claude","sessionId":"x; rm -rf ~","hibernated":true,"updatedAt":5}"""
        assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, snapshot(unsafe), "n1", paneCommand = shell))
        val custom = ProjectsParser.parseBlob(
            """{"version":2,"projects":[{"id":"p1","name":"R","nodes":[{"id":"c1","agentId":"custom:abc","agentSessionId":"s"}]}]}
            ${ProjectsParser.STATUS_MARK}
            {"nodes":{"c1":{"hibernated":true,"updatedAt":1}}}"""
        )
        assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, custom, "c1", paneCommand = shell))
    }

    @Test
    fun `a wake is withdrawn at the tap once the node is no longer Sleeping`() {
        val offer = assertNotNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, snapshot(sleeping), "n1", paneCommand = shell))
        assertTrue(offer.stillOffered(snapshot(sleeping), "n1", shell))
        // The desktop resumed it meanwhile, and its first live hook event cleared the flag.
        assertFalse(offer.stillOffered(snapshot(awake), "n1", shell))
        // Or the flag is still set, but a CLI owns the pane now (the desktop woke it and its hook events
        // have not reached the phone yet, or a resume was typed by hand): nothing is typed into it.
        assertFalse(offer.stillOffered(snapshot(sleeping), "n1", "claude"))
        assertFalse(offer.stillOffered(snapshot(sleeping), "n1", null), "a pane that could not be read withdraws it")
        val resume = assertNotNull(ResumeOffer.afterAttach(fresh = true, TransportKind.RELAY, snapshot(awake), "n1"))
        assertTrue(resume.stillOffered(snapshot(awake), "n1"), "a cold pane's resume does not depend on the flag")
    }

    /**
     * The A76 review. The mirror's `hibernated` flag can outlive the sleep: a desktop older than the
     * review dropped its own copy on a resumed CLI's first live hook event without telling the mirror
     * (codex reports its start only that way), and with the desktop app not running nothing hears the
     * resumed CLI at all. So after the phone wakes a codex session, the node still reads Sleeping, and
     * every later open would offer `codex resume` into the running CLI, as a prompt.
     */
    @Test
    fun `a Sleeping flag over a running CLI offers no wake, so a phone-woken codex is not offered again`() {
        val codex = ProjectsParser.parseBlob(
            """{"version":2,"projects":[{"id":"p1","name":"Repo","cwd":"/repo",
                 "nodes":[{"id":"x1","kind":"terminal","agentId":"codex","cwd":"./sub"}]}]}
            ${ProjectsParser.STATUS_MARK}
            {"nodes":{"x1":{"state":"done","agentId":"codex","sessionId":"t-1","hibernated":true,"updatedAt":5}}}"""
        )
        // Eco left a shell in the pane: the wake is offered, and the phone types it.
        val wake = assertNotNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, codex, "x1", paneCommand = "bash"))
        assertEquals("\u0015codex resume t-1\r", wake.keys)
        // Codex is running there now, and nothing has cleared the flag: a reattach (the stream dropped,
        // the app came back) and a new open both find Sleeping in the listing, and a CLI in the pane.
        assertTrue(ResumeOffer.wantsPane(fresh = false, TransportKind.SSH, codex, "x1"))
        for (running in listOf("codex", "node", "/usr/local/bin/codex")) {
            assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, codex, "x1", paneCommand = running), running)
            assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, codex, "x1", carried = wake, paneCommand = running), running)
            assertFalse(wake.stillOffered(codex, "x1", running), running)
        }
        // A pane that could not be read, and a shell the desktop's list does not know, offer nothing
        // either: an unknown owner is never typed into.
        assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, codex, "x1"))
        assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, codex, "x1", paneCommand = "nu"))
        // Once the CLI exits back to its shell, the conversation can be woken again.
        assertEquals(wake, ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, codex, "x1", paneCommand = "-bash"))
    }

    /** The screen is only type-checked: pin that it feeds the pane read into both decisions. */
    @Test
    fun `the terminal screen reads the pane before it offers a wake, and again before it types one`() {
        val controller = AppSourcePins.ui("TerminalController.kt")
        val attach = AppSourcePins.blockAfter(controller, "private suspend fun afterAttach(")
        AppSourcePins.assertInOrder(attach, "ResumeOffer.wantsPane(", "conn.paneCommand(nodeId)", "ResumeOffer.afterAttach(", "paneCommand = pane")
        val tap = AppSourcePins.blockAfter(controller, "fun acceptResume()")
        AppSourcePins.assertInOrder(tap, "ResumeOffer.Kind.WAKE", "conn?.paneCommand(nodeId)", "offer.stillOffered(snap, nodeId, pane)", "writeAfterScrollCancel(offer.keys, s)")
    }

    @Test
    fun `the pane gate is the desktop's shell list`() {
        for (sh in listOf("zsh", "-zsh", "bash", "/bin/sh", "fish", "dash", "ksh", "tcsh")) assertTrue(Pane.isShell(sh), sh)
        for (other in listOf(null, "", "node", "claude", "codex", "sleep", "nu", "pwsh", "zsh/", "-")) assertFalse(Pane.isShell(other), "$other")
        // Pinned against the desktop's own list (src/shared/agents/pane.ts `SHELLS`), so the phone's
        // wake and the desktop's wake cannot disagree about what a Sleeping pane looks like.
        val source = File(InteropHarness.repoRoot, "src/shared/agents/pane.ts").readText()
        val list = assertNotNull(Regex("const SHELLS = new Set\\(\\[([^\\]]*)\\]\\)").find(source), "SHELLS in pane.ts").groupValues[1]
        assertEquals(Regex("'([^']+)'").findAll(list).map { it.groupValues[1] }.toSet(), Pane.SHELLS)
    }

    /**
     * The A41 review: a reattach of the same screen (the stream dropped, the app went to the
     * background) is warm, because the cold attach before it created the session. Re-deriving the
     * offer from `fresh` alone dropped an unanswered resume on every reconnect.
     */
    @Test
    fun `an unanswered resume is kept through a warm reattach of the pane it was made for`() {
        val offered = assertNotNull(ResumeOffer.afterAttach(fresh = true, TransportKind.RELAY, snapshot(awake), "n1"))
        for (transport in TransportKind.entries) {
            assertEquals(offered, ResumeOffer.afterAttach(fresh = false, transport, snapshot(awake), "n1", carried = offered))
        }
        // Nothing carried (answered, dismissed, or never offered): a warm attach still offers nothing.
        assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.RELAY, snapshot(awake), "n1", carried = null))
    }

    @Test
    fun `a carried resume still wins over a stale Sleeping flag`() {
        // The pane is the cold one the first attach created, not the shell a CLI exited back to, so
        // the wake line (no cd, no account) would still be the wrong one there.
        val offered = assertNotNull(ResumeOffer.afterAttach(fresh = true, TransportKind.RELAY, snapshot(sleeping), "n1"))
        val kept = assertNotNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, snapshot(sleeping), "n1", carried = offered, paneCommand = shell))
        assertEquals(ResumeOffer.Kind.RESUME, kept.kind)
        assertEquals(offered, kept)
    }

    @Test
    fun `a carried resume is dropped once the computer describes something else`() {
        val offered = assertNotNull(ResumeOffer.afterAttach(fresh = true, TransportKind.RELAY, snapshot(awake), "n1"))
        // A hook event from the node since the offer: a CLI ran in that pane while the phone was away
        // (say, resumed on the computer), and the resume line would reach it as a prompt.
        val heard = """{"state":"done","agentId":"claude","sessionId":"sid-7","updatedAt":9}"""
        assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.RELAY, snapshot(heard), "n1", carried = offered))
        // Another conversation.
        val other = """{"state":"done","agentId":"claude","sessionId":"sid-8","updatedAt":5}"""
        assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.RELAY, snapshot(other), "n1", carried = offered))
        // The node is gone from the canvas and the mirror.
        val gone = ProjectsParser.parseBlob("""{"version":2,"projects":[{"id":"p1","name":"Repo","cwd":"/repo","nodes":[]}]}""")
        assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.RELAY, gone, "n1", carried = offered))
    }

    @Test
    fun `a fresh reattach is a new cold pane and gets the line built now`() {
        val offered = assertNotNull(ResumeOffer.afterAttach(fresh = true, TransportKind.RELAY, snapshot(awake), "n1"))
        val other = """{"state":"done","agentId":"claude","sessionId":"sid-8","updatedAt":9}"""
        val rebuilt = assertNotNull(ResumeOffer.afterAttach(fresh = true, TransportKind.RELAY, snapshot(other), "n1", carried = offered))
        assertEquals(ResumeOffer.Kind.RESUME, rebuilt.kind)
        assertTrue(rebuilt.command.contains("--resume sid-8"), rebuilt.command)
    }

    @Test
    fun `a wake is not carried, since each attach re-derives it`() {
        val wake = assertNotNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, snapshot(sleeping), "n1", paneCommand = shell))
        assertEquals(wake, ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, snapshot(sleeping), "n1", carried = wake, paneCommand = shell))
        // Woken on the computer meanwhile, or reopened through the relay (whose attach wakes it).
        assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.SSH, snapshot(awake), "n1", carried = wake, paneCommand = shell))
        assertNull(ResumeOffer.afterAttach(fresh = false, TransportKind.RELAY, snapshot(sleeping), "n1", carried = wake, paneCommand = shell))
    }

    @Test
    fun `the wake line is the resume with the permission mode and nothing else`() {
        val s = MirrorSettings("auto", autoSupported = false, claudeAccounts = listOf(ManagedAccount("a1", account)), codexApprovalValues = emptyList())
        assertEquals("claude --resume abc", Launch.wakeLine(Agent.CLAUDE, "abc", s), "auto on an old claude degrades to no flag")
        assertEquals("claude --resume abc --permission-mode auto", Launch.wakeLine(Agent.CLAUDE, "abc", s.copy(autoSupported = true)))
        assertEquals("claude --resume abc --permission-mode plan", Launch.wakeLine(Agent.CLAUDE, "abc", s, "plan"))
        // Unsupported modes stay at the CLI's default; supported modes use its own dialect.
        assertEquals("codex resume abc", Launch.wakeLine(Agent.CODEX, "abc", s, "plan"), "Codex cannot express plan")
        assertEquals("gemini --resume abc --approval-mode plan", Launch.wakeLine(Agent.GEMINI, "abc", s, "plan"))
        assertNull(Launch.wakeLine(Agent.CLAUDE, "-flag", s))
    }
}
