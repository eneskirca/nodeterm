import { execFile } from 'child_process'
import { readFile, readlink } from 'fs/promises'
import { promisify } from 'util'
import { foregroundArgvArgs, paneOwnerFrom } from '../core/agents/pane-owner'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'

const exec = promisify(execFile)

interface ProcessIdentity {
  pid: number
  command: string
  group: number
  session: number
  tty: number
  foreground: number
  birth: string
}

/** /proc stat's comm may contain spaces and parentheses. Fields after its LAST ')' are numeric. */
export function linuxProcessIdentity(text: string): ProcessIdentity | null {
  const end = text.lastIndexOf(')')
  const head = /^(\d+) \(/.exec(text)
  if (!head || end < 0) return null
  const fields = text.slice(end + 1).trim().split(/\s+/)
  const pid = Number(head[1])
  const values = [fields[2], fields[3], fields[4], fields[5]].map(Number)
  if (!Number.isSafeInteger(pid) || pid <= 0 || values.some(v => !Number.isSafeInteger(v)) ||
      !/^\d+$/.test(fields[19] ?? '')) return null
  return {
    pid, command: text.slice(text.indexOf('(') + 1, end),
    group: values[0], session: values[1], tty: values[2], foreground: values[3], birth: fields[19]
  }
}

export interface LinuxPaneProbe {
  stat(pid: number): Promise<string>
  tty(pid: number): Promise<string>
  foreground(tty: string): Promise<string>
}

const kernel: LinuxPaneProbe = {
  stat: pid => readFile(`/proc/${pid}/stat`, 'utf8'),
  tty: pid => readlink(`/proc/${pid}/fd/0`),
  foreground: async tty => {
    const call = foregroundArgvArgs(tty)
    if (!call) throw new Error('Invalid tty')
    return (await exec(call.bin, call.args, { timeout: 1000, maxBuffer: 1024 * 1024 })).stdout
  }
}

/** The tty foreground group, never the deepest descendant (which may be a background MCP).
 * Birth times and host generation prevent PID/tty reuse from admitting a replacement. */
export async function readLinuxPaneOwner(
  rootPid: number, generation: string, probe: LinuxPaneProbe = kernel
): Promise<PaneOwner | null> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || !generation) return null
  try {
    const root = linuxProcessIdentity(await probe.stat(rootPid))
    if (!root || root.pid !== rootPid || root.tty === 0 || root.foreground <= 0) return null
    const tty = await probe.tty(rootPid)
    if (!/^\/dev\/pts\/\d+$/.test(tty)) return null
    const owner = paneOwnerFrom({
      panePid: rootPid, tty, command: root.command,
      paneId: `host-linux:${generation}:${root.birth}`
    }, await probe.foreground(tty))
    if (!owner?.pids?.length) return null
    const identities = await Promise.all(owner.pids.map(async pid => linuxProcessIdentity(await probe.stat(pid))))
    if (identities.some((p, i) => !p || p.pid !== owner.pids![i] || p.tty !== root.tty ||
        p.session !== root.session || p.group !== root.foreground || p.foreground !== root.foreground)) return null
    const after = linuxProcessIdentity(await probe.stat(rootPid))
    if (!after || after.birth !== root.birth || after.tty !== root.tty ||
        after.session !== root.session || after.foreground !== root.foreground ||
        await probe.tty(rootPid) !== tty) return null
    return { ...owner, processBirths: identities.map(p => p!.birth) }
  } catch { return null }
}

/** Full foreground identity; a shell or another agent must never receive the submitting Enter. */
export function sameLinuxProcess(before: PaneOwner | undefined, after: PaneOwner | null): boolean {
  return !!before && !!after && !!before.paneId && before.paneId === after.paneId &&
    before.panePid === after.panePid && before.tty === after.tty &&
    !!before.pids?.length && before.pids.length === after.pids?.length &&
    before.pids.every((pid, i) => pid === after.pids![i] &&
      !!before.processBirths?.[i] && before.processBirths[i] === after.processBirths?.[i] &&
      before.argv[i] === after.argv[i])
}
