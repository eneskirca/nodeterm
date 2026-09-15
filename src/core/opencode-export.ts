import { execFile } from 'child_process'
import { findInPathString } from './exec-path'

export function opencodeExportCommand(sessionId: string, platform: string): { file: string; args: string[] } | null {
  // An export identifies one provider session, never a shell fragment or a CLI option.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId)) return null
  if (platform !== 'win32') return { file: 'opencode', args: ['export', sessionId] }
  return {
    file: findInPathString('pwsh', process.env.PATH) ?? 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); & opencode export '${sessionId}'; exit $LASTEXITCODE`]
  }
}

export async function readOpencodeExport(sessionId: string): Promise<string | null> {
  const call = opencodeExportCommand(sessionId, process.platform)
  if (!call) return null
  return new Promise((resolve) => {
    execFile(call.file, call.args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout))
  })
}
