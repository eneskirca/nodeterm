package dev.nodeterm.protocol.model

/**
 * What the phone's New-session dialog offers, and what its Start button uses (audit A42).
 *
 * The dialog stays open while the host listing is re-fetched under it (the Host screen re-lists every
 * 8 s), but the user's taps are remembered. So a remembered pick can name a project the desktop has
 * since closed or removed, or a managed account it has since removed. Start used to look the project
 * up with `first {}`, which threw inside the click handler; and a vanished account id was still sent
 * to the desktop, under a picker that drew no row as selected (or, with every account gone, drew no
 * picker at all).
 *
 * So the dialog derives its selection from the CURRENT listing on every recomposition, through these
 * functions, and draws and starts with the same answer: the row shown as selected is always the one
 * Start uses, and Start is off when there is nothing to start in.
 */
object NewSessionChoice {
    /**
     * The projects a phone can start a session in: open, on this computer (an SSH project's terminals
     * run on another machine), and with a folder — the desktop refuses to register a node in a
     * cwd-less canvas, which would orphan the session (A14). Never a project another desktop drives
     * over SSH (A27): this computer's nodeterm would be asked to register a node in a canvas it does
     * not have.
     */
    fun offeredProjects(snapshot: ProjectsSnapshot): List<ProjectInfo> =
        snapshot.openProjects().filter { it.sshTarget == null && it.cwd != null && !it.drivenRemotely }

    /**
     * The project Start uses: the one the user picked while it is still offered, else the first
     * offered project (what the dialog preselects), else null — nothing to start in, so Start is off.
     */
    fun project(offered: List<ProjectInfo>, pickedId: String?): ProjectInfo? =
        offered.firstOrNull { it.id == pickedId } ?: offered.firstOrNull()

    /**
     * The managed Claude account Start uses in [project]: the user's pick while this host still has
     * that account (null is System, which is always there), else the project's default, itself only
     * while the host still has it ([Launch.defaultAccount]) — else System.
     */
    fun account(settings: MirrorSettings?, project: ProjectInfo?, pickedId: String?): String? =
        if (pickedId == null || settings?.claudeAccounts?.any { it.id == pickedId } == true) pickedId
        else Launch.defaultAccount(settings, project)
}
