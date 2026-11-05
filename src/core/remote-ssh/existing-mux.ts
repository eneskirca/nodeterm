/** Restricted channel primitive, NOT endpoint authentication or an ownership grant.
 * Callers must separately establish the private socket/endpoint/generation binding.
 * Never reuse childArgs: its deliberate auto-reconnect is incompatible with adoption.
 */
export interface ExistingMuxDestination { host: string; user: string; port?: number }

export function existingMuxArgs(destination: ExistingMuxDestination, controlPath: string, command: string): string[] {
  const { host, user, port = 22 } = destination
  if (typeof host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(host) ||
      typeof user !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(user) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      typeof controlPath !== 'string' || !/^\/[a-zA-Z0-9_./-]{1,99}$/.test(controlPath) || controlPath.split('/').includes('..') ||
      typeof command !== 'string' || !command || command.length > 65_536 || command.includes('\0')) {
    throw new Error('Unsupported existing SSH mux request')
  }
  return [
    // -S / ControlMaster=no alone still permits a DIRECT connection on mux failure.
    // With no config or jump host, the fixed failing proxy is the only fallback.
    '-F', '/dev/null', '-S', controlPath,
    '-o', 'ControlMaster=no', '-o', 'ControlPersist=no',
    '-o', 'ProxyCommand=/bin/false', '-o', 'BatchMode=yes',
    '-o', 'CanonicalizeHostname=no', '-o', 'PermitLocalCommand=no',
    '-o', 'IdentityAgent=none', '-o', 'IdentityFile=none', '-o', 'IdentitiesOnly=yes',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'RequestTTY=no', '-o', 'StrictHostKeyChecking=yes',
    '-p', String(port), '-l', user, '--', host, command
  ]
}
