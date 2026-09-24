# Override BOTH install and uninstall checks. The stock check can kill processes under INSTDIR,
# including the detached session host. A renamed hard link still holds the installed image open.
!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\nodeterm-update-preflight.ps1 "${PROJECT_DIR}\scripts\windows-update-preflight.ps1"
  nodeterm_preflight_retry:
    nsExec::Exec /TIMEOUT=15000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\nodeterm-update-preflight.ps1" -InstallDirectory "$INSTDIR"'
    Pop $R0
    ${If} $R0 == 0
      Goto nodeterm_preflight_clear
    ${EndIf}
    # Silent installs must fail closed too, with a nonzero result and no default consent.
    SetErrorLevel 2
    IfSilent nodeterm_preflight_cancel
    ${If} $R0 == 10
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "nodeterm or a process using its installation is running. Closing the app keeps sessions alive.$\r$\n$\r$\nCancel to save work in every local session. Exit agents and shells normally; keep canvas nodes. Quit nodeterm and wait at least 30 seconds.$\r$\n$\r$\nIf the host remains, verify its user and executable path in Task Manager Details, then end only that host. All processes it owns will stop. Saved nodes remain; agent resume needs supported, saved conversation history and cannot recover unsaved work.$\r$\n$\r$\nOther installations/users must prepare their own sessions too. Retry from Downloads, outside the install directory. This installer will not stop your sessions for you." /SD IDCANCEL IDRETRY nodeterm_preflight_retry
    ${Else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "nodeterm could not verify whether the app or its background session host is running. No sessions have been stopped.$\r$\n$\r$\nCancel and check that Windows PowerShell and process queries are available. If another Windows user is running nodeterm, ask them to save work, exit agents and shells normally, and quit nodeterm. If their host remains, its owner must verify and stop it in Task Manager before retrying; keep saved canvas nodes." /SD IDCANCEL IDRETRY nodeterm_preflight_retry
    ${EndIf}
  nodeterm_preflight_cancel:
    Quit
  nodeterm_preflight_clear:
    SetErrorLevel 0
!macroend
