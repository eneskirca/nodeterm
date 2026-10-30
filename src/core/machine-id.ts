/**
 * The `machine` claim of a project-allowance token (spec §6): a salted SHA-256 of the OS machine
 * id, so one legacy `device-id` file copied to many computers cannot carry one allowance to all of
 * them. It is a new stable identifier, which is why it is read LAZILY — only when an install first
 * claims an allowance — and why the raw id never leaves this module: not logged, not returned, not
 * sent. Only the hash goes to the server, and the server refuses anything that is not 64 lowercase
 * hex, so every path here — the fallback included — ends in `machineHashOf`.
 */
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import crypto from 'node:crypto'

/** Part of the wire contract with nodeterm-server: changing it rebinds every claimed allowance. */
const MACHINE_HASH_SALT = 'nodeterm-project-allowance-v1:'
const EXEC_TIMEOUT_MS = 5000

const UUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'
const IOREG_UUID_RE = new RegExp(`"IOPlatformUUID"\\s*=\\s*"(${UUID})"`)
const REG_MACHINE_GUID_RE = new RegExp(`^\\s*MachineGuid\\s+REG_SZ\\s+(${UUID})\\s*$`, 'm')
/** machine-id(5): 32 lowercase hex. Anything else (empty, systemd's `uninitialized`) is not an id. */
const MACHINE_ID_FILE_RE = /^[0-9a-f]{32}$/i

const LINUX_MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id']

/** `ioreg -rd1 -c IOPlatformExpertDevice` → the `"IOPlatformUUID" = "…"` value, or null. */
export function parseIoregUuid(out: string): string | null {
  return IOREG_UUID_RE.exec(out)?.[1] ?? null
}

/** `reg query …\Cryptography /v MachineGuid` → the `MachineGuid    REG_SZ    <guid>` value, or null. */
export function parseRegMachineGuid(out: string): string | null {
  return REG_MACHINE_GUID_RE.exec(out)?.[1] ?? null
}

/** Lowercase hex SHA-256 of the salted, trimmed, lowercased raw id (64 chars). */
export function machineHashOf(raw: string): string {
  return crypto
    .createHash('sha256')
    .update(MACHINE_HASH_SALT + raw.trim().toLowerCase())
    .digest('hex')
}

/** The OS seams, injectable so tests never shell out or read the real machine id. */
export interface MachineIdDeps {
  platform: NodeJS.Platform
  /** Run a tool and resolve its stdout; reject on spawn failure, non-zero exit or timeout. */
  exec(cmd: string, args: string[]): Promise<string>
  readFile(file: string): Promise<string>
  hostname(): string
}

const realDeps: MachineIdDeps = {
  platform: process.platform,
  exec: (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (err, stdout) =>
        err ? reject(err) : resolve(stdout)
      )
    }),
  readFile: (file) => fs.readFile(file, 'utf8'),
  hostname: () => os.hostname()
}

async function readRawMachineId(deps: MachineIdDeps): Promise<string | null> {
  try {
    if (deps.platform === 'darwin') {
      return parseIoregUuid(await deps.exec('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']))
    }
    if (deps.platform === 'win32') {
      return parseRegMachineGuid(
        await deps.exec('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'])
      )
    }
    if (deps.platform === 'linux') {
      for (const file of LINUX_MACHINE_ID_FILES) {
        try {
          const id = (await deps.readFile(file)).trim()
          if (MACHINE_ID_FILE_RE.test(id)) return id
        } catch {
          // unreadable — try the next one
        }
      }
    }
  } catch {
    // the tool is missing, failed or timed out — fall back below
  }
  return null
}

/** The machine hash, read through `deps`. Never rejects: any failure hashes `host:<hostname>`. */
export async function readMachineHashWith(deps: MachineIdDeps): Promise<string> {
  const raw = await readRawMachineId(deps)
  if (raw) return machineHashOf(raw)
  let host = ''
  try {
    host = deps.hostname()
  } catch {
    // keep '' — the hash is still well-formed
  }
  return machineHashOf('host:' + host)
}

let deps: MachineIdDeps = realDeps
let memo: Promise<string> | null = null

/** This machine's hash, read from the OS once per process (memoized). */
export function readMachineHash(): Promise<string> {
  memo ??= readMachineHashWith(deps)
  return memo
}

/** Test seam: swap the OS readers (null restores the real ones) and drop the memo. */
export function setMachineIdDepsForTests(next: MachineIdDeps | null): void {
  deps = next ?? realDeps
  memo = null
}
