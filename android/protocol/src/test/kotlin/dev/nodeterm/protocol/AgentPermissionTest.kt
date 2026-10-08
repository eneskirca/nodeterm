package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.Agent
import dev.nodeterm.protocol.model.Launch
import dev.nodeterm.protocol.model.MirrorSettings
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class AgentPermissionTest {
    private fun settings(mode: String, values: List<String> = emptyList(), auto: Boolean = false) =
        MirrorSettings(mode, auto, emptyList(), values)

    @Test
    fun `one assembler applies each measured approval policy to launch cold resume and wake`() {
        val modes = listOf("manual", "auto", "acceptEdits", "plan", "bypassPermissions")
        val suffixes = mapOf(
            Agent.CLAUDE to listOf("", "", " --permission-mode acceptEdits", " --permission-mode plan", " --permission-mode bypassPermissions"),
            Agent.CODEX to listOf(" --ask-for-approval untrusted", " --ask-for-approval on-request", "", "", " --ask-for-approval never"),
            Agent.GEMINI to listOf("", "", " --approval-mode auto_edit", " --approval-mode plan", " --approval-mode yolo"),
            Agent.GROK to listOf("", " --permission-mode auto", " --permission-mode acceptEdits", " --permission-mode plan", " --permission-mode bypassPermissions"),
            Agent.OPENCODE to List(5) { "" }, Agent.COPILOT to List(5) { "" },
            Agent.ANTIGRAVITY to List(5) { "" }
        )
        for (agent in Agent.entries) for ((index, mode) in modes.withIndex()) {
            val s = settings(mode, listOf("untrusted", "on-request", "never"))
            val suffix = suffixes.getValue(agent)[index]
            assertEquals(agent.launchCmd + suffix, Launch.launchCommand(agent, s, null, null), "$agent $mode launch")
            val resume = Launch.resumeCommand(agent, "sid-1")!!
            assertEquals("cd '/repo' && $resume$suffix", Launch.resumeLine(agent, "sid-1", s, null, "/repo"), "$agent $mode cold")
            assertEquals(resume + suffix, Launch.wakeLine(agent, "sid-1", s), "$agent $mode wake")
        }
    }

    @Test
    fun `Codex manual depends on own host vocabulary and unknown host uses stable desktop baseline`() {
        for (values in listOf(emptyList(), listOf("on-request", "never"))) {
            assertEquals("codex", Launch.launchCommand(Agent.CODEX, settings("manual", values), null, null))
            assertEquals("codex --ask-for-approval on-request", Launch.launchCommand(Agent.CODEX, settings("auto", values), null, null))
            assertEquals("codex resume s --ask-for-approval never", Launch.wakeLine(Agent.CODEX, "s", settings("bypassPermissions", values)))
        }
        assertEquals("codex", Launch.launchCommand(Agent.CODEX, settings("auto", listOf("never")), null, null))
        assertEquals("codex --ask-for-approval untrusted", Launch.launchCommand(Agent.CODEX, settings("manual", listOf("untrusted")), null, null))
        assertEquals("codex", Launch.launchCommand(Agent.CODEX, settings("manual", listOf("untrusted; echo injected")), null, null))
    }

    @Test
    fun `host Claude gate does not downgrade Grok and project override wins for all agents`() {
        val s = settings("auto", auto = false)
        assertEquals("claude", Launch.launchCommand(Agent.CLAUDE, s, null, null))
        assertEquals("claude --permission-mode auto", Launch.launchCommand(Agent.CLAUDE, s.copy(autoSupported = true), null, null))
        assertEquals("grok --permission-mode auto", Launch.launchCommand(Agent.GROK, s, null, null))
        assertEquals("gemini --approval-mode plan", Launch.launchCommand(Agent.GEMINI, s, null, null, "plan"))
        assertEquals("codex", Launch.launchCommand(Agent.CODEX, s, null, null, "manual"))
        assertEquals("gemini", Launch.launchCommand(Agent.GEMINI, s, null, null, "constructor"))
    }
}
