import { describe, expect, it, vi } from 'vitest'
import { sshListArgs, sshReadArgs, sshReadBinaryArgs, sshWriteArgs, sshMkdirArgs, sshExistsArgs, sshCheckIgnoreArgs, sshAppendArgs, sshTailArgs, sshSizeArgs, sshQuickOpenArgs, parseQuickOpenListing, parseLsEntries, SshFs, SSH_QUICK_OPEN_MAX_BYTES } from './ssh-fs'

const conn = { host: 'h', user: 'u' }
const ref = { conn, controlPath: '/s.sock' }

describe('ssh-fs arg builders', () => {
  it('list runs ls -Ap1 on the quoted path', () => {
    expect(sshListArgs(conn, '/s.sock', '/a b/c').join(' ')).toContain(`ls -Ap1 '/a b/c'`)
  })
  it('read cats the quoted path', () => {
    expect(sshReadArgs(conn, '/s.sock', "/x'y").join(' ')).toContain(`cat '/x'\\''y'`)
  })
  it('readBinary base64s the quoted path', () => {
    expect(sshReadBinaryArgs(conn, '/s.sock', '/i.png').join(' ')).toContain(`base64 '/i.png'`)
  })
  // ATOMIC: `cat > file` truncates the target the moment it opens, so a connection dropped (or the
  // ControlMaster killed at quit) mid-write left a HALF/EMPTY file behind — for .nodeterm/project.json
  // that read as "my project reset itself". Write a sibling .tmp, then mv into place.
  it('write mkdir -p the dirname, cat > a sibling .tmp, then mv into place (content via stdin)', () => {
    const j = sshWriteArgs(conn, '/s.sock', '/d/e/f.txt').join(' ')
    expect(j).toContain(`mkdir -p '/d/e'`)
    expect(j).toContain(`cat > '/d/e/f.txt.tmp'`)
    expect(j).toContain(`mv -f '/d/e/f.txt.tmp' '/d/e/f.txt'`)
  })
  // CRITICAL: SSH projects default to a home-relative remoteCwd (`~`). quoteRemotePath must leave a
  // leading `~/` UNQUOTED so the remote shell tilde-expands it; the remainder stays single-quoted.
  it('list leaves a leading ~/ unquoted so the remote shell tilde-expands the path', () => {
    expect(sshListArgs(conn, '/s', '~/projects').join(' ')).toContain(`ls -Ap1 ~/'projects'`)
  })
  it('write keeps ~/ unquoted for the mkdir dirname, the .tmp target and the mv', () => {
    const j = sshWriteArgs(conn, '/s', '~/projects/file.txt').join(' ')
    expect(j).toContain(`mkdir -p ~/'projects'`)
    expect(j).toContain(`cat > ~/'projects/file.txt.tmp'`)
    expect(j).toContain(`mv -f ~/'projects/file.txt.tmp' ~/'projects/file.txt'`)
  })
  it('mkdir runs mkdir -p on the quoted path', () => {
    expect(sshMkdirArgs(conn, '/s.sock', '/a b/c').join(' ')).toContain(`mkdir -p '/a b/c'`)
  })
  it('mkdir leaves a leading ~/ unquoted so the remote shell tilde-expands the path', () => {
    expect(sshMkdirArgs(conn, '/s', '~/projects/new').join(' ')).toContain(`mkdir -p ~/'projects/new'`)
  })
  it('append mkdir -p the dirname, printf %s\\n the single-quoted line, >> the quoted path', () => {
    const j = sshAppendArgs(conn, '/s.sock', '/d/e/log.jsonl', '{"id":"a"}').join(' ')
    expect(j).toContain(`mkdir -p '/d/e'`)
    expect(j).toContain("printf '%s\\n' '{\"id\":\"a\"}'")
    expect(j).toContain(`>> '/d/e/log.jsonl'`)
  })
  it('append single-quote-escapes a quote in the line content', () => {
    expect(sshAppendArgs(conn, '/s', '/d/log', `{"t":"a'b"}`).join(' ')).toContain(`printf '%s\\n' '{"t":"a'\\''b"}'`)
  })
  it('append leaves a leading ~/ unquoted for the mkdir dirname and the >> target', () => {
    const j = sshAppendArgs(conn, '/s', '~/p/log.jsonl', 'L').join(' ')
    expect(j).toContain(`mkdir -p ~/'p'`)
    expect(j).toContain(`>> ~/'p/log.jsonl'`)
  })
  it('tail runs tail -n <lines> on the quoted path', () => {
    expect(sshTailArgs(conn, '/s.sock', '/a b/log', 500).join(' ')).toContain(`tail -n 500 '/a b/log'`)
  })
  it('tail leaves a leading ~/ unquoted and coerces the line count to a safe integer', () => {
    expect(sshTailArgs(conn, '/s', '~/p/log', 12.9).join(' ')).toContain(`tail -n 12 ~/'p/log'`)
  })
  it('size runs `cat | wc -c` on the quoted path (quiet + 0 on a missing file)', () => {
    const j = sshSizeArgs(conn, '/s.sock', '/a b/log.jsonl').join(' ')
    expect(j).toContain(`cat '/a b/log.jsonl' 2>/dev/null | wc -c`)
  })
  it('size leaves a leading ~/ unquoted so the remote shell tilde-expands the path', () => {
    expect(sshSizeArgs(conn, '/s', '~/p/log.jsonl').join(' ')).toContain(`cat ~/'p/log.jsonl' 2>/dev/null | wc -c`)
  })
  it('exists runs test -e on the quoted path', () => {
    expect(sshExistsArgs(conn, '/s.sock', '/a b/c').join(' ')).toContain(`test -e '/a b/c'`)
  })
  it('exists leaves a leading ~/ unquoted so the remote shell tilde-expands the path', () => {
    expect(sshExistsArgs(conn, '/s', '~/projects/file.txt').join(' ')).toContain(`test -e ~/'projects/file.txt'`)
  })
  it('check-ignore quotes the dir as a remote path (~ expands) but quotes entry NAMES literally', () => {
    const j = sshCheckIgnoreArgs(conn, '/s', '~/p', ['node_modules', "a'b"]).join(' ')
    expect(j).toContain(`git -C ~/'p' check-ignore -- 'node_modules' 'a'\\''b'`)
  })
})

describe('parseLsEntries', () => {
  it('folders-first alphabetical, .git hidden, trailing-slash → dir', () => {
    expect(parseLsEntries('zeta.txt\nsrc/\n.git/\nalpha/\nb.md\n')).toEqual([
      { name: 'alpha', dir: true, ignored: false },
      { name: 'src', dir: true, ignored: false },
      { name: 'b.md', dir: false, ignored: false },
      { name: 'zeta.txt', dir: false, ignored: false }
    ])
  })
})

describe('SshFs (injected runner)', () => {
  it('readText returns stdout, empty on failure', async () => {
    expect(await new SshFs(async () => ({ code: 0, stdout: 'hi' })).readText(ref, '/x')).toBe('hi')
    expect(await new SshFs(async () => ({ code: 1, stdout: '' })).readText(ref, '/x')).toBe('')
  })
  it('writeText feeds content on stdin and returns true on code 0 / false otherwise', async () => {
    const run = vi.fn(async (_args: string[], _stdin?: string) => ({ code: 0, stdout: '' }))
    expect(await new SshFs(run).writeText(ref, '/d/f.txt', 'BODY')).toBe(true)
    expect(run.mock.calls[0][1]).toBe('BODY') // stdin
    expect(await new SshFs(async () => ({ code: 1, stdout: '' })).writeText(ref, '/x', 'b')).toBe(false)
  })
  it('listDir parses ls output and flags ignored from check-ignore', async () => {
    const run = vi.fn(async (args: string[]) =>
      args.join(' ').includes('check-ignore') ? { code: 0, stdout: 'node_modules\n' } : { code: 0, stdout: 'node_modules/\nsrc/\n' }
    )
    const out = await new SshFs(run).listDir(ref, '/p')
    expect(out).toEqual([
      { name: 'node_modules', dir: true, ignored: true },
      { name: 'src', dir: true, ignored: false }
    ])
  })
  it('fail-open: listDir → [] when the ls run fails', async () => {
    expect(await new SshFs(async () => ({ code: 1, stdout: '' })).listDir(ref, '/p')).toEqual([])
  })
  it('mkdir true on code 0, false otherwise', async () => {
    expect(await new SshFs(async () => ({ code: 0, stdout: '' })).mkdir(ref, '/d')).toBe(true)
    expect(await new SshFs(async () => ({ code: 1, stdout: '' })).mkdir(ref, '/d')).toBe(false)
  })
  it('exists true on code 0 (test -e), false otherwise', async () => {
    expect(await new SshFs(async () => ({ code: 0, stdout: '' })).exists(ref, '/d')).toBe(true)
    expect(await new SshFs(async () => ({ code: 1, stdout: '' })).exists(ref, '/d')).toBe(false)
  })

  // readText can't tell "the file is not there" from "the connection is down" — both come back ''.
  // For workspace reconciliation that difference is load-bearing: absent → push our cache up,
  // error → do NOTHING (a failed read is never evidence of absence). ssh itself exits 255 on any
  // connection/auth failure; a remote `cat` on a missing file exits 1.
  it('readTextChecked: exit 0 → ok+content, remote non-zero → absent, ssh 255/throw → error', async () => {
    expect(await new SshFs(async () => ({ code: 0, stdout: 'hi' })).readTextChecked(ref, '/x')).toEqual({ status: 'ok', content: 'hi' })
    expect(await new SshFs(async () => ({ code: 1, stdout: '' })).readTextChecked(ref, '/x')).toEqual({ status: 'absent' })
    expect(await new SshFs(async () => ({ code: 255, stdout: '' })).readTextChecked(ref, '/x')).toEqual({ status: 'error' })
    expect(await new SshFs(async () => { throw new Error('spawn') }).readTextChecked(ref, '/x')).toEqual({ status: 'error' })
  })
})

// ⌘K Quick Open over SSH: one remote round-trip that mirrors the local fallback chain
// (rg two passes → git ls-files two passes → find), parsed with the same shared filter.
describe('sshQuickOpenArgs', () => {
  const cmd = (): string => sshQuickOpenArgs(conn, '/s.sock', '/re po').join(' ')
  it('cds into the quoted cwd so every lister emits cwd-relative paths', () => {
    expect(cmd()).toContain(`cd '/re po' && `)
  })
  it('leaves a leading ~/ unquoted so the remote shell tilde-expands the cwd', () => {
    expect(sshQuickOpenArgs(conn, '/s.sock', '~/projects').join(' ')).toContain(`cd ~/'projects' && `)
  })
  it('prefers rg: two passes (ignore-respecting + --no-ignore-vcs), pruning node_modules', () => {
    const c = cmd()
    expect(c).toContain('command -v rg')
    expect(c).toContain(`rg --files --hidden '--glob' '!**/node_modules'`)
    expect(c).toContain('--no-ignore-vcs')
  })
  it('falls back to git ls-files (NUL-delimited, tracked+untracked then ignored pass)', () => {
    const c = cmd()
    expect(c).toContain('git ls-files -z --cached --others --exclude-standard')
    expect(c).toContain('git ls-files -z --others --ignored --exclude-standard')
  })
  it('falls back to a pruned find for non-git roots without rg', () => {
    const c = cmd()
    expect(c).toContain('find .')
    expect(c).toContain(`-name 'node_modules'`)
    expect(c).toContain('-prune')
  })
  it('caps the transfer with head -c so a huge repo cannot flood the master', () => {
    expect(cmd()).toContain(`| head -c ${SSH_QUICK_OPEN_MAX_BYTES}`)
  })
})

describe('parseQuickOpenListing', () => {
  it('splits on newline (rg/find) and NUL (git -z), normalizes ./ prefixes, sorts', () => {
    expect(parseQuickOpenListing('./src/b.ts\nsrc/a.ts\n')).toEqual(['src/a.ts', 'src/b.ts'])
    expect(parseQuickOpenListing('a.ts\0b with space.ts\0')).toEqual(['a.ts', 'b with space.ts'])
  })
  it('dedupes the two rg/git passes', () => {
    expect(parseQuickOpenListing('src/a.ts\nsrc/a.ts\n')).toEqual(['src/a.ts'])
  })
  it('drops blocklisted dirs and root escapes — the remote listing is untrusted', () => {
    expect(parseQuickOpenListing('node_modules/x.js\n../up\n/abs\na/../b\nok.ts\n')).toEqual(['ok.ts'])
  })
  it('drops the (possibly truncated) last entry when output hit the head -c cap', () => {
    const filler = 'y'.repeat(SSH_QUICK_OPEN_MAX_BYTES - 8)
    expect(parseQuickOpenListing(`good.ts\n${filler}`)).toEqual(['good.ts'])
  })
})

describe('SshFs.listQuickOpenFiles', () => {
  it('returns the parsed listing on exit 0', async () => {
    const fs = new SshFs(async () => ({ code: 0, stdout: './src/a.ts\nREADME.md\n' }))
    expect(await fs.listQuickOpenFiles(ref, '~/p')).toEqual(['README.md', 'src/a.ts'])
  })
  it('fail-open: [] on non-zero exit (bad cwd / connection down) and on a runner throw', async () => {
    expect(await new SshFs(async () => ({ code: 1, stdout: '' })).listQuickOpenFiles(ref, '/p')).toEqual([])
    expect(await new SshFs(async () => ({ code: 255, stdout: '' })).listQuickOpenFiles(ref, '/p')).toEqual([])
    expect(await new SshFs(async () => { throw new Error('spawn') }).listQuickOpenFiles(ref, '/p')).toEqual([])
  })
})
