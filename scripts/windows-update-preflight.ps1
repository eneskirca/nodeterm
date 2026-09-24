# Read-only installer gate. No process is terminated, including on query failure.
# Exit 0 = clear, 10 = potentially affected process running, 20 = could not prove it is safe to proceed.
param([Parameter(Mandatory = $true)][string]$InstallDirectory)
$ErrorActionPreference = 'Stop'
try {
    if ($InstallDirectory -notmatch '^(?:[A-Za-z]:\\|\\\\)') { exit 20 }
    $directory = $InstallDirectory.TrimEnd('\')
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    foreach ($process in $processes) {
        # Old uninstallers can use a machine-wide NAME match, or a PATH PREFIX match without a
        # directory boundary. We must cover both before handing control to that old executable.
        # This deliberately blocks another installation too; it never terminates its processes.
        if ($process.Name -ieq 'nodeterm.exe' -or $process.Name -ieq 'nodeterm-session-host.exe') {
            if ([string]::IsNullOrWhiteSpace($process.ExecutablePath)) { exit 20 }
            exit 10
        }
        if (-not [string]::IsNullOrWhiteSpace($process.ExecutablePath) -and
            $process.ExecutablePath.StartsWith($directory, [StringComparison]::OrdinalIgnoreCase)) { exit 10 }
    }
    exit 0
} catch {
    exit 20
}
