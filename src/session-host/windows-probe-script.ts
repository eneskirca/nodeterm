// The PowerShell text behind the Windows pane probes: the one-shot console-owner script (one
// powershell.exe per probe, the original path and now the fallback) and the long-lived probe
// worker's script (windows-probe-worker.ts), which loads the same C# type ONCE and then answers
// JSON-line requests on stdin. Both are built from the same pieces, so the two paths cannot read a
// console differently.
//
// Every script here is a constant written in this repo. The only interpolated value is a process id
// that has been validated as a safe positive integer; the worker receives its pids as JSON data on
// stdin and re-validates them in PowerShell (`[int]`, `> 0`) — no request text is ever evaluated.

/** The C# usings both probe types need; one compilation unit may name them only once. */
const PROBE_USINGS = 'using System; using System.Runtime.InteropServices;'

/**
 * The process table (pid, parent pid, image name) from a Toolhelp32 snapshot, written as JSON in
 * the shape `win32ProcRows` reads (`ProcessId` / `ParentProcessId` / `Name`).
 *
 * Not `Get-CimInstance Win32_Process`: that goes through WMI, and WMI's cost is the machine's, not
 * ours. Measured on a Windows 11 machine with ~630 processes (2026-11-03): EVERY CIM query took
 * 10.3 to 12.1 s, warm or cold, the whole table or one process by id, while the snapshot took
 * 0.55 to 0.64 s including ConvertTo-Json. The pane-command budgets are 1.5 s (worker) and 5 s
 * (one-shot), so with CIM every pane read on that machine answered "unknown", and every caller
 * that must SEE the pane refused: the in-place restart (all variants), the Eco exit, the wake.
 *
 * Built in C# rather than with ConvertTo-Json so a read is a few milliseconds. The source has no
 * single quote (it rides a PowerShell single-quoted string) and no backslash (it rides a TS
 * template literal): quote, backslash and colon are written as char codes.
 */
export const PROC_TABLE_CLASS =
  'public static class NtProcTable { [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct PE32 { public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szExeFile; } [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid); [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PE32 e); [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PE32 e); [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h); static void Key(System.Text.StringBuilder sb, string k) { sb.Append((char)34).Append(k).Append((char)34).Append((char)58); } public static string Json() { IntPtr h = CreateToolhelp32Snapshot(2, 0); if (h == new IntPtr(-1)) throw new Exception("snapshot failed"); System.Text.StringBuilder sb = new System.Text.StringBuilder(); sb.Append("["); try { PE32 e = new PE32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PE32)); if (!Process32FirstW(h, ref e)) throw new Exception("empty snapshot"); bool first = true; do { if (!first) sb.Append(","); first = false; sb.Append("{"); Key(sb, "ProcessId"); sb.Append(e.th32ProcessID); sb.Append(","); Key(sb, "ParentProcessId"); sb.Append(e.th32ParentProcessID); sb.Append(","); Key(sb, "Name"); sb.Append((char)34); foreach (char c in (e.szExeFile ?? "")) { if (c == (char)34 || c == (char)92) { sb.Append((char)92).Append(c); } else if (c < (char)32) { sb.Append((char)92).Append("u").Append(((int)c).ToString("x4")); } else { sb.Append(c); } } sb.Append((char)34).Append("}"); } while (Process32NextW(h, ref e)); } finally { CloseHandle(h); } sb.Append("]"); return sb.ToString(); } }'

/** `Add-Type` of the console probe. In Windows PowerShell 5.1 this runs csc and writes a temp
 *  assembly, which is the cost the worker pays once instead of per probe. */
const PROBE_TYPE = `Add-Type -TypeDefinition '${PROBE_USINGS} public static class NtConsoleProbe { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole(); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid); [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList([Out] uint[] ids, uint length); [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string cmd, out int count); [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p); public static string ScriptArg(string cmd) { if (String.IsNullOrEmpty(cmd)) return ""; int n; IntPtr p = CommandLineToArgvW(cmd, out n); if (p == IntPtr.Zero) return ""; try { if (n < 2) return ""; string a = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p, IntPtr.Size)); return (a == null || a.StartsWith("-")) ? "" : a; } finally { LocalFree(p); } } }';`

const INTERPRETERS = `$interpreters = @('node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl');`

/** The console read itself, for the console whose root is `pidExpr` (a validated integer literal,
 *  or the worker's already-`[int]`-cast `$rootPid`). Ends in the JSON snapshot as its only output. */
function ownerBody(pidExpr: string): string {
  return `$self = $PID; $ids = @();
try {
  [void][NtConsoleProbe]::FreeConsole();
  if (-not [NtConsoleProbe]::AttachConsole(${pidExpr})) { throw 'console unavailable' };
  $buffer = New-Object 'System.UInt32[]' 1024;
  $count = [NtConsoleProbe]::GetConsoleProcessList($buffer, $buffer.Length);
  if ($count -eq 0 -or $count -gt $buffer.Length) { throw 'console identity unavailable' };
  for ($i = 0; $i -lt $count; $i++) { if ($buffer[$i] -ne $self) { $ids += [int]$buffer[$i] } };
} finally { [void][NtConsoleProbe]::FreeConsole() };
$rows = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self } | ForEach-Object {
  $row = @{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; executable = [string]$_.ExecutablePath; born = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) };
  $exe = ([IO.Path]::GetFileNameWithoutExtension([string]$_.ExecutablePath)).ToLower();
  if (($ids -contains [int]$_.ProcessId) -and ($interpreters -contains $exe)) { $row.script = [NtConsoleProbe]::ScriptArg([string]$_.CommandLine) };
  $row
});
@{ console = @($ids); processes = $rows } | ConvertTo-Json -Depth 4 -Compress;`
}

export function validProbePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0
}

/** Probe only. The helper joins the console to read its process list, writes nothing into
 * it, and detaches in finally. The target PID is a validated integer, never shell text.
 * Do not log stdout: the result is an internal identity read. */
export function windowsConsoleProbeScript(rootPid: number): string {
  if (!validProbePid(rootPid)) throw new Error('invalid console root PID')
  return `$ErrorActionPreference = 'Stop';
${PROBE_TYPE}
${INTERPRETERS}
${ownerBody(String(rootPid))}`
}

/**
 * The long-lived worker. Protocol, one JSON object per line each way:
 *   in : {"id":<int>,"op":"owner","pid":<int>}  |  {"id":<int>,"op":"table"}
 *   out: {"id":<int>,"ok":true,"result":<json>}  |  {"id":<int>,"ok":false}
 * `ok:false` is the PROBE failing (no such console, CIM refused) — a definite answer. Anything else
 * (no reply, a malformed line, the process dying) is the caller's cue to use the one-shot path.
 *
 * stdin/stdout are opened as raw UTF-8 streams BEFORE any probe runs: the probe Free/AttachConsoles,
 * and holding the pipe handles up front keeps the protocol independent of whatever console the
 * process is attached to at the moment (device-checklist item in docs/windows-session-host.md).
 * The loop ends when stdin closes, so the worker dies with whoever spawned it.
 */
export const WINDOWS_PROBE_WORKER_SCRIPT = `$ErrorActionPreference = 'Stop';
$ProgressPreference = 'SilentlyContinue';
$ntUtf8 = New-Object System.Text.UTF8Encoding $false;
$ntIn = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $ntUtf8);
$ntOut = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $ntUtf8);
$ntOut.AutoFlush = $true;
${PROBE_TYPE.replace("';", ' ' + PROC_TABLE_CLASS + "';")}
${INTERPRETERS}
function NtOwner([int]$rootPid) {
${ownerBody('$rootPid')}
}
function NtTable() {
  [NtProcTable]::Json()
}
while ($true) {
  $line = $ntIn.ReadLine();
  if ($null -eq $line) { break };
  $id = 0;
  try {
    $req = ConvertFrom-Json $line;
    $id = [int]$req.id;
    if ($req.op -eq 'owner') {
      $target = [int]$req.pid;
      if ($target -le 0) { throw 'invalid pid' };
      $json = NtOwner $target
    } elseif ($req.op -eq 'table') {
      $json = NtTable
    } else { throw 'unknown op' };
    if (-not $json) { $json = 'null' };
    $ntOut.WriteLine('{"id":' + $id + ',"ok":true,"result":' + $json + '}')
  } catch {
    $ntOut.WriteLine('{"id":' + $id + ',"ok":false}')
  }
}`

/** The one-shot process-table read (one powershell.exe), the fallback when the worker cannot
 *  answer. Same snapshot as the worker's `NtTable` (see PROC_TABLE_CLASS for why not CIM). */
export const WIN32_PANE_TABLE_SCRIPT = `$ErrorActionPreference = 'Stop';
Add-Type -TypeDefinition '${PROBE_USINGS} ${PROC_TABLE_CLASS}';
[NtProcTable]::Json()`
