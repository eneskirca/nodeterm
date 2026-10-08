package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.ProjectInfo
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.SshTerminalCreation
import dev.nodeterm.protocol.model.SshTerminalFolders
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SshTerminalCreationTest {
    private val id = "phone-00000000-0000-4000-8000-000000000001"

    @Test fun `double tap cannot admit a second creation while the first waits`() = runBlocking {
        val release = CompletableDeferred<Unit>()
        val calls = mutableListOf<SshTerminalCreation.Request>()
        val creation = SshTerminalCreation(this, { calls += it; release.await() }, newId = { id })
        val ticket = creation.show()
        assertTrue(creation.submit(ticket, null) {})
        assertFalse(creation.submit(ticket, "/other") {})
        yield()
        assertEquals(listOf(SshTerminalCreation.Request(id, null)), calls)
        release.complete(Unit)
        yield()
        assertIs<SshTerminalCreation.State.Ready>(creation.state.value)
    }

    @Test fun `dismissal does not cancel creation or its relisting and never navigates`() = runBlocking {
        val release = CompletableDeferred<Unit>()
        val calls = mutableListOf<String>()
        val creation = SshTerminalCreation(this, { calls += "create"; release.await(); calls += "relist" }, newId = { id })
        val ticket = creation.show()
        creation.submit(ticket, "/work") { calls += "navigate" }
        yield()
        creation.hide(ticket)
        release.complete(Unit)
        yield()
        assertEquals(listOf("create", "relist"), calls)
        assertIs<SshTerminalCreation.State.Ready>(creation.state.value)
        assertNull(creation.takeReady(ticket))
        val reopened = creation.show()
        assertEquals(SshTerminalCreation.Request(id, "/work"), creation.takeReady(reopened))
        assertIs<SshTerminalCreation.State.Idle>(creation.state.value)
    }

    @Test fun `reopened dialog cannot adopt navigation from an earlier submission`() = runBlocking {
        val release = CompletableDeferred<Unit>()
        var navigated = false
        val creation = SshTerminalCreation(this, { release.await() }, newId = { id })
        val old = creation.show()
        creation.submit(old, null) { navigated = true }
        yield()
        creation.hide(old)
        val current = creation.show()
        creation.hide(old) // An old disposal must not retire the new dialog.
        release.complete(Unit)
        yield()
        assertFalse(navigated)
        assertTrue(creation.isCurrent(current))
        assertEquals(id, creation.takeReady(current)?.nodeId)
    }

    @Test fun `success becomes ready before visible navigation and only consumes once`() = runBlocking {
        val creation = SshTerminalCreation(this, {}, newId = { id })
        val ticket = creation.show()
        val calls = mutableListOf<String>()
        creation.submit(ticket, null) { calls += creation.takeReady(ticket)!!.nodeId }
        yield()
        assertEquals(listOf(id), calls)
        assertNull(creation.takeReady(ticket))
    }

    @Test fun `UI callback rechecks a ticket retired after completion but before navigation`() = runBlocking {
        val callbackEntered = CompletableDeferred<Unit>()
        val releaseCallback = CompletableDeferred<Unit>()
        var navigated = false
        val creation = SshTerminalCreation(this, {}, newId = { id })
        val ticket = creation.show()
        creation.submit(ticket, null) {
            callbackEntered.complete(Unit)
            releaseCallback.await()
            navigated = creation.takeReady(ticket) != null
        }
        callbackEntered.await()
        creation.hide(ticket)
        releaseCallback.complete(Unit)
        yield()
        assertFalse(navigated)
        assertIs<SshTerminalCreation.State.Ready>(creation.state.value)
    }

    @Test fun `lost reply retries one UUID and frozen folder rather than duplicating`() = runBlocking {
        val calls = mutableListOf<SshTerminalCreation.Request>()
        var minted = 0
        val creation = SshTerminalCreation(this, {
            calls += it
            if (calls.size == 1) throw Exception("reply lost")
        }, newId = { minted++; id })
        val ticket = creation.show()
        creation.submit(ticket, "/work with spaces") {}
        yield()
        val failed = assertIs<SshTerminalCreation.State.Failed>(creation.state.value)
        assertEquals("reply lost", failed.message)
        assertFalse(failed.canChangeFolder)
        assertFalse(creation.submit(ticket, "/different") {})
        assertTrue(creation.submit(ticket, "/work with spaces") {})
        yield()
        assertEquals(1, minted)
        assertEquals(listOf(failed.request, failed.request), calls)
    }

    @Test fun `lost reply survives dialog replacement and retries its original request`() = runBlocking {
        val calls = mutableListOf<SshTerminalCreation.Request>()
        val creation = SshTerminalCreation(this, { calls += it; throw Exception("lost") }, newId = { id })
        val old = creation.show()
        creation.submit(old, null) {}
        yield()
        creation.hide(old)
        val replacement = creation.show()
        assertFalse(creation.submit(old, null) {})
        assertTrue(creation.submit(replacement, null) {})
        yield()
        assertEquals(2, calls.size)
        assertEquals(calls[0], calls[1])
    }

    @Test fun `definitive folder refusal permits a new choice and a fresh operation identity`() = runBlocking {
        var minted = 0
        val calls = mutableListOf<SshTerminalCreation.Request>()
        val creation = SshTerminalCreation(this, {
            calls += it
            if (calls.size == 1) throw IllegalArgumentException("Folder does not exist")
        }, newId = { "phone-00000000-0000-4000-8000-${(++minted).toString().padStart(12, '0')}" })
        val ticket = creation.show()
        creation.submit(ticket, "/missing") {}
        yield()
        assertTrue(assertIs<SshTerminalCreation.State.Failed>(creation.state.value).canChangeFolder)
        assertTrue(creation.submit(ticket, "/exists") {})
        yield()
        assertEquals(2, minted)
        assertEquals("/exists", calls.last().cwd)
    }

    @Test fun `invalid local folder never reaches SSH or consumes an identity`() = runBlocking {
        var calls = 0
        val creation = SshTerminalCreation(this, { calls++ }, newId = { error("Must not mint") })
        val ticket = creation.show()
        for (folder in listOf("relative", "", "/x\n", "/x\u0085", "/" + "x".repeat(4096))) {
            assertFalse(creation.submit(ticket, folder) {})
        }
        yield()
        assertEquals(0, calls)
        assertIs<SshTerminalCreation.State.Idle>(creation.state.value)
    }

    @Test fun `cancelled transport attempt stays uncertain and cannot report success`() = runBlocking {
        val job = Job()
        val started = CompletableDeferred<Unit>()
        val creation = SshTerminalCreation(CoroutineScope(coroutineContext + job), { started.complete(Unit); CompletableDeferred<Unit>().await() }, newId = { id })
        val ticket = creation.show()
        var navigated = false
        creation.submit(ticket, null) { navigated = true }
        started.await()
        job.cancel()
        job.join()
        val failed = assertIs<SshTerminalCreation.State.Failed>(creation.state.value)
        assertFalse(failed.canChangeFolder)
        assertFalse(navigated)
        assertTrue(job.isCancelled)
    }

    @Test fun `folder choices include home and local driven folders but exclude other SSH hosts`() {
        fun project(id: String, cwd: String?, remote: Boolean = false, target: String? = null, closed: Boolean = false) =
            ProjectInfo(id, id, "#ffffff", cwd, target, closed, emptyList(), null, drivenRemotely = remote)
        val snapshot = ProjectsSnapshot(
            listOf(project("local", "/work"), project("duplicate", "/work"), project("driven", "/remote-work", true),
                project("other-host", "/other", target = "elsewhere"), project("relative", "./bad"),
                project("no-folder", null), project("control", "/bad\t"), project("closed", "/still-existing", closed = true)),
            emptySet(), null, 1
        )
        assertEquals(listOf(null, "/work", "/remote-work", "/still-existing"), SshTerminalFolders.choices(snapshot).map { it.cwd })
    }
}
