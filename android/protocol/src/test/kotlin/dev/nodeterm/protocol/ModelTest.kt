package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.AccountNames
import dev.nodeterm.protocol.model.Agent
import dev.nodeterm.protocol.model.Launch
import dev.nodeterm.protocol.model.ManagedAccount
import dev.nodeterm.protocol.model.MirrorSettings
import dev.nodeterm.protocol.model.MirrorUsage
import dev.nodeterm.protocol.model.NodeInfo
import dev.nodeterm.protocol.model.NodeKind
import dev.nodeterm.protocol.model.ObservedAccount
import dev.nodeterm.protocol.model.ProjectInfo
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.ProjectsParser
import dev.nodeterm.protocol.model.SessionBucket
import dev.nodeterm.protocol.model.TmuxNames
import dev.nodeterm.protocol.model.UsageAccount
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.relay.Framing
import dev.nodeterm.protocol.relay.Op
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ModelTest {
    @Test
    fun `a hostile or broken blob degrades section by section, never throws`() {
        val snap = ProjectsParser.parseBlob("not json\n--NT-PROJECTS-SPLIT--\nnt-a\njunk\n--NT-STATUS-SPLIT--\n{\"nodes\":{\"a\":{\"state\":42,\"hibernated\":true}}}")
        assertTrue(snap.projects.isEmpty())
        assertEquals(setOf("nt-a"), snap.liveSessions)
        val st = snap.statusOf("a")!!
        assertNull(st.state, "a wrong-typed state is absent, not a crash")
        assertEquals(SessionBucket.SLEEPING, st.bucket)
        assertTrue(ProjectsParser.parseBlob("").projects.isEmpty())
    }

    @Test
    fun `nodes default to terminal and the legacy claude tag still means claude`() {
        val snap = ProjectsParser.parseBlob("""{"version":2,"projects":[{"id":"p","name":"P","nodes":[{"id":"n1","title":"t","tags":["claude"]},{"id":"n2","kind":"group"}],"kanban":{"columns":"garbage"}}]}""")
        val p = snap.projects.single()
        assertEquals(listOf("n1"), p.sessions.map { it.id })
        assertEquals("claude", p.sessions.single().agentId)
        assertNotNull(p.board, "columns present but malformed → an empty board, read tolerantly")
    }

    @Test
    fun `tmux names match tmux-naming ts`() {
        assertEquals("nt-term-abc-1", TmuxNames.sessionName("term-abc-1"))
        assertEquals("nt-a_b_c", TmuxNames.sessionName("a/b c"))
        assertTrue(TmuxNames.isSessionName("nt-a_b"))
    }

    @Test
    fun `frames round trip with the stable header`() {
        val f = Framing.decode(Framing.encode(Op.INPUT, 7, 0x1_0000_0002L, "hi".toByteArray()))!!
        assertEquals(Op.INPUT, f.op)
        assertEquals(7, f.streamId)
        assertEquals(0x1_0000_0002L, f.seq)
        assertEquals("hi", String(f.payload))
        assertNull(Framing.decode(ByteArray(15)))
        assertNull(Framing.decode(Framing.encode(99, 1, 0, ByteArray(0))), "unknown opcode")
        assertEquals(120 to 40, Framing.readSize(Framing.sizePayload(120, 40)))
    }

    @Test
    fun `pairing payloads parse like pairing-core builds them, and refuse plaintext relays`() {
        val p = PairingPayload.parse("""{"v":1,"host":"192.168.1.5","port":22,"user":"me","token":"t","pairPort":5555,"nodeterm":true,"name":"Mac","hostKey":"${"A".repeat(43)}=","relay":{"hostId":"h","hostPublicKeyB64":"${"A".repeat(43)}=","relayEndpoint":"ws://evil.example"},"ssh":false}""")!!
        assertEquals("Mac", p.name)
        assertEquals(false, p.sshAvailable)
        assertNull(p.relay, "ws:// to a non-loopback host is refused (pairing.ts R5)")
        assertNull(PairingPayload.parse("""{"v":2,"host":"x"}"""))
        assertNull(PairingPayload.parse("nodeterm://pair?code=abc"), "not a payload")
    }

    @Test
    fun `the URL and bare-code envelopes of pair-qr ts decode to the same payload`() {
        val json = """{"v":1,"host":"10.0.0.2","user":"u","token":"t","pairPort":1,"nodeterm":true,"name":"Box é"}"""
        val code = dev.nodeterm.protocol.crypto.B64.encodeUrl(json.toByteArray())
        val viaUrl = assertNotNull(PairingPayload.parse("nodeterm://pair?code=$code"))
        assertEquals("Box é", viaUrl.name)
        assertEquals(viaUrl, PairingPayload.parse(code))
        assertEquals(viaUrl, PairingPayload.parse(json))
        // A desktop-peer relay offer uses the same envelope with a different payload: refused.
        val offer = dev.nodeterm.protocol.crypto.B64.encodeUrl("""{"relayEndpoint":"wss://r","pairingToken":"x","hostPublicKeyB64":"y"}""".toByteArray())
        assertNull(PairingPayload.parse("nodeterm://pair?code=$offer"))
        assertNull(PairingPayload.parse("https://pair?code=$code"))
    }

    @Test
    fun `paired host survives a JSON round trip`() {
        val p = PairingPayload.parse("""{"v":1,"host":"10.0.0.2","user":"u","token":"t","pairPort":1,"nodeterm":true,"name":"Box"}""")!!
        val h = PairedHost.from(p, dev.nodeterm.protocol.pairing.PairingResult("dev-1", "tok", null, null), now = 5)
        assertEquals(h, PairedHost.fromJson(h.toJson()))
    }

    @Test
    fun `resume commands follow each agent's grammar and refuse unsafe ids`() {
        assertEquals("claude --resume abc-1", Launch.resumeCommand(Agent.CLAUDE, "abc-1"))
        assertEquals("codex resume abc", Launch.resumeCommand(Agent.CODEX, "abc"))
        assertEquals("copilot --resume=abc", Launch.resumeCommand(Agent.COPILOT, "abc"))
        assertEquals("opencode --session abc", Launch.resumeCommand(Agent.OPENCODE, "abc"))
        assertEquals(Agent.ANTIGRAVITY, Agent.of("antigravity"))
        assertEquals("Antigravity", Agent.ANTIGRAVITY.label)
        assertEquals("#00a3a3", Agent.ANTIGRAVITY.color)
        assertEquals("agy --conversation=abc", Launch.resumeCommand(Agent.ANTIGRAVITY, "abc"))
        assertNull(Launch.resumeCommand(Agent.ANTIGRAVITY, "abc; echo unsafe"))
        assertNull(Launch.resumeCommand(Agent.CLAUDE, "abc; rm -rf ~"))
        assertNull(Launch.resumeCommand(Agent.CLAUDE, "-flag"))
    }

    @Test
    fun `launch emits claude's permission mode only as the desktop would`() {
        val s = MirrorSettings("auto", autoSupported = false, claudeAccounts = listOf(ManagedAccount("a1", "/Users/me/Library/Application Support/nodeterm/claude-accounts/a1")), codexApprovalValues = emptyList())
        assertEquals("claude", Launch.launchCommand(Agent.CLAUDE, s, null, null), "auto on an old claude degrades to the bare command")
        assertEquals("claude --permission-mode auto", Launch.launchCommand(Agent.CLAUDE, s.copy(autoSupported = true), null, null))
        assertEquals("claude", Launch.launchCommand(Agent.CLAUDE, s.copy(claudePermissionMode = "constructor"), null, null))
        assertEquals(
            "cd '/w/p' && CLAUDE_CONFIG_DIR='/Users/me/Library/Application Support/nodeterm/claude-accounts/a1' claude --permission-mode plan",
            Launch.launchCommand(Agent.CLAUDE, s.copy(claudePermissionMode = "plan"), "a1", "/w/p")
        )
        assertEquals("codex", Launch.launchCommand(Agent.CODEX, s.copy(claudePermissionMode = "plan"), "a1", null))
        assertEquals("gemini", Launch.launchCommand(Agent.GEMINI, s, null, "/it's/unsafe"), "a quote-bearing cwd is dropped, not escaped")
        assertTrue(Regex("^term-[a-z0-9]+-[a-z0-9]{1,16}$").matches(Launch.newNodeId()))
    }

    private val acctSettings = MirrorSettings("acceptEdits", true, listOf(ManagedAccount("acct-1", "/Users/me/Library/Application Support/node-terminal/claude-accounts/acct-1")), emptyList())

    @Test
    fun `the project's own permission mode wins over the global one, both re-validated (A16)`() {
        assertEquals("plan", Launch.permissionMode(acctSettings, "plan"))
        assertEquals("acceptEdits", Launch.permissionMode(acctSettings, null))
        assertEquals("acceptEdits", Launch.permissionMode(acctSettings, "constructor"), "an unknown project value falls through")
        assertEquals("manual", Launch.permissionMode(null, null))
        assertEquals("claude --permission-mode plan", Launch.launchCommand(Agent.CLAUDE, acctSettings, null, null, "plan"))
        // manual in the project = the bare command, even when the global is looser.
        assertEquals("claude", Launch.launchCommand(Agent.CLAUDE, acctSettings, null, null, "manual"))
        assertEquals("codex", Launch.launchCommand(Agent.CODEX, acctSettings, null, null, "plan"), "Codex cannot express plan")
    }

    @Test
    fun `the project's default account is preselected only while the host still has it (A16)`() {
        val p = ProjectInfo("p", "P", null, "/repo", null, false, emptyList(), null, defaultAccountId = "acct-1")
        assertEquals("acct-1", Launch.defaultAccount(acctSettings, p))
        assertNull(Launch.defaultAccount(acctSettings, p.copy(defaultAccountId = "gone")))
        assertNull(Launch.defaultAccount(null, p))
    }

    @Test
    fun `the resume line runs where the desktop's cold restore would (A15)`() {
        assertEquals(
            "cd '/repo/sub' && CLAUDE_CONFIG_DIR='/Users/me/Library/Application Support/node-terminal/claude-accounts/acct-1' " +
                "claude --resume abc-1 --permission-mode plan",
            Launch.resumeLine(Agent.CLAUDE, "abc-1", acctSettings, "acct-1", "/repo/sub", "plan")
        )
        assertEquals("cd '/repo' && codex resume abc", Launch.resumeLine(Agent.CODEX, "abc", acctSettings, "acct-1", "/repo"))
        assertNull(Launch.resumeLine(Agent.CLAUDE, "abc; rm -rf ~", acctSettings, null, "/repo"))
    }

    @Test
    fun `portable node cwds resolve against the project folder`() {
        val p = ProjectInfo("p", "P", null, "/repo/", null, false, emptyList(), null)
        fun n(cwd: String?) = NodeInfo("n", NodeKind.TERMINAL, "t", null, null, null, cwd, null, null, null, null)
        assertEquals("/repo/sub", p.absoluteCwdOf(n("./sub")))
        assertEquals("/repo", p.absoluteCwdOf(n(".")))
        assertEquals("/abs", p.absoluteCwdOf(n("/abs")))
        assertEquals("/repo/", p.absoluteCwdOf(n(null)))
        assertNull(p.copy(cwd = null).absoluteCwdOf(n("./sub")))
    }

    // ---- account names (A39, A75) -------------------------------------------------------------

    private val uuid = "3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f"
    private val linked = "7d1e0b2a-9f8c-4d3e-8a1b-0c9d8e7f6a5b"

    /** A mirror as a current desktop writes it: settings entries built by `mirrorClaudeAccount`
     *  (label + email), a usage block, and nodes observed on each kind of account. */
    private val accountsBlob = """
        --NT-STATUS-SPLIT--
        {"v":1,"updatedAt":1,"nodes":{
          "managed":{"agentId":"claude","updatedAt":1,"account":{"configDir":"/data/claude-accounts/$uuid","accountId":"$uuid","known":true}},
          "linked":{"agentId":"claude","updatedAt":1,"account":{"configDir":"/home/me/.claude-2","accountId":"$linked","known":true}},
          "unlinked":{"agentId":"claude","updatedAt":1,"account":{"configDir":"/home/me/.claude-work/","accountId":null,"known":false}},
          "system":{"agentId":"claude","updatedAt":1,"account":{"configDir":"/home/me/.claude","accountId":null,"known":true}},
          "none":{"agentId":"claude","updatedAt":1}
        },
        "settings":{"claudeAccounts":[
          {"id":"$uuid","dir":"/data/claude-accounts/$uuid","label":"Work","email":"me@work.example"},
          {"id":"$linked","dir":"/home/me/.claude-2","email":"side@example.com"}
        ]},
        "usage":{"updatedAt":1,"accounts":[{"accountId":null,"label":null,"email":"me@home.example","agentId":"claude","status":"ok","updatedAt":1,"limits":[]}]}}
    """.trimIndent()

    @Test
    fun `the mirror's account label, email and observed account are parsed`() {
        val status = ProjectsParser.parseBlob(accountsBlob).status!!
        assertEquals(ManagedAccount(uuid, "/data/claude-accounts/$uuid", "Work", "me@work.example"), status.settings!!.claudeAccounts[0])
        assertEquals(ManagedAccount(linked, "/home/me/.claude-2", null, "side@example.com"), status.settings!!.claudeAccounts[1])
        assertEquals(ObservedAccount("/data/claude-accounts/$uuid", uuid, true), status.nodes["managed"]!!.account)
        assertEquals(ObservedAccount("/home/me/.claude-work/", null, false), status.nodes["unlinked"]!!.account)
        assertNull(status.nodes["none"]!!.account)
        // A desktop older than the label keeps parsing: the entry is still a launchable account.
        val old = ProjectsParser.parseStatus("""{"settings":{"claudeAccounts":[{"id":"a","dir":"/d","label":7}]}}""")!!
        assertEquals(ManagedAccount("a", "/d"), old.settings!!.claudeAccounts.single())
    }

    @Test
    fun `a session row names the account it was observed on, never by its UUID (A39)`() {
        val status = ProjectsParser.parseBlob(accountsBlob).status!!
        fun row(node: String) = AccountNames.observed(status.nodes[node]!!.account, status)
        assertEquals("Work", row("managed"))
        assertEquals("side@example.com", row("linked"), "no label: the email")
        assertEquals(".claude-work", row("unlinked"), "a dir with no record: its last segment")
        assertNull(row("system"), "the system account is the unremarkable case")
        assertNull(row("none"))
        // An id this mirror cannot name: a linked account's dir says more than its id; a managed
        // account's dir is only its id again, so the short form.
        val bare = status.copy(settings = null)
        assertEquals(".claude-2", AccountNames.observed(bare.nodes["linked"]!!.account, bare))
        assertEquals("Account 3f2a9c1e", AccountNames.observed(bare.nodes["managed"]!!.account, bare))
        for (n in status.nodes.keys) assertTrue(AccountNames.observed(status.nodes[n]!!.account, bare)?.contains(uuid) != true, n)
    }

    @Test
    fun `the new session picker names accounts label, then usage label, then email, then a short id (A75)`() {
        val status = ProjectsParser.parseBlob(accountsBlob).status!!
        assertEquals("Work", AccountNames.managed(uuid, status))
        assertEquals("side@example.com", AccountNames.managed(linked, status))
        // A desktop older than the settings label: the usage block's label still names it.
        val usageOnly = status.copy(
            settings = MirrorSettings(null, null, listOf(ManagedAccount(uuid, "/d")), emptyList()),
            usage = MirrorUsage(1, listOf(UsageAccount(uuid, "From usage", "u@example.com", "claude", "ok", 1, emptyList())))
        )
        assertEquals("From usage", AccountNames.managed(uuid, usageOnly))
        assertEquals(
            "u@example.com",
            AccountNames.managed(uuid, usageOnly.copy(usage = MirrorUsage(1, listOf(UsageAccount(uuid, "  ", "u@example.com", "claude", "ok", 1, emptyList()))))),
            "a blank label is absent"
        )
        assertEquals("Account 3f2a9c1e", AccountNames.managed(uuid, null))
        assertEquals("Account acct-1", AccountNames.managed("acct-1", null), "a short id is shown whole")
    }

    @Test
    fun `a config dir is named by the separator its shape implies`() {
        assertEquals(".claude-2", AccountNames.configDirLabel("/home/me/.claude-2/"))
        assertEquals("a\\b", AccountNames.configDirLabel("/home/me/a\\b"), "a POSIX backslash is filename text")
        assertEquals(".claude-2", AccountNames.configDirLabel("C:\\Users\\me\\.claude-2"))
        assertEquals(".claude-2", AccountNames.configDirLabel("C:/Users/me/.claude-2"))
        assertEquals("/", AccountNames.configDirLabel("/"))
        assertEquals("", AccountNames.configDirLabel("  "))
    }
}
