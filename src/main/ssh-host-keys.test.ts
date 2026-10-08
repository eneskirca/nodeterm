import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, promises as fs, rmSync, symlinkSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import os from 'os'
import path from 'path'
import {
  MAX_SSH_HOST_KEYS,
  SSH_HOST_KEY_DISCOVERY_LIMITS,
  hostKeyPathsInSshdConfig,
  includePathsInSshdConfig,
  readSshHostKeyFingerprints,
  sshFingerprintOfPublicKeyLine
} from './ssh-host-keys'

// GitHub publishes its SSH host keys together with the fingerprints OpenSSH prints for them
// (docs.github.com, "GitHub's SSH key fingerprints"): an outside vector for the exact format, which is
// also the one sshj reports on the phone (`SshHostConnection.fingerprint`, checked against the same
// keys in the protocol tests).
const GITHUB_ED25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
const GITHUB_ED25519_FP = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU'
const GITHUB_ECDSA =
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg='
const GITHUB_ECDSA_FP = 'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM'

/** A fresh ed25519 public key line, as `ssh-keygen` writes a `.pub`. */
function ed25519Line(comment = 'root@host'): string {
  const name = Buffer.from('ssh-ed25519', 'ascii')
  const len = (n: number): Buffer => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n, 0)
    return b
  }
  return `ssh-ed25519 ${Buffer.concat([len(name.length), name, len(32), randomBytes(32)]).toString('base64')} ${comment}`
}

const dirs: string[] = []
const tempDir = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'nt-ssh-host-keys-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Include host-key discovery', () => {
  const publicKey = (directory: string, name: string): [string, string] => {
    const key = path.join(directory, name)
    const line = ed25519Line()
    writeFileSync(key + '.pub', line + '\n')
    return [key, sshFingerprintOfPublicKeyLine(line)!]
  }

  it('parses quoted and multiple Include paths without interpreting comments or malformed quotes', () => {
    expect(includePathsInSshdConfig([
      '# Include /ignored',
      ' Include "/opt/ssh config/*.conf" /opt/other/?.conf # comment',
      'INCLUDE=relative/[ab].conf',
      'Include "/opt/with#hash.conf"',
      'Include "/unterminated /ignored',
      'Include /token/%u.conf',
      'HostKey /not-an-include'
    ].join('\n'))).toEqual(['/opt/ssh config/*.conf', '/opt/other/?.conf', 'relative/[ab].conf', '/opt/with#hash.conf'])
  })

  it('follows external, nested and relative Includes in lexical glob order under the config root', async () => {
    const root = tempDir()
    const external = path.join(tempDir(), 'with space')
    mkdirSync(external)
    const keyDir = tempDir()
    const [first, firstFp] = publicKey(keyDir, 'first')
    const [second, secondFp] = publicKey(keyDir, 'second')
    const [nested, nestedFp] = publicKey(keyDir, 'nested')
    const [wrongBase, wrongFp] = publicKey(keyDir, 'wrong-base')
    mkdirSync(path.join(root, 'nested'))
    mkdirSync(path.join(external, 'nested'))
    writeFileSync(path.join(root, 'sshd_config'), `Include "${external}/*.conf" missing/*.conf\n`)
    writeFileSync(path.join(external, '20-key.conf'), `HostKey ${second}\n`)
    writeFileSync(path.join(external, '10-key.conf'), `HostKey ${first}\nInclude nested/key-?.[c]onf\n`)
    writeFileSync(path.join(root, 'nested', 'key-a.conf'), `HostKey ${nested}\nHostKey relative-key\n`)
    writeFileSync(path.join(external, 'nested', 'key-a.conf'), `HostKey ${wrongBase}\n`)
    const found = await readSshHostKeyFingerprints([root])
    expect(found).toEqual([firstFp, nestedFp, secondFp])
    expect(found).not.toContain(wrongFp)
  })

  it('deduplicates canonical files across symlink cycles while retaining ordinary drop-in supersets', async () => {
    const root = tempDir()
    const external = tempDir()
    const [key, fp] = publicKey(external, 'custom')
    const config = path.join(root, 'sshd_config')
    const alias = path.join(external, 'cycle.conf')
    symlinkSync(config, alias)
    writeFileSync(config, `Include ${external}/*.conf\n`)
    writeFileSync(path.join(external, 'key.conf'), `HostKey ${key}\nInclude ${alias}\n`)
    mkdirSync(path.join(root, 'sshd_config.d'))
    writeFileSync(path.join(root, 'sshd_config.d', 'without-suffix'), `HostKey ${key}\n`)
    const opened: string[] = []
    const original = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      opened.push(String(args[0]))
      return original(...args)
    })
    expect(await readSshHostKeyFingerprints([root])).toEqual([fp])
    expect(opened.filter((name) => name === config)).toHaveLength(1)
    expect(opened).not.toContain(alias)
  })

  it('does not open private HostKeys, even through Include globs or a public-name symlink', async () => {
    const root = tempDir()
    const external = tempDir()
    const [custom, fp] = publicKey(external, 'custom-secret')
    const generatedPrivate = path.join(external, 'ssh_host_ed25519_key')
    writeFileSync(custom, 'PRIVATE HOSTKEY SENTINEL\n')
    writeFileSync(generatedPrivate, 'ANOTHER PRIVATE SENTINEL\n')
    symlinkSync(custom, path.join(root, 'ssh_host_alias_key.pub'))
    writeFileSync(path.join(root, 'sshd_config'), `HostKey ${custom}\nInclude ${external}/*\n`)
    const opened: string[] = []
    const original = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const name = String(args[0]); opened.push(name)
      if (name === custom || name === generatedPrivate) throw new Error('Private-key reader regression')
      return original(...args)
    })
    expect(await readSshHostKeyFingerprints([root])).toEqual([fp])
    expect(opened).not.toContain(custom)
    expect(opened).not.toContain(generatedPrivate)
  })

  it('excludes declared relative private names from lexical and canonical Include targets without anchoring them', async () => {
    const root = tempDir()
    const external = tempDir()
    const lexical = tempDir()
    const keys = tempDir()
    const [valid, fp] = publicKey(keys, 'valid')
    const [decoy] = publicKey(keys, 'decoy')
    const custom = path.join(external, 'custom-host')
    const dotted = path.join(external, 'normalized-host')
    const lexicalTarget = path.join(keys, 'lexical-target.conf')
    // These are synthetic sentinels, never real host keys. Their declaration does not establish
    // sshd's launch directory, so matching names must be excluded rather than resolved as anchors.
    writeFileSync(custom, 'SYNTHETIC PRIVATE HOSTKEY SENTINEL\n')
    writeFileSync(dotted, 'SYNTHETIC DOT/PARENT HOSTKEY SENTINEL\n')
    writeFileSync(lexicalTarget, `HostKey ${decoy}\n`)
    symlinkSync(custom, path.join(external, '00-alias.conf'))
    // A lexical name match is excluded even when its current symlink resolves somewhere else.
    symlinkSync(lexicalTarget, path.join(lexical, 'custom-host'))
    writeFileSync(path.join(root, 'sshd_config'), [
      'HOSTKEY="keys/../custom-host"',
      'HostKey ./parent/../normalized-host',
      `HostKey ${valid}`,
      `Include ${external}/* ${lexical}/*`
    ].join('\n'))
    const opened: string[] = []
    const original = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      opened.push(String(args[0]))
      return original(...args)
    })
    const found = await readSshHostKeyFingerprints([root])
    expect(opened).not.toContain(custom)
    expect(opened).not.toContain(dotted)
    expect(opened).not.toContain(lexicalTarget)
    expect(found).toEqual([fp])
  })

  it('keeps custom public declarations readable while relative public names remain unanchored', async () => {
    const root = tempDir()
    const external = tempDir()
    const keys = tempDir()
    const [relative, relativeFp] = publicKey(external, 'custom-public')
    const [absolute, absoluteFp] = publicKey(keys, 'agent-held')
    const [valid, validFp] = publicKey(keys, 'valid')
    const relativePublic = relative + '.pub'
    // Neither the config root nor a matching Include establishes the daemon's HostKey base.
    publicKey(root, 'custom-public')
    writeFileSync(path.join(root, 'sshd_config'), [
      'HostKey keys/../custom-public.pub',
      `HostKey ${absolute}.pub`,
      `HostKey ${valid}`,
      `Include ${external}/*.pub`
    ].join('\n'))
    const opened: string[] = []
    const original = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      opened.push(String(args[0]))
      return original(...args)
    })
    const found = await readSshHostKeyFingerprints([root])
    expect(found).toEqual([absoluteFp, validFp])
    expect(found).not.toContain(relativeFp)
    expect(opened).toContain(relativePublic)
  })

  it('bounds relative HostKey declarations before visiting any more Includes', async () => {
    const root = tempDir()
    const external = tempDir()
    const [valid, fp] = publicKey(tempDir(), 'valid')
    const [late] = publicKey(tempDir(), 'late')
    const included = path.join(external, 'after-overflow.conf')
    writeFileSync(included, `HostKey ${late}\n`)
    const relative = Array.from({ length: SSH_HOST_KEY_DISCOVERY_LIMITS.publicFiles }, (_, i) => `HostKey keys/relative-${i}\n`).join('')
    writeFileSync(path.join(root, 'sshd_config'), `HostKey ${valid}\n${relative}Include ${included}\n`)
    const opened: string[] = []
    const original = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      opened.push(String(args[0]))
      return original(...args)
    })
    expect(await readSshHostKeyFingerprints([root])).toEqual([fp])
    expect(opened).not.toContain(included)
  })

  it.skipIf(process.platform === 'win32')('never blocks if a config or public file becomes a FIFO between stat and open', async () => {
    const root = tempDir()
    const external = tempDir()
    const [key, fp] = publicKey(external, 'valid')
    const pipes = [path.join(root, 'ssh_host_fifo_key.pub'), path.join(external, 'blocked.conf')]
    execFileSync('mkfifo', pipes)
    writeFileSync(path.join(root, 'sshd_config'), `HostKey ${key}\nInclude ${pipes[1]}\n`)
    const original = fs.stat.bind(fs)
    vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      const result = await original(...args)
      // Model a regular file that is replaced after the path stat. FileHandle.stat still sees
      // the real FIFO, and O_NONBLOCK must let it reach that check without waiting for a writer.
      if (result && pipes.includes(String(args[0]))) {
        result.isFile = () => true
        result.size = typeof result.size === 'bigint' ? 0n : 0
      }
      return result
    })
    const work = readSshHostKeyFingerprints([root])
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await expect(Promise.race([work, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('FIFO discovery exceeded its bounded wait')), 500)
      })])).resolves.toEqual([fp])
    } finally {
      clearTimeout(timeout)
      // A broken nonblocking mutant still has only these disposable FIFOs. Supply writers long
      // enough to release both opens, then await its cleanup so no test thread is left blocked.
      const writers = pipes.map((pipe) => openSync(pipe, constants.O_RDWR | constants.O_NONBLOCK))
      try { await work } finally { writers.forEach(closeSync) }
    }
  })

  it('skips oversized, unreadable, malformed and nonmatching Includes without losing readable keys', async () => {
    const root = tempDir()
    const external = tempDir()
    const [valid, fp] = publicKey(external, 'valid')
    const [tooLargeKey] = publicKey(external, 'too-large')
    const oversized = path.join(external, '00-large.conf')
    const denied = path.join(external, '10-denied.conf')
    writeFileSync(oversized, `HostKey ${tooLargeKey}\n` + ' '.repeat(256 * 1024))
    writeFileSync(denied, `HostKey ${valid}\n`)
    writeFileSync(path.join(external, '20-valid.conf'), `HostKey ${valid}\n`)
    mkdirSync(path.join(external, '30-directory.conf'))
    writeFileSync(path.join(root, 'sshd_config'), `Include ${external}/*.conf ${external}/none*.conf ${external}/[z-a].conf\n`)
    const original = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === denied) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return original(...args)
    })
    expect(await readSshHostKeyFingerprints([root])).toEqual([fp])
  })

  it('stops a deeply nested Include chain before its late key', async () => {
    const root = tempDir()
    const external = tempDir()
    const [near, nearFp] = publicKey(external, 'near')
    const [late] = publicKey(external, 'late')
    writeFileSync(path.join(root, 'sshd_config'), `HostKey ${near}\nInclude ${external}/0.conf\n`)
    for (let i = 0; i <= SSH_HOST_KEY_DISCOVERY_LIMITS.depth; i++) {
      writeFileSync(path.join(external, `${i}.conf`), i === SSH_HOST_KEY_DISCOVERY_LIMITS.depth
        ? `HostKey ${late}\n` : `Include ${external}/${i + 1}.conf\n`)
    }
    expect(await readSshHostKeyFingerprints([root])).toEqual([nearFp])
  })

  it('bounds config attempts, including a wide Include tree', async () => {
    const root = tempDir()
    const external = tempDir()
    const [late] = publicKey(external, 'late')
    writeFileSync(path.join(root, 'sshd_config'), `Include ${external}/*.conf\n`)
    for (let i = 0; i < SSH_HOST_KEY_DISCOVERY_LIMITS.configFiles; i++) {
      writeFileSync(path.join(external, `${String(i).padStart(4, '0')}.conf`), i === SSH_HOST_KEY_DISCOVERY_LIMITS.configFiles - 1 ? `HostKey ${late}\n` : '# empty\n')
    }
    expect(await readSshHostKeyFingerprints([root])).toEqual([])
  })

  it('bounds total config bytes independently of each individual file limit', async () => {
    const root = tempDir()
    const external = tempDir()
    const [late] = publicKey(external, 'late')
    const config = `Include ${external}/*.conf\n`
    writeFileSync(path.join(root, 'sshd_config'), config)
    for (let i = 0; i < 4; i++) {
      const bytes = 256 * 1024 - (i === 3 ? Buffer.byteLength(config) : 0)
      writeFileSync(path.join(external, `${i}.conf`), ' '.repeat(bytes))
    }
    writeFileSync(path.join(external, 'late.conf'), `HostKey ${late}\n`)
    expect(await readSshHostKeyFingerprints([root])).toEqual([])
  })

  it('bounds the directory scan rather than walking a huge Include tree', async () => {
    const root = tempDir()
    const external = tempDir()
    const [late] = publicKey(external, 'late')
    writeFileSync(path.join(root, 'sshd_config'), `Include ${external}/*.conf\n`)
    for (let i = 0; i < SSH_HOST_KEY_DISCOVERY_LIMITS.directoryEntries; i++) writeFileSync(path.join(external, `${i}.conf`), i === 0 ? `HostKey ${late}\n` : '# empty\n')
    writeFileSync(path.join(external, 'late.conf'), `HostKey ${late}\n`)
    expect(await readSshHostKeyFingerprints([root])).toEqual([])
  })

  it('bounds invalid public-key candidates before the final unique-anchor cap', async () => {
    const root = tempDir()
    for (let i = 0; i < SSH_HOST_KEY_DISCOVERY_LIMITS.publicFiles; i++) writeFileSync(path.join(root, `ssh_host_${String(i).padStart(4, '0')}_key.pub`), 'invalid\n')
    writeFileSync(path.join(root, 'ssh_host_z_key.pub'), ed25519Line() + '\n')
    expect(await readSshHostKeyFingerprints([root])).toEqual([])
  })

  it('deduplicates and bounds HostKey canonicalization before following more Includes', async () => {
    const root = tempDir()
    const external = tempDir()
    const [valid, fp] = publicKey(external, 'valid')
    const config = path.join(root, 'sshd_config')
    const canonicalized: string[] = []
    const original = fs.realpath.bind(fs)
    vi.spyOn(fs, 'realpath').mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      canonicalized.push(String(args[0]))
      return original(...args)
    })
    const repeatedInclude = path.join(external, 'repeated.conf')
    writeFileSync(repeatedInclude, `HostKey ${valid}\n`.repeat(1000))
    writeFileSync(config, `HostKey ${valid}\n`.repeat(1000) + `Include ${repeatedInclude}\n`)
    expect(await readSshHostKeyFingerprints([root])).toEqual([fp])
    expect(canonicalized.filter((name) => name === valid)).toHaveLength(1)

    canonicalized.length = 0
    const paths = Array.from({ length: SSH_HOST_KEY_DISCOVERY_LIMITS.publicFiles }, (_, i) => path.join(external, `key-${i}`))
    const included = path.join(external, 'after-overflow.conf')
    writeFileSync(included, `HostKey ${valid}\n`)
    writeFileSync(config, paths.map((key) => `HostKey ${key}\n`).join('') + `HostKey ${valid}\nInclude ${included}\n`)
    expect(await readSshHostKeyFingerprints([root])).toEqual([])
    expect(canonicalized.filter((name) => paths.includes(name))).toHaveLength(SSH_HOST_KEY_DISCOVERY_LIMITS.publicFiles)
    expect(canonicalized).not.toContain(valid)
    expect(canonicalized).not.toContain(included)
  })
})

describe('sshFingerprintOfPublicKeyLine', () => {
  it('prints what OpenSSH prints: SHA256 of the key blob, unpadded base64', () => {
    expect(sshFingerprintOfPublicKeyLine(`${GITHUB_ED25519} root@github\n`)).toBe(GITHUB_ED25519_FP)
    expect(sshFingerprintOfPublicKeyLine(GITHUB_ECDSA)).toBe(GITHUB_ECDSA_FP)
    // A comment line and a blank line before the key, and CRLF, change nothing.
    expect(sshFingerprintOfPublicKeyLine(`# host key\r\n\r\n${GITHUB_ED25519}\r\n`)).toBe(GITHUB_ED25519_FP)
  })

  it('refuses what is not a plain public key', () => {
    const [, blob] = GITHUB_ED25519.split(' ')
    // The line says one type and the blob another: it is not the key it claims to be.
    expect(sshFingerprintOfPublicKeyLine(`ssh-rsa ${blob}`)).toBeNull()
    expect(sshFingerprintOfPublicKeyLine(`ssh-ed25519-cert-v01@openssh.com ${blob}`)).toBeNull()
    expect(sshFingerprintOfPublicKeyLine('ssh-ed25519 not*base64')).toBeNull()
    expect(sshFingerprintOfPublicKeyLine('ssh-ed25519')).toBeNull()
    expect(sshFingerprintOfPublicKeyLine('ssh-ed25519 AAAA')).toBeNull()
    expect(sshFingerprintOfPublicKeyLine('')).toBeNull()
  })
})

describe('hostKeyPathsInSshdConfig', () => {
  it('reads every absolute HostKey, in both keyword forms and quoted', () => {
    const text = [
      '# HostKey /etc/ssh/commented_out',
      'HostKey /etc/ssh/ssh_host_ed25519_key',
      '  hostkey=/opt/keys/a_key',
      'HOSTKEY "/opt/keys/with space_key"',
      'HostKey relative_key',
      'HostKey /home/%u/token_key',
      'HostKeyAlgorithms ssh-ed25519',
      'Port 22'
    ].join('\n')
    expect(hostKeyPathsInSshdConfig(text)).toEqual([
      '/etc/ssh/ssh_host_ed25519_key',
      '/opt/keys/a_key',
      '/opt/keys/with space_key'
    ])
  })
})

describe('readSshHostKeyFingerprints', () => {
  it('reads every ssh_host_*_key.pub in the directories, and nothing else there', async () => {
    const etcSsh = tempDir()
    const etc = tempDir()
    writeFileSync(path.join(etcSsh, 'ssh_host_ed25519_key.pub'), `${GITHUB_ED25519} root@box\n`)
    writeFileSync(path.join(etcSsh, 'ssh_host_ecdsa_key.pub'), `${GITHUB_ECDSA} root@box\n`)
    // A certificate, a private key, a user key and a key under another name are not host public keys.
    writeFileSync(path.join(etcSsh, 'ssh_host_ed25519_key-cert.pub'), `${ed25519Line()}\n`)
    writeFileSync(path.join(etcSsh, 'ssh_host_ed25519_key'), '-----BEGIN OPENSSH PRIVATE KEY-----\n')
    writeFileSync(path.join(etcSsh, 'id_ed25519.pub'), `${ed25519Line()}\n`)
    // The old macOS place (/etc), the same key again: listed once.
    writeFileSync(path.join(etc, 'ssh_host_ed25519_key.pub'), `${GITHUB_ED25519} root@old-mac\n`)
    expect(await readSshHostKeyFingerprints([etcSsh, etc])).toEqual([GITHUB_ECDSA_FP, GITHUB_ED25519_FP])
  })

  it('adds the keys sshd_config and its drop-ins name elsewhere', async () => {
    const etcSsh = tempDir()
    const keys = tempDir()
    const own = ed25519Line()
    const agentHeld = ed25519Line()
    const unsuffixed = ed25519Line()
    writeFileSync(path.join(keys, 'custom_key.pub'), `${own}\n`)
    writeFileSync(path.join(keys, 'agent_key.pub'), `${agentHeld}\n`)
    writeFileSync(path.join(keys, 'other_key.pub'), `${unsuffixed}\n`)
    writeFileSync(path.join(etcSsh, 'sshd_config'), `HostKey ${path.join(keys, 'custom_key')}\n`)
    mkdirSync(path.join(etcSsh, 'sshd_config.d'))
    // A public key named directly (sshd takes one when the private key is held by an agent).
    writeFileSync(path.join(etcSsh, 'sshd_config.d', '10-agent.conf'), `HostKey ${path.join(keys, 'agent_key.pub')}\n`)
    // A drop-in without the `.conf` suffix: sshd reads it when its Include globs the whole directory,
    // and a key it serves from there must be named, or the phone refuses SSH (review of A49-anchor).
    writeFileSync(path.join(etcSsh, 'sshd_config.d', '20-keys'), `HostKey ${path.join(keys, 'other_key')}\n`)
    // A drop-in naming a key that is not there, and a directory among them: nothing, and no failure.
    writeFileSync(path.join(etcSsh, 'sshd_config.d', '30-missing.conf'), `HostKey ${path.join(keys, 'nope')}\n`)
    mkdirSync(path.join(etcSsh, 'sshd_config.d', '40-dir'))
    expect(await readSshHostKeyFingerprints([etcSsh])).toEqual([
      sshFingerprintOfPublicKeyLine(own),
      sshFingerprintOfPublicKeyLine(agentHeld),
      sshFingerprintOfPublicKeyLine(unsuffixed)
    ])
  })

  it('leaves out what cannot be read, and gives an empty list when nothing can', async () => {
    const etcSsh = tempDir()
    // Not a regular file, too large to be a key, and not a key at all.
    mkdirSync(path.join(etcSsh, 'ssh_host_dir_key.pub'))
    writeFileSync(path.join(etcSsh, 'ssh_host_big_key.pub'), `${GITHUB_ED25519} ${'x'.repeat(20_000)}\n`)
    writeFileSync(path.join(etcSsh, 'ssh_host_junk_key.pub'), 'not a key\n')
    writeFileSync(path.join(etcSsh, 'sshd_config'), 'HostKey /nonexistent/nt-test/missing_key\n')
    expect(await readSshHostKeyFingerprints([etcSsh, path.join(etcSsh, 'no-such-dir')])).toEqual([])
    // …and a readable key beside them is still read.
    writeFileSync(path.join(etcSsh, 'ssh_host_ok_key.pub'), `${GITHUB_ED25519}\n`)
    expect(await readSshHostKeyFingerprints([etcSsh])).toEqual([GITHUB_ED25519_FP])
  })

  it('stops at the cap', async () => {
    const etcSsh = tempDir()
    for (let i = 0; i < MAX_SSH_HOST_KEYS + 4; i++) {
      writeFileSync(path.join(etcSsh, `ssh_host_k${String(i).padStart(2, '0')}_key.pub`), `${ed25519Line()}\n`)
    }
    expect(await readSshHostKeyFingerprints([etcSsh])).toHaveLength(MAX_SSH_HOST_KEYS)
  })
})
