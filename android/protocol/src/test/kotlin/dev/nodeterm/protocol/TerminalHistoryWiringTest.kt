package dev.nodeterm.protocol

import kotlin.test.*

class TerminalHistoryWiringTest {
    @Test fun `native Find searches host history and keeps result requests separate from terminal input`() {
        val sheet = AppSourcePins.ui("TerminalHistorySheet.kt")
        assertTrue("LaunchedEffect(request)" in sheet)
        AppSourcePins.assertInOrder(sheet, "val ticket = request", "val literal = submitted", "controller.searchHistory(literal)")
        assertTrue("if (request == ticket) result = answer" in sheet)
        assertTrue("finally { if (request == ticket) searching = false }" in sheet)
        assertTrue("catch (cancelled: CancellationException) { throw cancelled }" in sheet)
        assertTrue("Match case; spaces are significant." in sheet)
        assertTrue("found.truncated" in sheet && "Some matches are omitted" in sheet)
        assertFalse("controller.raw(" in sheet || "controller.key(" in sheet)
    }
    @Test fun `history completion refuses a replaced stopped or disposed stream`() {
        val search = AppSourcePins.blockAfter(AppSourcePins.ui("TerminalController.kt"), "suspend fun searchHistory(")
        AppSourcePins.assertInOrder(search, "val expected = stream", "expected.searchHistory(query)", "stream !== expected || disposed || stopped")
    }
    @Test fun `leaving or backgrounding the screen closes history before detaching its stream`() {
        val controller = AppSourcePins.ui("TerminalController.kt")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(controller, "fun onStop()"), "closeHistory()", "slot.leave()")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(controller, "fun dispose()"), "closeHistory()", "slot.close()")
    }
}
