# Override BOTH install and uninstall checks. The stock check can kill processes under INSTDIR,
# including the detached session host. A renamed hard link still holds the installed image open.
#
# Unattended runs (silent, or the app's own --updated handoff) WAIT for the app to finish exiting:
# the updater starts the installer while nodeterm.exe (main, GPU, renderer) is still shutting
# down, so a single probe would abort nearly every self-update. The wait is bounded (~30 s), it
# waits only on "running" (10) — "could not verify" (20) stays fatal at once — and it never kills
# anything. The probe keeps its machine-wide name match: an OLD uninstaller may kill by name.
!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\nodeterm-update-preflight.ps1 "${PROJECT_DIR}\scripts\windows-update-preflight.ps1"
  StrCpy $R1 0
  nodeterm_preflight_retry:
    nsExec::Exec /TIMEOUT=15000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\nodeterm-update-preflight.ps1" -InstallDirectory "$INSTDIR"'
    Pop $R0
    ${If} $R0 == 0
      Goto nodeterm_preflight_clear
    ${EndIf}
    ${If} $R0 == 10
      ${If} ${isUpdated}
      ${OrIf} ${Silent}
        ${If} $R1 < 30
          IntOp $R1 $R1 + 1
          Sleep 1000
          Goto nodeterm_preflight_retry
        ${EndIf}
      ${EndIf}
    ${EndIf}
    # Silent installs must fail closed too, with a nonzero result and no default consent.
    SetErrorLevel 2
    IfSilent nodeterm_preflight_unattended
    ${If} $R0 == 10
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "nodeterm is still running. Quit nodeterm, including from the system tray (right-click the tray icon, then Quit), then Retry. Your sessions keep running in the background session host and reattach after the update.$\r$\n$\r$\nOnly if this message comes back after quitting: Cancel, open nodeterm, and run Prepare for update (Ctrl+K, or the update card). It waits for busy agents, exits idle agents cleanly, stops the session host and quits. Canvas nodes are kept.$\r$\n$\r$\nWith an older nodeterm: save work, exit agents and shells normally, quit nodeterm and wait at least 30 seconds. If the host remains, verify its user and executable path in Task Manager Details, then end only that host. All processes it owns will stop. Saved nodes remain; agent resume needs supported, saved conversation history and cannot recover unsaved work.$\r$\n$\r$\nOther installations/users must prepare their own sessions too. Retry from Downloads, outside the install directory. This installer will not stop your sessions for you." /SD IDCANCEL IDRETRY nodeterm_preflight_retry
    ${Else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "nodeterm could not verify whether the app or its background session host is running. No sessions have been stopped.$\r$\n$\r$\nCancel and check that Windows PowerShell and process queries are available. If another Windows user is running nodeterm, ask them to save work, exit agents and shells normally, and quit nodeterm. If their host remains, its owner must verify and stop it in Task Manager before retrying; keep saved canvas nodes." /SD IDCANCEL IDRETRY nodeterm_preflight_retry
    ${EndIf}
    Goto nodeterm_preflight_cancel
  nodeterm_preflight_unattended:
    !ifndef BUILD_UNINSTALLER
      # The app handed itself over to this installer and has quit (or is quitting). Nothing has
      # been changed yet — this check runs before the old version is uninstalled — so put the user
      # back where they were: record why, for the app to report on its next start, and start the
      # installed build again instead of leaving nothing running.
      ${If} ${isUpdated}
        ReadEnvStr $R2 LOCALAPPDATA
        ${If} $R2 != ""
          CreateDirectory "$R2\nodeterm"
          ClearErrors
          FileOpen $R3 "$R2\nodeterm\update-failed.json" w
          ${IfNot} ${Errors}
            # $R0 is quoted: nsExec answers "error" / "timeout" instead of an exit code when
            # PowerShell could not run, and a bare word there would make the whole note invalid JSON.
            FileWrite $R3 '{"reason":"preflight","code":"$R0","version":"${VERSION}"}'
            FileClose $R3
          ${EndIf}
        ${EndIf}
        ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
          Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
        ${EndIf}
      ${EndIf}
    !endif
  nodeterm_preflight_cancel:
    Quit
  nodeterm_preflight_clear:
    SetErrorLevel 0
!macroend
