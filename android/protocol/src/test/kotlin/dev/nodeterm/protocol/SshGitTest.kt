package dev.nodeterm.protocol

import dev.nodeterm.protocol.git.GitReplies
import dev.nodeterm.protocol.host.GitVerb
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.HostUnansweredException
import dev.nodeterm.protocol.ssh.SshGit
import dev.nodeterm.protocol.ssh.SshGitScripts
import kotlinx.serialization.json.*
import java.io.File
import java.nio.file.Files
import kotlin.test.*

/** Actual typed POSIX producer + public client parser against disposable real Git repositories. */
class SshGitTest {
    private fun fixture(block: (File, (List<String>) -> String, SshGit) -> Unit) {
        val root = Files.createTempDirectory("nt-ssh-git-").toFile()
        val repo = File(root, "project ' quoted\n").apply { mkdirs() }
        fun command(argv: List<String>, dir: File = repo): Pair<Int, String> {
            val p = ProcessBuilder(argv).directory(dir).redirectErrorStream(true).apply {
                environment()["GIT_CONFIG_GLOBAL"] = "/dev/null"
                environment()["GIT_CONFIG_SYSTEM"] = "/dev/null"
                environment().keys.removeIf { it.startsWith("GIT_CONFIG_KEY_") || it.startsWith("GIT_CONFIG_VALUE_") }
                environment().remove("GIT_CONFIG_COUNT")
                listOf("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES").forEach(environment()::remove)
            }.start()
            val out = p.inputStream.bufferedReader().readText()
            check(p.waitFor() == 0) { out }
            return 0 to out
        }
        val git: (List<String>) -> String = { command(listOf("git") + it).second }
        git(listOf("init", "-b", "main")); git(listOf("config", "user.name", "SSH Git fixture"))
        git(listOf("config", "user.email", "fixture@example.invalid")); git(listOf("config", "commit.gpgsign", "false"))
        File(repo, "base").writeText("before\n")
        git(listOf("add", "--", "base")); git(listOf("commit", "-m", "initial"))
        val engine = SshGit(repo.path, listOf(repo.path)) { script, _ ->
            // Keep actual nonzero exit statuses: a Git refusal is a response, not a transport loss.
            val p = ProcessBuilder("/bin/sh", "-c", script).directory(root).redirectErrorStream(true).apply {
                environment()["GIT_CONFIG_GLOBAL"] = "/dev/null"; environment()["GIT_CONFIG_SYSTEM"] = "/dev/null"
            }.start()
            val out = p.inputStream.bufferedReader().readText()
            p.waitFor() to out
        }
        try { block(repo, git, engine) } finally { root.deleteRecursively() }
    }
    private fun paths(vararg paths: String) = mapOf("paths" to JsonArray(paths.map(::JsonPrimitive)))
    private fun request(git: SshGit, verb: GitVerb, args: Map<String, JsonElement> = emptyMap()) = git.request(verb, args)

    @Test fun `real Git status diff stage unstage commit and history retain literal hostile filenames`() = fixture { repo, shell, git ->
        val names = listOf("space ' quote.txt", "-option", ":(glob)*", "two\nlines\tß.txt", "\$(touch INJECTION)")
        names.forEach { File(repo, it).writeText("one\ntwo\n") }
        val before = assertNotNull(GitReplies.status(request(git, GitVerb.STATUS)))
        assertEquals(names.toSet(), before.untracked.map { it.path }.toSet())
        val diff = GitReplies.diff(request(git, GitVerb.DIFF, mapOf("path" to JsonPrimitive(names[0]), "untracked" to JsonPrimitive(true))))!!
        assertTrue(diff.contains("+two"))
        assertTrue(GitReplies.result(request(git, GitVerb.STAGE, paths(names[2])))!!.ok)
        assertEquals(listOf(names[2]), GitReplies.status(request(git, GitVerb.STATUS))!!.staged.map { it.path }, "pathspec magic is a literal filename, never all paths")
        assertEquals((names - names[2]).toSet(), GitReplies.status(request(git, GitVerb.STATUS))!!.untracked.map { it.path }.toSet())
        request(git, GitVerb.UNSTAGE, paths(names[2]))
        assertTrue(GitReplies.result(request(git, GitVerb.STAGE, paths(*names.toTypedArray())))!!.ok)
        val staged = GitReplies.status(request(git, GitVerb.STATUS))!!
        assertEquals(names.toSet(), staged.staged.map { it.path }.toSet())
        assertTrue(staged.staged.all { it.added == 2 })
        assertTrue(GitReplies.result(request(git, GitVerb.UNSTAGE, paths(names[1])))!!.ok)
        assertEquals(listOf(names[1]), GitReplies.status(request(git, GitVerb.STATUS))!!.untracked.map { it.path })
        request(git, GitVerb.STAGE, paths(names[1]))
        val message = "literal ' \$(touch INJECTION)\nsecond line"
        assertTrue(GitReplies.result(request(git, GitVerb.COMMIT, mapOf("message" to JsonPrimitive(message))))!!.ok)
        val history = GitReplies.history(request(git, GitVerb.HISTORY))!!
        assertEquals(2, history.commits.size)
        assertEquals("literal ' \$(touch INJECTION) second line", history.commits.first().subject)
        assertEquals("main", history.currentRef)
        assertTrue(history.commits.first().timestampMs!! in 1_577_836_800_000L..(System.currentTimeMillis() + 1000L))
        assertTrue("main" in history.commits.first().refs)
        assertFalse(File(repo, "INJECTION").exists())
        assertTrue(shell(listOf("log", "-1", "--format=%B")).contains(message))
    }

    @Test fun `real rename conflict and detached head map through the same client models`() = fixture { repo, shell, git ->
        shell(listOf("mv", "base", "renamed\n'ß"))
        val rename = GitReplies.status(request(git, GitVerb.STATUS))!!
        assertEquals("renamed\n'ß", rename.staged.single().path)
        assertEquals("R", rename.staged.single().status)
        request(git, GitVerb.COMMIT, mapOf("message" to JsonPrimitive("rename")))
        shell(listOf("checkout", "-b", "other")); File(repo, "renamed\n'ß").writeText("other\n")
        shell(listOf("commit", "-am", "other")); shell(listOf("checkout", "main"))
        File(repo, "renamed\n'ß").writeText("main\n"); shell(listOf("commit", "-am", "main"))
        assertFalse(GitReplies.result(request(git, GitVerb.PULL))!!.ok, "missing remote must be honest")
        val merge = ProcessBuilder("git", "merge", "other").directory(repo).redirectErrorStream(true).start()
        merge.inputStream.readBytes(); assertEquals(1, merge.waitFor())
        val conflict = GitReplies.status(request(git, GitVerb.STATUS))!!
        assertEquals("UU", conflict.conflicts.single().code)
        assertEquals("renamed\n'ß", conflict.conflicts.single().path)
        assertTrue(conflict.staged.isEmpty() && conflict.changes.isEmpty())
        val diff = GitReplies.diff(request(git, GitVerb.DIFF, mapOf("path" to JsonPrimitive("renamed\n'ß"))))!!
        assertTrue(diff.contains("<<<<<<<"))
        shell(listOf("merge", "--abort")); shell(listOf("checkout", "--detach"))
        assertEquals("HEAD", GitReplies.status(request(git, GitVerb.STATUS))!!.branch)
        assertEquals(shell(listOf("rev-parse", "--short", "HEAD")).trim(), GitReplies.history(request(git, GitVerb.HISTORY))!!.currentRef)
    }

    @Test fun `push sets a missing upstream only after confirmed refusal and pull keeps host policy`() = fixture { repo, shell, git ->
        val remote = File(repo.parentFile, "remote.git")
        val init = ProcessBuilder("git", "init", "--bare", "-b", "main", remote.path).redirectErrorStream(true).start()
        init.inputStream.readBytes(); assertEquals(0, init.waitFor())
        shell(listOf("remote", "add", "origin", remote.path))
        assertTrue(GitReplies.status(request(git, GitVerb.STATUS))!!.hasRemote)
        assertFalse(GitReplies.status(request(git, GitVerb.STATUS))!!.hasUpstream)
        assertTrue(GitReplies.result(request(git, GitVerb.PUSH))!!.ok)
        assertTrue(GitReplies.status(request(git, GitVerb.STATUS))!!.hasUpstream)
        assertEquals("origin/main", GitReplies.history(request(git, GitVerb.HISTORY))!!.remoteRef)
        File(repo, "base").appendText("outgoing\n"); shell(listOf("commit", "-am", "outgoing"))
        assertTrue(GitReplies.history(request(git, GitVerb.HISTORY))!!.hasOutgoingChanges)
        request(git, GitVerb.PUSH)
        // A server's rejection text can mention the upstream advice too. It is not a refusal to
        // dispatch, so the phone must not repeat this push (which could have partially succeeded).
        File(repo, "base").appendText("rejected\n"); shell(listOf("commit", "-am", "rejected"))
        val attempts = File(remote, "attempts")
        val hook = File(remote, "hooks/pre-receive").apply {
            writeText("#!/bin/sh\nprintf '%s\\n' attempt >> ${dev.nodeterm.protocol.ssh.SshScripts.q(attempts.path)}\nprintf '%s\\n' 'set-upstream: no upstream; rejected by fixture' >&2\nexit 1\n")
            setExecutable(true)
        }
        val rejected = GitReplies.result(request(git, GitVerb.PUSH))!!
        assertFalse(rejected.ok); assertTrue(rejected.message.contains("set-upstream"))
        assertEquals(1, attempts.readLines().size, "a confirmed remote rejection is one push, despite matching upstream advice")
        hook.delete(); shell(listOf("reset", "--hard", "HEAD~1"))
        shell(listOf("reset", "--hard", "HEAD~1"))
        assertTrue(GitReplies.history(request(git, GitVerb.HISTORY))!!.hasIncomingChanges)
        assertTrue(GitReplies.result(request(git, GitVerb.PULL))!!.ok)
        assertTrue(File(repo, "base").readText().contains("outgoing"))
        shell(listOf("remote", "set-url", "origin", File(repo.parentFile, "missing.git").path))
        val failed = GitReplies.result(request(git, GitVerb.PUSH))!!
        assertFalse(failed.ok); assertTrue(failed.message.contains("does not appear to be a git repository"))
    }

    @Test fun `physical cwd jail rejects outside prefix traversal symlink and ancestor repository`() = fixture { repo, _, _ ->
        val outside = File(repo.parentFile, repo.name + "-outside").apply { mkdirs() }
        val link = File(repo, "escape"); Files.createSymbolicLink(link.toPath(), outside.toPath())
        fun run(cwd: File, roots: List<String> = listOf(repo.path), rootMode: Boolean = false): Pair<Int, String> {
            val p = ProcessBuilder("/bin/sh", "-c", SshGitScripts.command(cwd.path, roots, listOf("status", "--porcelain=v2", "-z"), rootMode)).start()
            val out = p.inputStream.bufferedReader().readText(); return p.waitFor() to out
        }
        for (cwd in listOf(outside, link, File(repo, "../" + outside.name))) assertEquals(SshGitScripts.REFUSED, run(cwd).first, cwd.path)
        val sub = File(repo, "sub").apply { mkdirs() }
        assertEquals(0, run(sub, rootMode = true).first, "status operates at repo root for project descendants")
        assertEquals(SshGitScripts.REFUSED, run(sub, listOf(sub.path), true).first, "a parent repo outside the listed project must not be staged")
        assertEquals(0, run(sub, listOf("/"), true).first, "a genuine filesystem-root project is root-aware")
        assertFailsWith<HostException> { SshGitScripts.command(repo.path, emptyList(), listOf("status")) }
        for (path in listOf("../base", "sub/../../base", "/base", "a\u0000b")) assertFailsWith<HostException> { SshGitScripts.path(path) }
    }

    @Test fun `unconfirmed writes never retry and returned signing errors remain Git results`() {
        var calls = 0
        val git = SshGit("/project", listOf("/project")) { _, write -> if (!write) 0 to "main\n" else { calls++; null to "no upstream branch" } }
        assertFailsWith<HostUnansweredException> { request(git, GitVerb.PUSH) }
        assertEquals(1, calls)
        var writes = 0
        val rejection = SshGit("/project", listOf("/project")) { _, write ->
            if (!write) 0 to "main\n" else { writes++; 1 to "fatal: The current branch main has no upstream branch.\nset-upstream" }
        }
        assertFalse(GitReplies.result(request(rejection, GitVerb.PUSH))!!.ok)
        assertEquals(1, writes, "exit1 cannot authorize a second write, even with exact native-looking prose")
        for (out in listOf("remote: fatal: The current branch main has no upstream branch.", "fatal: The current branch changed has no upstream branch.")) {
            writes = 0
            val other = SshGit("/project", listOf("/project")) { _, write ->
                if (!write) 0 to "main\n" else { writes++; 128 to out }
            }
            assertFalse(GitReplies.result(request(other, GitVerb.PUSH))!!.ok)
            assertEquals(1, writes, "only the exact native fatal for the captured branch permits an origin fallback")
        }
        val lost = SshGit("/project", listOf("/project")) { _, _ -> throw HostUnansweredException("lost acknowledgement") }
        assertFailsWith<HostUnansweredException> { request(lost, GitVerb.COMMIT, mapOf("message" to JsonPrimitive("message"))) }
        val failed = SshGit("/project", listOf("/project")) { _, _ -> 1 to "error: gpg failed to sign the data" }
        assertEquals("error: gpg failed to sign the data", GitReplies.result(request(failed, GitVerb.COMMIT, mapOf("message" to JsonPrimitive("message"))))!!.message)
    }

    @Test fun `missing Git and inherited repository environment cannot impersonate a project repository`() = fixture { repo, shell, _ ->
        val ordinary = File(repo.parentFile, "ordinary").apply { mkdirs() }
        val foreign = File(repo.parentFile, "foreign")
        shell(listOf("init", "-b", "foreign", foreign.path))
        fun engine(cwd: File, env: Map<String, String>) = SshGit(cwd.path, listOf(cwd.path)) { script, _ ->
            val p = ProcessBuilder("/bin/sh", "-c", script).apply { environment().putAll(env) }.start()
            val out = p.inputStream.bufferedReader().readText(); p.waitFor() to out
        }
        assertFalse(GitReplies.status(request(engine(ordinary, mapOf("GIT_DIR" to File(repo, ".git").path, "GIT_WORK_TREE" to repo.path)), GitVerb.STATUS))!!.hasRepo)
        assertEquals("main", GitReplies.status(request(engine(repo, mapOf("GIT_DIR" to File(foreign, ".git").path, "GIT_WORK_TREE" to repo.path)), GitVerb.STATUS))!!.branch,
            "a listed cwd must not silently use an inherited foreign Git index/branch")
        val missing = assertFailsWith<HostException> { request(engine(repo, mapOf("PATH" to "/no-such-git-bin")), GitVerb.STATUS) }
        assertTrue(missing.message!!.contains("Git is not installed"), missing.message)
    }

    @Test fun `ordinary folder unborn history and history pagination are explicit`() = fixture { repo, shell, git ->
        val folder = File(repo.parentFile, "ordinary").apply { mkdirs() }
        val empty = SshGit(folder.path, listOf(folder.path)) { script, _ ->
            val p = ProcessBuilder("/bin/sh", "-c", script).start(); val out = p.inputStream.bufferedReader().readText(); p.waitFor() to out
        }
        assertFalse(GitReplies.status(request(empty, GitVerb.STATUS))!!.hasRepo)
        shell(listOf("checkout", "--orphan", "unborn"))
        assertTrue(GitReplies.history(request(git, GitVerb.HISTORY))!!.commits.isEmpty())
        shell(listOf("checkout", "main"))
        for (n in 1..51) shell(listOf("commit", "--allow-empty", "-m", "page-$n"))
        val history = GitReplies.history(request(git, GitVerb.HISTORY))!!
        assertEquals(50, history.commits.size); assertTrue(history.hasMore)
        assertEquals("page-51", history.commits.first().subject)
    }

    @Test fun `history does not execute signature verification or mix configured GPG prose into typed records`() = fixture { repo, shell, git ->
        val raw = shell(listOf("cat-file", "-p", "HEAD"))
        val signature = "gpgsig -----BEGIN PGP SIGNATURE-----\n fixture\n -----END PGP SIGNATURE-----\n"
        val commit = raw.substringBefore("\n\n") + "\n" + signature + "\n" + raw.substringAfter("\n\n")
        val hash = ProcessBuilder("git", "hash-object", "-t", "commit", "-w", "--stdin").directory(repo).start()
        hash.outputStream.use { it.write(commit.toByteArray()) }
        val id = hash.inputStream.bufferedReader().readText().trim()
        assertEquals(0, hash.waitFor())
        shell(listOf("update-ref", "refs/heads/main", id))
        val marker = File(repo, "verification-was-executed")
        val verifier = File(repo.parentFile, "fixture-verifier").apply {
            writeText("#!/bin/sh\nprintf called > ${dev.nodeterm.protocol.ssh.SshScripts.q(marker.path)}\nprintf 'fixture verifier prose\\n' >&2\nexit 1\n")
            setExecutable(true)
        }
        shell(listOf("config", "gpg.program", verifier.path))
        shell(listOf("config", "log.showSignature", "true"))
        assertEquals(id, GitReplies.history(request(git, GitVerb.HISTORY))!!.commits.first().id)
        assertFalse(marker.exists(), "history has a typed format, not an interactive GPG verification")
    }
}
