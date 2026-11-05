import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setCodexThreadIdentityAuthSecret, resetCodexThreadIdentityAuthSecret, serializeCodexThreadIdentity, verifyCodexThreadIdentityText } from '../../core/codex-identity-proxy'
import type { ExecResult } from '../../core/remote-ssh/native/native-mux'
import type { NativeSshTransport } from '../../core/remote-ssh/native/existing-transport'
import { publishObservedCodexBinding, publishObservedNodeToken, type ObservedCodexBinding } from './observed-codex-binding'

let home: string, binding: ObservedCodexBinding, transport: NativeSshTransport, live: boolean
const record = () => path.join(home, '.nodeterm/codex-thread-nodes/thread-one')
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "observed-home-' "))
  chmodSync(home, 0o700)
  live = true
  binding = { remoteHome: home, threadId: 'thread-one', nodeId: 'node-one', hookEndpoint: '/synthetic/remote/hook.env', accountId: 'system' }
  setCodexThreadIdentityAuthSecret(Buffer.alloc(32, 19))
  transport = {
    identity: Object.freeze({ backend: 'native-ssh2', generation: 'synthetic-generation', hostname: 'synthetic-host', user: 'synthetic-user', port: 22, serverKeySha256: 'synthetic-key' }),
    isCurrent: () => live,
    exec: vi.fn((command, io) => new Promise<ExecResult>((resolve, reject) => {
      const proc = spawn('/bin/sh', ['-c', command], { env: { HOME: home, PATH: '/usr/bin:/bin' }, stdio: ['pipe','pipe','pipe'] })
      const stdout: Buffer[] = [], stderr: Buffer[] = []
      proc.stdout.on('data', b => stdout.push(b)); proc.stderr.on('data', b => stderr.push(b))
      proc.once('error', reject)
      proc.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut: false }))
      proc.stdin.end(io?.stdin)
    }))
  }
})
afterEach(() => { resetCodexThreadIdentityAuthSecret(); rmSync(home, { recursive: true, force: true }) })

describe.skipIf(process.platform === 'win32')('observed remote signed metadata publication (real private filesystem)', () => {
  it('provisions an absent per-node capability through stdin, returns no credential bytes, and preserves foreign tokens', async () => {
    const token = 'syntheti.' + 'a'.repeat(43), file = path.join(home, '.nodeterm/node-tokens/node-one')
    await publishObservedNodeToken(transport, { remoteHome: home, nodeId: 'node-one', token }, async () => true)
    expect(readFileSync(file, 'utf8')).toBe(token + '\n')
    for (const call of vi.mocked(transport.exec).mock.calls) expect(call[0]).not.toContain(token)
    for (const result of vi.mocked(transport.exec).mock.results) {
      const reply = await result.value
      expect(reply.stdout.toString()).not.toContain(token)
    }
    await publishObservedNodeToken(transport, { remoteHome: home, nodeId: 'node-one', token }, async () => true)
    await expect(publishObservedNodeToken(transport, { remoteHome: home, nodeId: 'node-one', token: 'another1.' + 'b'.repeat(43) }, async () => true)).rejects.toThrow('conflicts')
    expect(readFileSync(file, 'utf8')).toBe(token + '\n')
  })
  it('publishes verified account-scoped data through the captured runner, with no grant side effect', async () => {
    await publishObservedCodexBinding(transport, binding, async () => true)
    expect(verifyCodexThreadIdentityText(binding.threadId, readFileSync(record(), 'utf8'))).toMatchObject({ nodeId: binding.nodeId, agentId: 'codex', hookEndpoint: binding.hookEndpoint, accountId: '' })
    const calls = vi.mocked(transport.exec).mock.calls.length
    await publishObservedCodexBinding(transport, binding, async () => true)
    expect(vi.mocked(transport.exec).mock.calls.length - calls).toBe(1)
    expect(existsSync(path.join(home, '.nodeterm/codex-thread-nodes/writer.lock'))).toBe(false)
  })
  it('keeps managed accounts separate and refreshes only this signed node endpoint', async () => {
    const managed = { ...binding, accountId: 'account-one' }
    await publishObservedCodexBinding(transport, managed, async () => true)
    const file = path.join(home, '.nodeterm/codex-thread-nodes/account-one/thread-one')
    await publishObservedCodexBinding(transport, { ...managed, hookEndpoint: '/synthetic/remote/other.env' }, async () => true)
    expect(verifyCodexThreadIdentityText(binding.threadId, readFileSync(file, 'utf8'), 'account-one')?.hookEndpoint).toBe('/synthetic/remote/other.env')
    expect(existsSync(record())).toBe(false)
  })
  for (const existing of ['foreign', 'unsigned', 'legacy'] as const) {
    it(`preserves ${existing} thread metadata`, async () => {
      mkdirSync(path.dirname(record()), { recursive: true, mode: 0o700 })
      const value = existing === 'unsigned' ? 'nodeId=node-one\n' : serializeCodexThreadIdentity('thread-one', existing === 'foreign' ? 'other-node' : 'node-one', binding.hookEndpoint, undefined,
        existing === 'legacy' ? undefined : { agentId: 'codex', canvasControl: true })
      writeFileSync(record(), value, { mode: 0o600 })
      await expect(publishObservedCodexBinding(transport, binding, async () => true)).rejects.toThrow('conflicts')
      expect(readFileSync(record(), 'utf8')).toBe(value)
    })
  }
  it('refuses linked metadata and preserves the link target', async () => {
    const target = path.join(home, 'foreign-data');writeFileSync(target, 'preserve', { mode: 0o600 })
    mkdirSync(path.dirname(record()), { recursive: true, mode: 0o700 });symlinkSync(target, record())
    await expect(publishObservedCodexBinding(transport, binding, async () => true)).rejects.toThrow('unavailable')
    expect(readFileSync(target, 'utf8')).toBe('preserve')
  })
  it('preserves a concurrent foreign publication instead of overwriting after the read', async () => {
    const original = vi.mocked(transport.exec).getMockImplementation()!
    vi.mocked(transport.exec).mockImplementationOnce(async (command, io) => {
      const reply = await original(command, io)
      mkdirSync(path.dirname(record()), { recursive: true, mode: 0o700 })
      writeFileSync(record(), 'concurrent-foreign-data', { mode: 0o600 })
      return reply
    })
    await expect(publishObservedCodexBinding(transport, binding, async () => true)).rejects.toThrow('unavailable')
    expect(readFileSync(record(), 'utf8')).toBe('concurrent-foreign-data')
  })
  it('refuses an unresolved writer and permissive metadata file', async () => {
    mkdirSync(path.dirname(record()), { recursive: true, mode: 0o700 })
    const lock = path.join(path.dirname(record()), 'writer.lock')
    writeFileSync(lock, 'unresolved-writer', { mode: 0o600 })
    await expect(publishObservedCodexBinding(transport, binding, async () => true)).rejects.toThrow('unavailable')
    rmSync(lock)
    writeFileSync(record(), 'preserve', { mode: 0o600 });chmodSync(record(), 0o644)
    await expect(publishObservedCodexBinding(transport, binding, async () => true)).rejects.toThrow('unavailable')
    expect(readFileSync(record(), 'utf8')).toBe('preserve')
  })
  it('does not create directories when the observed context is missing', async () => {
    await expect(publishObservedCodexBinding(transport, binding, async () => false)).rejects.toThrow('changed')
    expect(transport.exec).not.toHaveBeenCalled(); expect(existsSync(record())).toBe(false)
  })
  it('refuses a changed transport after the read and before any write', async () => {
    let reads = 0
    await expect(publishObservedCodexBinding(transport, binding, async () => { reads++; if (reads === 2) live = false; return true })).rejects.toThrow('unavailable')
    expect(transport.exec).toHaveBeenCalledTimes(1);expect(existsSync(record())).toBe(false)
  })
})
