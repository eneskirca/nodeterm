// Which ssh agent a Windows machine offers, decided from the named pipes it has. Pure: the caller
// lists `\\.\pipe\` (native-runtime.ts) and passes the names in, so every rule runs on any CI leg.
//
// Two agents matter on Windows. The OpenSSH agent service listens on `openssh-ssh-agent`. Pageant
// (PuTTY >= 0.75) and KeeAgent ALSO listen on an OpenSSH-protocol pipe, named
// `pageant.<user>.<hash>` — which is the pipe we use. We deliberately do NOT hand ssh2 its own
// `'pageant'` agent string: that spawns a bundled 32-bit `pagent.exe` helper we would have to ship
// unpacked and sign, and it speaks the old WM_COPYDATA protocol the pipe replaced. A Pageant older
// than 0.75 (no pipe) is therefore not supported.

const PIPE_PREFIX = '\\\\.\\pipe\\'

/** The Windows OpenSSH agent service's pipe. */
export const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'
const OPENSSH_PIPE_NAME = 'openssh-ssh-agent'

/** `\\.\pipe\<name>` for a bare pipe name. */
export function pipePath(name: string): string {
  return `${PIPE_PREFIX}${name}`
}

/** The first `pageant.<user>.<hash>` pipe belonging to `user` (case-insensitive), as a full path. */
export function findPageantPipe(pipes: readonly string[], user: string | undefined): string | undefined {
  const want = user?.toLowerCase()
  const hit = pipes.find((p) => {
    const m = /^pageant\.(.+)\.[^.]+$/i.exec(p)
    return !!m && (!want || m[1].toLowerCase() === want)
  })
  return hit ? pipePath(hit) : undefined
}

/**
 * The default agent from the pipes this machine has: the OpenSSH agent service first (it is what
 * Windows' own ssh uses), else the user's Pageant / KeeAgent pipe. Undefined when neither exists.
 */
export function pickWindowsAgent(req: { pipes: readonly string[]; user?: string }): string | undefined {
  if (req.pipes.some((p) => p.toLowerCase() === OPENSSH_PIPE_NAME)) return WINDOWS_OPENSSH_AGENT_PIPE
  return findPageantPipe(req.pipes, req.user)
}

/**
 * `IdentityAgent pageant` (any case) → the discovered Pageant pipe, or `{ missing: true }` when
 * there is none — never the bare string, which ssh2 would turn into a pagent.exe spawn. Every
 * other value passes through unchanged.
 */
export function resolveWindowsIdentityAgent(
  configured: string | undefined,
  pipes: readonly string[],
  user: string | undefined
): { agent: string | undefined; missing?: true } {
  if (!configured || configured.toLowerCase() !== 'pageant') return { agent: configured }
  const pipe = findPageantPipe(pipes, user)
  return pipe ? { agent: pipe } : { agent: undefined, missing: true }
}
