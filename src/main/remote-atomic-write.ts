import { randomUUID } from 'crypto'
import { quoteRemotePath } from '../shared/ssh'

export interface RemoteAtomicWrite {
  command: string
  /** The body the command was built for. Hand THIS to the runner's stdin: the command checks that
   *  exactly its byte count arrived, so any other stdin is refused on the host. */
  stdin: string
  temporaryPath: string
}

/**
 * Exit status of a write the host refused because the temp did not receive exactly the body's
 * bytes. 65 is sysexits' EX_DATAERR; nothing else in these commands exits with it, so a caller can
 * say "the body did not arrive in full" instead of guessing at a cause.
 */
export const REMOTE_WRITE_SHORT_BODY = 65

/**
 * Exit status of a write refused because its `requireDir` did not exist when the write ran.
 * sysexits' EX_NOINPUT; nothing else in these commands exits with it.
 */
export const REMOTE_WRITE_NO_DIR = 66

export type RemoteFileMode = '600' | '644' | '700' | '755'

export interface RemoteAtomicWriteOptions {
  /** Apply umask 077 before creating either the parent or the temp. */
  restrictPermissions?: boolean
  /** Octal mode set on the temp before it is published; the rename carries it over. Omitted: the
   *  temp keeps the mode `cat` created it with (the remote umask). */
  mode?: RemoteFileMode
  /** False when the caller already created and permissioned the parent directory. */
  makeParent?: boolean
  /** An editor may legitimately save an empty file. Nothing this app GENERATES is ever empty, so
   *  an empty body is refused unless the caller says otherwise. */
  allowEmpty?: boolean
  /** Write only if this directory ALREADY exists on the host — checked in the same command as the
   *  write, so a directory removed after the caller looked is not recreated by the parent
   *  `mkdir -p`. Refused with `REMOTE_WRITE_NO_DIR`, the body drained so ssh sees no broken pipe. */
  requireDir?: string
}

function remoteDirname(path: string): string {
  const end = path.replace(/\/+$/, '')
  const slash = end.lastIndexOf('/')
  if (slash < 0) return '.'
  if (slash === 0) return '/'
  return end.slice(0, slash)
}

/**
 * Build the remote-shell half of a stdin → sibling-temp → size check → rename write.
 *
 * WHY THE SIZE CHECK IS THE POINT, not an extra. `cat` cannot tell "the body ended" from "the
 * channel ended": when the ssh channel dies before the body arrives (the ControlMaster killed or
 * rebuilt, the runner's timeout SIGTERMing the child, a dropped link), `cat` reads EOF and exits 0.
 * Measured against OpenSSH 9.6 with the master killed mid-command: a bare `cat > f && chmod 755 f`
 * left `f` at 0 bytes and mode 755 (the chmod ran), and the temp + `mv` shape this function used to
 * build published the empty temp over a good file just the same. A rename only makes a write
 * atomic; it takes the byte count to make it COMPLETE. So the temp must hold exactly the body's
 * UTF-8 byte count before it may be published, and a short temp exits `REMOTE_WRITE_SHORT_BODY`
 * with the target untouched.
 *
 * `wc -c` output is compared inside `[ "…" -eq N ]`: BSD `wc` pads with spaces, which dash, bash
 * (also in POSIX mode) and busybox accept there, and zsh evaluates arithmetically.
 *
 * The UUID is minted locally for every call. A fixed `<target>.tmp` lets overlapping SSH clients
 * share one inode: one rename can publish the other writer's partial bytes, then the loser cannot
 * find the temp it still intends to rename. The nonce contains only shell-inert ASCII, while the
 * complete paths still go through quoteRemotePath so spaces, apostrophes, literal backslashes and
 * a leading `~/` keep their existing meanings.
 *
 * The cleanup preserves the write/move status. Unique temps do not self-heal on the next write,
 * so a normal cat/mv failure must remove the exact temp this invocation owns.
 *
 * Throws on an empty body without `allowEmpty` — before any command exists, so nothing reaches ssh.
 */
export function remoteAtomicWrite(
  path: string,
  body: string,
  options: RemoteAtomicWriteOptions = {}
): RemoteAtomicWrite {
  if (body === '' && !options.allowEmpty) {
    throw new Error(`refusing to write an empty body to ${path}`)
  }
  const bytes = Buffer.byteLength(body, 'utf8')
  const parentPath = remoteDirname(path)
  const temporaryLeaf = `.nodeterm-${randomUUID()}.tmp`
  // Keep the temp beside the target so mv remains one-filesystem atomic, but do not extend the
  // target leaf: a valid NAME_MAX-length filename plus `.UUID.tmp` cannot be created at all.
  const temporaryPath =
    parentPath === '/'
      ? `/${temporaryLeaf}`
      : parentPath === '.'
        ? temporaryLeaf
        : `${parentPath}/${temporaryLeaf}`
  const target = quoteRemotePath(path)
  const temporary = quoteRemotePath(temporaryPath)
  const gate = options.requireDir
    ? `[ -d ${quoteRemotePath(options.requireDir)} ] || { cat > /dev/null; exit ${REMOTE_WRITE_NO_DIR}; }; `
    : ''
  const prefix = `${gate}${options.restrictPermissions ? 'umask 077; ' : ''}`
  const parent = options.makeParent === false
    ? ''
    : `mkdir -p -- ${quoteRemotePath(parentPath)} && `
  const complete = ` && { [ "$(wc -c < ${temporary})" -eq ${bytes} ] || (exit ${REMOTE_WRITE_SHORT_BODY}); }`
  // NEVER `chmod <mode> -- <file>`. BSD/macOS chmod does not permute: its getopt stops at the MODE
  // operand, so a `--` after it is read as a FILE named `--` ("chmod: --: No such file or
  // directory", exit 1) and the publish never happens. That spelling shipped from v0.3.3 on, for the
  // hook endpoint and node tokens, so every write of them to a macOS host failed. The `--` is not
  // needed: the temp is absolute, `~/…` or a `.nodeterm-…` leaf; only a relative parent starting
  // with `-` could look like an option, and that one gets `./`.
  const chmodTarget = temporaryPath.startsWith('-') ? quoteRemotePath(`./${temporaryPath}`) : temporary
  const protect = options.mode ? ` && chmod ${options.mode} ${chmodTarget}` : ''
  const command =
    `${prefix}${parent}{ cat > ${temporary}${complete}${protect} && mv -f -- ${temporary} ${target}; ` +
    `nt_status=$?; ` +
    `rm -f -- ${temporary}; exit "$nt_status"; }`
  return { command, stdin: body, temporaryPath }
}

/** A remote write that did not land. The message names the path and the exit status only — never
 *  the body, which can be a credential or a user's config. */
export class RemoteWriteError extends Error {
  constructor(
    readonly path: string,
    readonly code: number
  ) {
    super(
      `remote write of ${path} did not land (exit ${code}` +
        (code === REMOTE_WRITE_SHORT_BODY ? ': the body did not arrive in full' : '') +
        (code === REMOTE_WRITE_NO_DIR ? ': its directory no longer exists' : '') +
        '); the previous file is unchanged'
    )
    this.name = 'RemoteWriteError'
  }
}

/**
 * Run one `remoteAtomicWrite` and REPORT the outcome: resolves when the file landed, throws a
 * `RemoteWriteError` when it did not. The runners in this app RESOLVE on a non-zero exit, and every
 * caller that awaited `run(...)` and moved on turned a failed write into a silent success — which
 * is how a host ended up with 0-byte canvas-control shims that exited 0 for every agent.
 */
export async function runRemoteAtomicWrite(
  run: (command: string, stdin: string) => Promise<{ code: number }>,
  path: string,
  body: string,
  options: RemoteAtomicWriteOptions = {}
): Promise<void> {
  const write = remoteAtomicWrite(path, body, options)
  const { code } = await run(write.command, write.stdin)
  if (code !== 0) throw new RemoteWriteError(path, code)
}
