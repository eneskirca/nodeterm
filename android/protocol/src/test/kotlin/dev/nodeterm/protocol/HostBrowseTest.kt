package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.MirrorServer
import dev.nodeterm.protocol.model.ProjectsParser
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.TmuxNames
import dev.nodeterm.protocol.ssh.HostBrowse
import dev.nodeterm.protocol.ssh.SshScripts
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Audit A27: what the direct-SSH browse makes of a computer a desktop drives over SSH, as pure rules
 * (the shell that gathers it runs in SshScriptsTest, the whole path against real tmux in
 * SshTransportTest).
 */
class HostBrowseTest {
    private val now = 10_000_000L

    /** The host's own listing: the desktop's v2-shaped projects, its node-terminal sessions, its mirror. */
    private fun base(
        workspace: String = """{"version":2,"projects":[
            {"id":"p1","name":"Own","cwd":"/home/u/own","nodes":[{"id":"own-1","kind":"terminal"}]},
            {"id":"p2","name":"Its SSH","ssh":{"server":{"host":"box","user":"me"},"remoteCwd":"~"},"nodes":[{"id":"ssh-1","kind":"terminal"}]}]}""",
        sessions: String = "nt-own-1\n",
        status: String = """{"v":1,"updatedAt":5,"nodes":{"own-1":{"state":"working","updatedAt":5}},
            "settings":{"claudePermissionMode":"manual","claudeAccounts":[]},
            "inbox":{"events":[{"id":"e-own","ts":50,"nodeId":"own-1","kind":"done","title":"own"}],"nodes":{}},
            "server":{"version":"0.2.17"}}"""
    ): ProjectsSnapshot = ProjectsParser.parseBlob(
        workspace + "\n" + ProjectsParser.PROJECTS_MARK + "\n" + sessions + "\n" + ProjectsParser.STATUS_MARK + "\n" + status,
        now = now
    )

    private fun out(
        rmt: List<String> = emptyList(),
        slices: List<Pair<String, String>> = emptyList(),
        files: List<Pair<String, String>> = emptyList(),
        ud: String? = "/ud"
    ) = HostBrowse.Output(true, ud, "", rmt, slices, files)

    private fun slice(updatedAt: Long, nodes: String = "", events: String = "", settings: String? = null) =
        """{"v":1,"updatedAt":$updatedAt,"nodes":{$nodes},"inbox":{"events":[$events],"nodes":{}}${settings?.let { ",\"settings\":$it" } ?: ""}}"""

    @Test
    fun `a slice is data up to twice the heartbeat old, and none a millisecond after`() {
        val edge = now - HostBrowse.SLICE_STALE_MS
        val node = """"d-1":{"state":"blocked","agentId":"claude","updatedAt":1}"""
        val fresh = HostBrowse.assemble(base(), out(slices = listOf("proj-d" to slice(edge, node))), now)
        assertEquals(AgentState.BLOCKED, fresh.statusOf("d-1")?.state)
        assertEquals(listOf("proj-d"), fresh.projects.filter { it.drivenRemotely }.map { it.id }, "its slice names the project")

        val stale = HostBrowse.assemble(base(), out(slices = listOf("proj-d" to slice(edge - 1, node))), now)
        assertNull(stale.statusOf("d-1"), "a desktop that stopped pushing says nothing about its sessions")
        assertTrue(stale.projects.none { it.drivenRemotely })
        assertEquals(120_000L, HostBrowse.SLICE_STALE_MS)
    }

    @Test
    fun `the host's own index wins, and the paired desktop's own SSH project is never listed twice (A09)`() {
        val files = listOf(
            // The paired desktop drives this computer as its SSH project p2: its file and session are here.
            // The file may already name a node its index cache does not (a phone appended it): that
            // node's session is listed, but never as a second copy of p2.
            "/srv/self" to """{"id":"p2","name":"Its SSH again","nodes":[{"id":"ssh-1"},{"id":"ssh-new"}]}""",
            // A folder the host's own desktop has as a project reads that file through its index entry.
            "/home/u/own/" to """{"id":"other","name":"Same folder","nodes":[{"id":"x-1"}]}""",
            "/srv/drv" to """{"id":"proj-drv","name":"Driven","nodes":[{"id":"own-1"},{"id":"drv-1"},{"id":"drv.2"}]}"""
        )
        val snap = HostBrowse.assemble(
            base(), out(rmt = listOf("nt-ssh-1", "nt-ssh-new", "nt-x-1", "nt-drv-1", "nt-drv_2", "nt-own-1"), files = files), now
        )
        assertEquals(listOf("Own", "Its SSH", "Driven", HostBrowse.OTHER_SESSIONS_NAME), snap.projects.map { it.name })
        assertEquals("me@box", snap.projects[1].sshTarget, "still the desktop's, reached through it")
        assertEquals(listOf("drv-1", "drv.2"), snap.projects[2].nodes.map { it.id }, "own-1 is the host's own node")
        assertTrue(snap.isLive("drv.2"), "a node id tmux spells with `_` is still its project's session")
        assertEquals(listOf("ssh-new", "x-1"), snap.projects[3].nodes.map { it.id }, "sessions no listed project names")
        // A name on both sockets is the host's own session.
        assertEquals(TmuxNames.SOCKET, snap.socketOf("own-1"))
        assertEquals(TmuxNames.REMOTE_SOCKET, snap.socketOf("drv-1"))
        assertEquals(TmuxNames.REMOTE_SOCKET, snap.socketOf("ssh-1"))
        assertNull(snap.socketOf("nobody"))
    }

    @Test
    fun `a project file is listed when one of its sessions runs here or its desktop is connected`() {
        val file = "/srv/quiet" to """{"id":"proj-q","name":"Quiet","nodes":[{"id":"q-1"}]}"""
        // Found above some other session, nothing of its own running, no slice: nobody drives it.
        assertTrue(HostBrowse.assemble(base(), out(rmt = listOf("nt-z-1"), files = listOf(file)), now).projects.none { it.name == "Quiet" })
        // Its desktop is connected (a fresh slice), though its sessions are not running.
        val connected = HostBrowse.assemble(base(), out(files = listOf(file), slices = listOf("proj-q" to slice(now))), now)
        assertEquals(listOf("q-1"), connected.projects.single { it.name == "Quiet" }.nodes.map { it.id })
        assertFalse(connected.isLive("q-1"))
        // A stale slice is not "connected".
        assertTrue(
            HostBrowse.assemble(base(), out(files = listOf(file), slices = listOf("proj-q" to slice(0))), now).projects.none { it.name == "Quiet" }
        )
    }

    @Test
    fun `the shared file's machine-local fields are not read, and its folder is where it was found`() {
        val files = listOf(
            "/srv/a" to """{"id":"proj-a","name":"A","cwd":"/elsewhere","closed":true,
                "ssh":{"server":{"host":"evil"},"remoteCwd":"~"},
                "nodes":[{"id":"a-1","cwd":"./sub"},{"id":"a-2","cwd":"."},{"id":"a-3","cwd":"/abs"}]}""",
            // No id (a newer writer dropped it), and a second file reusing the first one's id.
            "/srv/b/" to """{"name":"B","nodes":[{"id":"b-1"}]}""",
            "/srv/c" to """{"id":"proj-a","name":"C","nodes":[{"id":"c-1"}]}""",
            "relative/d" to """{"id":"proj-d","name":"D","nodes":[{"id":"d-1"}]}"""
        )
        val snap = HostBrowse.assemble(base(), out(rmt = listOf("nt-a-1", "nt-b-1", "nt-c-1", "nt-d-1"), files = files), now)
        val a = snap.projects.single { it.name == "A" }
        assertEquals("/srv/a", a.cwd)
        assertNull(a.sshTarget, "its sessions run HERE: never refused as another host's")
        assertFalse(a.closed)
        assertEquals(listOf("/srv/a/sub", "/srv/a", "/abs"), a.nodes.map { it.cwd })
        assertEquals("host:/srv/b", snap.projects.single { it.name == "B" }.id)
        assertEquals("host:/srv/c", snap.projects.single { it.name == "C" }.id, "ids stay unique")
        assertTrue(snap.projects.none { it.name == "D" }, "a folder that is not absolute is not trusted")
        assertEquals(listOf("d-1"), snap.projects.single { it.id == HostBrowse.OTHER_SESSIONS_ID }.nodes.map { it.id })
    }

    @Test
    fun `the host's own mirror wins, and fresh slices add their nodes and inbox`() {
        val drvSlice = slice(
            now,
            nodes = """"own-1":{"state":"done","updatedAt":9},"drv-1":{"state":"waiting","agentId":"codex","updatedAt":9}""",
            events = """{"id":"e-drv","ts":20,"nodeId":"drv-1","kind":"question","title":"q"},{"id":"e-own","ts":50,"nodeId":"own-1","kind":"done","title":"dup"}""",
            settings = """{"claudePermissionMode":"plan","claudeAccounts":[]}"""
        )
        val snap = HostBrowse.assemble(base(), out(rmt = listOf("nt-drv-1"), slices = listOf("proj-drv" to drvSlice)), now)
        assertEquals(AgentState.WORKING, snap.statusOf("own-1")?.state, "the host's own entry")
        assertEquals(AgentState.WAITING, snap.statusOf("drv-1")?.state)
        assertEquals(listOf("e-drv", "e-own"), snap.status!!.inbox!!.events.map { it.id }, "oldest first, once each")
        assertEquals("own", snap.status!!.inbox!!.events.last().title)
        assertEquals("manual", snap.status!!.settings!!.claudePermissionMode, "the host's own settings")
        assertEquals(MirrorServer("0.2.17", null, null), snap.status!!.server)
        assertEquals(now, snap.status!!.updatedAt)
        // A computer that runs no nodeterm of its own: the slice's settings are all there is, and with
        // no project file the slice alone names the project and its agents.
        val bare = ProjectsParser.parseBlob("", now)
        val only = HostBrowse.assemble(bare, out(ud = null, rmt = listOf("nt-drv-1"), slices = listOf("proj-drv" to drvSlice)), now)
        assertEquals("plan", only.status!!.settings!!.claudePermissionMode)
        val project = only.projects.single()
        assertEquals("proj-drv", project.name)
        assertEquals(listOf("own-1", "drv-1"), project.nodes.map { it.id })
        assertEquals("codex", project.nodes.last().agentId)
        assertTrue(only.isLive("drv-1") && !only.isLive("own-1"))
    }

    @Test
    fun `an unnamed session takes its agent from a fresh slice, and bad slice names are ignored`() {
        val snap = HostBrowse.assemble(
            base(),
            out(
                rmt = listOf("nt-f-1", "nt-n-9"),
                // The project file predates n-9; its slice already reports it.
                files = listOf("/srv/f" to """{"id":"proj-f","name":"F","nodes":[{"id":"f-1"}]}"""),
                slices = listOf(
                    "proj-f" to slice(now, """"n-9":{"state":"working","agentId":"gemini","updatedAt":1}"""),
                    "bad id" to slice(now, """"z-1":{"state":"working","updatedAt":1}""")
                )
            ),
            now
        )
        assertNull(snap.statusOf("z-1"))
        assertEquals(listOf("f-1"), snap.projects.single { it.name == "F" }.nodes.map { it.id })
        val other = snap.projects.single { it.id == HostBrowse.OTHER_SESSIONS_ID }
        assertEquals(listOf("n-9"), other.nodes.map { it.id })
        assertEquals("gemini", other.nodes.single().agentId)
        assertEquals(AgentState.WORKING, snap.statusOf("n-9")?.state)
        assertTrue(other.drivenRemotely)
        assertTrue(snap.isLive("n-9"))
    }

    @Test
    fun `the split keeps an older script's output whole and drops session names it did not make`() {
        val old = "${SshScripts.META_START}\nud=/ud\n${SshScripts.META_END}\n{\"version\":2,\"projects\":[]}\n${ProjectsParser.PROJECTS_MARK}\nnt-a\n${ProjectsParser.STATUS_MARK}\n{}\n"
        val o = HostBrowse.split(old)
        assertEquals("/ud", o.userData)
        assertTrue(o.blob.contains(ProjectsParser.STATUS_MARK) && o.rmtSessions.isEmpty() && o.slices.isEmpty())
        assertFalse(o.nothingFound(now))
        val none = HostBrowse.split("${SshScripts.META_START}\nud=\n${SshScripts.META_END}\n\n${SshScripts.RMT_MARK}\nnt-ok\nnt-x;y\nfoo\n${SshScripts.END_MARK}\n")
        assertEquals(listOf("nt-ok"), none.rmtSessions)
        assertFalse(none.nothingFound(now), "a session a desktop runs here is something")
        assertTrue(HostBrowse.split("${SshScripts.META_START}\nud=\n${SshScripts.META_END}\n${SshScripts.RMT_MARK}\n${SshScripts.END_MARK}\n").nothingFound(now))
    }

    /**
     * The review of A27a: the desktop never deletes a slice, so a computer a desktop drove once keeps
     * its stale ones for good. Only a slice that is still data is "something found"; stale, broken or
     * misnamed ones leave a computer with no data dir and no session reading as "not found".
     */
    @Test
    fun `slices that are no data do not make a computer with nothing else an empty one`() {
        val node = """"d-1":{"state":"blocked","agentId":"claude","updatedAt":1}"""
        val junk = listOf(
            "proj-old" to slice(now - HostBrowse.SLICE_STALE_MS - 1, node),
            "proj-broken" to "{not json",
            "bad id" to slice(now, node)
        )
        assertTrue(out(slices = junk, ud = null).nothingFound(now), "only slices the listing throws away")
        assertTrue(HostBrowse.assemble(base(workspace = "", sessions = "", status = ""), out(slices = junk, ud = null), now).projects.isEmpty())
        assertFalse(out(slices = junk + ("proj-live" to slice(now, node)), ud = null).nothingFound(now), "a fresh slice is data")
        assertFalse(out(slices = junk, ud = "/ud").nothingFound(now), "a data dir is something, whatever the slices")
        assertFalse(out(rmt = listOf("nt-x"), slices = junk, ud = null).nothingFound(now))
    }

    /** The review of A26: whether the computer advertises its relay right now, from the meta block. */
    @Test
    fun `the meta block says whether the computer advertises its relay`() {
        fun meta(lines: String) = HostBrowse.split("${SshScripts.META_START}\nud=/ud\n$lines${SshScripts.META_END}\n${SshScripts.END_MARK}\n")
        assertEquals(true, meta("relay=1\n").relayAdvertised)
        assertEquals(false, meta("relay=0\n").relayAdvertised)
        assertNull(meta("").relayAdvertised, "a block that does not say is unknown, not 'off'")
        assertNull(meta("relay=yes\n").relayAdvertised)
        // Only the meta block counts: a project file or session name cannot claim it.
        assertNull(HostBrowse.split("${SshScripts.META_START}\nud=/ud\n${SshScripts.META_END}\nrelay=1\n${SshScripts.END_MARK}\n").relayAdvertised)
    }

    @Test
    fun `the install metadata line says what the block says, and nothing it does not`() {
        assertEquals("nodeterm server 0.2.17 · 1e56f83 · installed 2026-09-01", MirrorServer("0.2.17", "1e56f83", "2026-09-01T10:00:00Z").describe())
        assertEquals("nodeterm server · installed yesterday", MirrorServer(null, null, "yesterday").describe())
        assertNull(MirrorServer(null, null, null).describe())
        val parsed = ProjectsParser.parseStatus("""{"server":{"version":"${"9".repeat(65)}","commit":"a\u0007b","installedAt":"2026-09-01"}}""")
        assertEquals(MirrorServer(null, null, "2026-09-01"), parsed!!.server, "overlong or control text is dropped")
        assertNull(ProjectsParser.parseStatus("""{"server":{"version":""}}""")!!.server)
    }

    /** The Compose side is only type-checked here, so what it shows is pinned in its source. */
    @Test
    fun `the app marks a driven project and shows a Server Edition's install line`() {
        assertTrue(AppSourcePins.ui("HostScreen.kt").contains("snapshot.status?.server?.describe()"))
        val header = AppSourcePins.blockAfter(AppSourcePins.ui("SessionsTab.kt"), "private fun ProjectHeader(")
        assertTrue(header.contains("if (project.drivenRemotely)"), header)
    }

    /**
     * The desktop facts these rules copy, read from the desktop's own sources so a change there turns
     * this red instead of silently blanking (or never blanking) a slice.
     */
    @Test
    fun `the desktop contracts the browse reads are the ones the desktop writes`() {
        // Each file by a literal path, so WorkflowPathFilterTest can check that editing it runs the
        // Android workflow (android.yml lists the two under src/main/remote-ssh and src/server/config.ts).
        val repo = InteropHarness.repoRoot
        fun text(f: File) = f.readText().replace("\r\n", "\n")
        val push = text(File(repo, "src/main/remote-ssh/remote-status-push.ts"))
        assertTrue(Regex("""export const STATUS_HEARTBEAT_MS = 60_000\b""").containsMatchIn(push))
        assertEquals(60_000L, HostBrowse.STATUS_HEARTBEAT_MS)
        val sshProject = text(File(repo, "src/main/remote-ssh/ssh-project.ts"))
        assertTrue(sshProject.contains("return `\${dir}/agent-status-\${projectId}.json`"))
        assertTrue(sshProject.contains("`\${c.remoteHome}/.nodeterm`"))
        // The SSH mirror's file carries the desktop's project id: what a slice is named by.
        assertTrue(text(File(repo, "src/core/workspace-files.ts")).contains("cache: projectToFile(p, revOf(p.id), savedAt, p.id)"))
        val config = text(File(repo, "src/server/config.ts"))
        assertTrue(config.contains("const dataDir = resolveDataDir(env, argv)"))
        assertTrue(config.contains("return path.join(os.homedir(), '.nodeterm-server')"))
        assertTrue(text(File(repo, "src/core/tmux-naming.ts")).contains("export const TMUX_SOCKET = '${TmuxNames.SOCKET}'"))
        val ssh = text(File(repo, "src/shared/ssh.ts"))
        assertTrue(ssh.contains("const socket = opts.socket ?? '${TmuxNames.REMOTE_SOCKET}'"))
        assertTrue(Regex("""'new-session',\s*'-A',\s*'-s',\s*posixQuote\(opts\.sessionId\),\s*'-c',""").containsMatchIn(ssh), "sessions start in the node's folder")
        assertTrue(text(File(repo, "src/core/agent-status-mirror.ts")).contains("export interface MirrorServer"))
        // `relay=` reads the file the desktop writes while its phone host is registered at the relay,
        // and removes when the host stops (remote access turned off): its absence is "off" (A26).
        val advertise = text(File(repo, "src/main/remote/relay-advertise.ts"))
        assertTrue(advertise.contains("const FILE = path.join(os.homedir(), '.nodeterm', 'relay.json')"))
        assertTrue(SshScripts.browse().contains("[ -s \"\$HOME/.nodeterm/relay.json\" ]"))
        val host = text(File(repo, "src/main/remote/standing-host.ts"))
        val stop = host.substring(host.indexOf("function stop(): void {")).let { it.substring(0, it.indexOf("\n  }\n")) }
        assertTrue(stop.contains("void removeRelayAdvertisement()"), stop)
        assertTrue(
            Regex("""const want = enabled && relayAllowed\(\)\s+if \(want && !running\) start\(\)\s+else if \(!want && running\) stop\(\)""")
                .containsMatchIn(host),
            "turning remote access off stops the host"
        )
    }
}
