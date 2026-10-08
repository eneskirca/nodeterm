package dev.nodeterm.protocol.ssh

import dev.nodeterm.protocol.host.GitVerb
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.HostUnansweredException
import dev.nodeterm.protocol.model.J.b
import dev.nodeterm.protocol.model.J.s
import kotlinx.serialization.json.*

/** SSH producer for the existing GitReplies consumer. No shell command or revision comes from RPC. */
internal class SshGit(
    private val cwd: String,
    private val roots: List<String>,
    private val run: (script: String, write: Boolean) -> Pair<Int?, String>
) {
    private fun exec(args: List<String>, write: Boolean = false, repositoryRoot: Boolean = true): Pair<Int, String> {
        val (code, out) = run(SshGitScripts.command(cwd, roots, args, repositoryRoot), write)
        if (code == null) {
            if (write) throw HostUnansweredException("The SSH computer did not confirm the Git operation. It may have finished.")
            throw HostException("The SSH computer did not confirm the Git reply.")
        }
        if (code == SshGitScripts.REFUSED || code == SshGitScripts.MISSING) throw HostException(out.trim())
        return code to out
    }

    private fun read(args: List<String>): String {
        val (code, out) = exec(args)
        if (code != 0) throw HostException(out.trim().ifEmpty { "Git failed (exit $code)." })
        return out
    }

    fun request(verb: GitVerb, args: Map<String, JsonElement>): JsonElement = when (verb) {
        GitVerb.STATUS -> status()
        GitVerb.DIFF -> {
            val o = JsonObject(args)
            val path = SshGitScripts.path(o.s("path") ?: throw HostException("Choose a file to compare."))
            val untracked = o.b("untracked") == true
            val argv = buildList {
                add("diff"); add("--no-ext-diff"); add("--no-textconv"); add("--color=never")
                if (untracked) add("--no-index") else if (o.b("staged") == true) add("--cached")
                add("--"); if (untracked) add("/dev/null"); add(path)
            }
            val (code, out) = exec(argv)
            if (code != 0 && !(untracked && code == 1)) throw HostException(out.trim().ifEmpty { "Git diff failed (exit $code)." })
            JsonPrimitive(out)
        }
        GitVerb.STAGE, GitVerb.UNSTAGE -> {
            val values = args["paths"] as? JsonArray ?: throw HostException("Choose files to stage or unstage.")
            if (values.size > 4096) throw HostException("Too many files in one Git request.")
            val paths = values.map { SshGitScripts.path((it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content
                ?: throw HostException("Invalid Git filename.")) }
            if (paths.sumOf { it.length } > 128_000) throw HostException("Too many filenames in one Git request.")
            if (paths.isEmpty()) result(true, "") else write(
                (if (verb == GitVerb.STAGE) listOf("add", "--") else listOf("restore", "--staged", "--")) + paths
            )
        }
        GitVerb.COMMIT -> {
            val message = (args["message"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: throw HostException("Invalid commit message.")
            if ('\u0000' in message || message.length > 128_000) throw HostException("Invalid commit message.")
            if (message.isBlank()) result(false, "Commit message is empty.") else write(listOf("commit", "-m", message))
        }
        GitVerb.PUSH -> {
            val (branchCode, branchOut) = exec(listOf("symbolic-ref", "--quiet", "--short", "HEAD"))
            val branch = branchOut.trim()
            val (code, out) = exec(listOf("push"), write = true)
            if (code == 0) result(true, "Pushed.") else if (code == 128 && branchCode == 0 && branch.isNotEmpty() && !branch.startsWith('-') &&
                out.lineSequence().firstOrNull() == "fatal: The current branch $branch has no upstream branch.") {
                // Native fatal 128 before dispatch, for the branch observed before this push.
                // Remote/hook rejection prose and every unanswered write MUST remain a single attempt.
                write(listOf("push", "-u", "origin", branch), "Pushed (set upstream).")
            } else result(false, out.trim())
        }
        GitVerb.PULL -> write(listOf("pull"), "Pulled.")
        GitVerb.HISTORY -> history()
    }

    private fun write(args: List<String>, success: String = ""): JsonObject {
        val (code, out) = exec(args, write = true)
        return result(code == 0, if (code == 0) success else out.trim().ifEmpty { "Git failed (exit $code)." })
    }

    private fun status(): JsonObject {
        // An ordinary folder is a useful empty status; missing Git/jail failures are not.
        val (inside, answer) = exec(listOf("rev-parse", "--is-inside-work-tree"), repositoryRoot = false)
        if (inside != 0 || answer.trim() != "true") return resultStatus(false)
        val raw = read(listOf("status", "--porcelain=v2", "-z", "--branch", "-uall"))
        val stagedStats = numstat(read(listOf("diff", "--no-ext-diff", "--no-textconv", "--cached", "--numstat", "-z")))
        val changedStats = numstat(read(listOf("diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z")))
        val remote = read(listOf("remote")).isNotBlank()
        val root = read(listOf("rev-parse", "--show-toplevel")).trimEnd('\n', '\r')
        return parseStatus(raw, root.substringAfterLast('/'), remote, stagedStats, changedStats)
    }

    private fun history(): JsonObject {
        val (code, raw) = exec(listOf("log", "--no-show-signature", "-51", "-z", "--format=%H%x00%h%x00%s%x00%an%x00%at%x00%D"))
        if (code != 0) {
            // A new/unborn branch has no commits; other errors remain errors.
            val (headCode, _) = exec(listOf("rev-parse", "--verify", "HEAD"))
            if (headCode != 0) return buildJsonObject { put("items", JsonArray(emptyList())); put("hasMore", false) }
            throw HostException(raw.trim())
        }
        val entries = raw.removeSuffix("\u0000").split('\u0000')
        if (entries.size % 6 != 0) throw HostException("The SSH computer returned an unreadable Git history.")
        val all = entries.chunked(6).map { f -> buildJsonObject {
            put("id", f[0]); put("displayId", f[1]); put("subject", f[2]); put("author", f[3])
            f[4].toLongOrNull()?.let { put("timestamp", it * 1000L) }
            put("references", JsonArray(f[5].split(", ").filter { it.isNotEmpty() }.map { ref -> buildJsonObject { put("name", ref.removePrefix("HEAD -> ")) } }))
        } }
        val statusRaw = read(listOf("status", "--porcelain=v2", "-z", "--branch", "-uno"))
        val meta = parseStatus(statusRaw, "", false)
        val branch = meta.s("branch") ?: "HEAD"
        val upstream = branchHeaders(statusRaw)["branch.upstream"]
        return buildJsonObject {
            put("items", JsonArray(all.take(50))); put("hasMore", all.size > 50)
            put("currentRef", buildJsonObject { put("name", if (branch == "HEAD") all.firstOrNull()?.s("displayId") ?: "HEAD" else branch) })
            upstream?.let { put("remoteRef", buildJsonObject { put("name", it) }) }
            put("hasIncomingChanges", (meta["behind"] as? JsonPrimitive)?.intOrNull?.let { it > 0 } == true)
            put("hasOutgoingChanges", (meta["ahead"] as? JsonPrimitive)?.intOrNull?.let { it > 0 } == true)
        }
    }

    companion object {
        private fun result(ok: Boolean, message: String) = buildJsonObject { put("ok", ok); put("message", message) }
        private fun resultStatus(hasRepo: Boolean) = buildJsonObject {
            put("hasRepo", hasRepo); put("staged", JsonArray(emptyList())); put("changes", JsonArray(emptyList()))
        }
        private fun branchHeaders(raw: String): Map<String, String> = raw.split('\u0000').filter { it.startsWith("# ") }.associate {
            val line = it.removePrefix("# "); line.substringBefore(' ') to line.substringAfter(' ', "")
        }
        internal fun numstat(raw: String): Map<String, Pair<Int, Int>> {
            val fields = raw.split('\u0000'); val stats = LinkedHashMap<String, Pair<Int, Int>>(); var i = 0
            while (i < fields.size) {
                val parts = fields[i++].split('\t', limit = 3)
                if (parts.size != 3) continue
                val path = if (parts[2].isEmpty()) {
                    if (i + 1 >= fields.size) throw HostException("Unreadable Git rename statistics.")
                    i++; fields[i++] // the destination, not the former name
                } else parts[2]
                stats[path] = (parts[0].toIntOrNull() ?: 0) to (parts[1].toIntOrNull() ?: 0)
            }
            return stats
        }
        internal fun parseStatus(raw: String, repoName: String, hasRemote: Boolean,
                                 stagedStats: Map<String, Pair<Int, Int>> = emptyMap(), changedStats: Map<String, Pair<Int, Int>> = emptyMap()): JsonObject {
            val headers = branchHeaders(raw); val staged = ArrayList<JsonElement>(); val changed = ArrayList<JsonElement>()
            val fields = raw.split('\u0000'); var i = 0
            fun entry(path: String, status: Char, stats: Map<String, Pair<Int, Int>>) = buildJsonObject {
                put("path", path); put("status", status.toString()); put("added", stats[path]?.first ?: 0); put("deleted", stats[path]?.second ?: 0)
            }
            while (i < fields.size) {
                val f = fields[i++]; if (f.isEmpty() || f.startsWith("# ") || f.startsWith("! ")) continue
                if (f.startsWith("? ")) { changed += entry(f.substring(2), 'U', emptyMap()); continue }
                val type = f.first(); val count = when (type) { '1' -> 9; '2' -> 10; 'u' -> 11; else -> throw HostException("Unreadable Git status.") }
                val parts = f.split(' ', limit = count)
                if (parts.size != count || parts[1].length != 2) throw HostException("Unreadable Git status.")
                val xy = parts[1]; val path = parts.last()
                if (type == '2') { if (i >= fields.size) throw HostException("Unreadable Git rename."); i++ }
                if (xy[0] != '.') staged += entry(path, xy[0], stagedStats)
                if (xy[1] != '.') changed += entry(path, xy[1], changedStats)
            }
            val ab = headers["branch.ab"]?.split(' ') ?: emptyList()
            return buildJsonObject {
                put("hasRepo", true); put("repoName", repoName)
                put("branch", headers["branch.head"]?.takeUnless { it == "(detached)" } ?: "HEAD")
                put("ahead", ab.firstOrNull()?.removePrefix("+")?.toIntOrNull() ?: 0)
                put("behind", ab.getOrNull(1)?.removePrefix("-")?.toIntOrNull() ?: 0)
                put("hasRemote", hasRemote); put("hasUpstream", headers.containsKey("branch.upstream"))
                put("staged", JsonArray(staged)); put("changes", JsonArray(changed))
            }
        }
    }
}
