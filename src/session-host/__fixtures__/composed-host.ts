// Actual standalone host + client transport, with only node-pty replaced by a byte recorder.
// This proves protocol/emulator behavior; it does not claim native ConPTY or live CLI acceptance.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { build } from 'esbuild'
import { sessionHostPaths } from '../paths'
import { readExistingSessionHostIdentity } from '../existing-host-state'
import { LineFramer, encodeFrame, SESSION_HOST_PROTOCOL_VERSION, type SessionHostRequestBody,
  type SessionHostResponse, type SessionHostFrame, type SessionHostSpawnOptions } from '../protocol'

export const composedRecorderPlugin = {
  name: 'explicit-composed-native-recorder',
  setup(bundle: import('esbuild').PluginBuild) {
    bundle.onResolve({ filter: /^node-pty$/ }, () => ({ path: path.join(process.cwd(), 'src/session-host/__fixtures__/composed-native-recorder.ts') }))
  }
} satisfies import('esbuild').Plugin

export async function bundleComposedHost(outfile: string): Promise<import('esbuild').Metafile> {
  const result = await build({ absWorkingDir: process.cwd(), entryPoints: ['src/session-host/host.ts'],
    bundle: true, platform: 'node', format: 'cjs', outfile, plugins: [composedRecorderPlugin], metafile: true, logLevel: 'silent' })
  return result.metafile!
}

export async function bootComposedHost(root: string, bundlePath?: string, mode = 'on') {
  const dataDir = path.join(root, 'host-data'), logPath = path.join(root, 'native-writes.jsonl')
  fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(logPath, '', { mode: 0o600 })
  const bundle = bundlePath ?? path.join(root, 'host.cjs')
  if (!bundlePath) await bundleComposedHost(bundle)
  const child = spawn(process.execPath, [bundle, dataDir], { cwd: process.cwd(), stdio: 'ignore', windowsHide: true })
  const paths = sessionHostPaths(dataDir)
  try {
    let identity: ReturnType<typeof readExistingSessionHostIdentity> | undefined
    for (let i = 0; i < 200; i++) {
      // The actual state publisher reserves its file before writing bytes. This private startup
      // wait may see that incomplete publication; admission still requires the full real reader.
      try { identity = readExistingSessionHostIdentity(paths.statePath, { expectedEndpoint: paths.endpoint, expectedTokenPath: paths.tokenPath }) }
      catch { identity = undefined }
      if (identity?.kind === 'ready') break
      if (child.exitCode !== null) throw new Error('fixture host exited before admission')
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    if (identity?.kind !== 'ready') throw new Error('fixture host did not become ready')
    const sockets: net.Socket[] = []
    const connect = async (features: string[] = ['composed-input-v1']) => {
      const socket = net.connect(identity.state.endpoint); sockets.push(socket)
      const frames = new LineFramer(), received = new Map<number, SessionHostResponse>()
      const pending = new Map<number, (frame: SessionHostResponse) => void>()
      socket.on('data', (chunk: Buffer) => { for (const frame of frames.push<SessionHostFrame>(chunk.toString('utf8'))) {
        if (!('id' in frame)) continue
        const done = pending.get(frame.id); if (done) { pending.delete(frame.id); done(frame) } else received.set(frame.id, frame)
      } })
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
      let id = 0
      const rpc = async (request: SessionHostRequestBody): Promise<SessionHostResponse> => {
        const next = ++id
        const answer = new Promise<SessionHostResponse>((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(next); reject(new Error('fixture RPC deadline')) }, 4000)
          pending.set(next, (frame) => { clearTimeout(timer); resolve(frame) })
        })
        socket.write(encodeFrame({ id: next, ...request }))
        const early = received.get(next); if (early) { received.delete(next); pending.get(next)?.(early); pending.delete(next) }
        return answer
      }
      const hello = await rpc({ cmd: 'hello', protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
        token: identity.token, features: features as import('../protocol').SessionHostFeature[] })
      return { socket, rpc, hello }
    }
    const spawnOptions: SessionHostSpawnOptions = { cwd: root, shell: 'fixture-recorder', args: [],
      env: { NT_COMPOSED_WRITE_LOG: logPath, NT_COMPOSED_MODE: mode }, cols: 80, rows: 24 }
    const writes = (): Array<{ data: string; at: number }> => fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((row) => JSON.parse(row))
    return { child, dataDir, paths, spawnOptions, connect, writes, async close() {
      sockets.forEach((socket) => socket.destroy()); await stopComposedHost(child)
      if (process.platform !== 'win32') fs.rmSync(paths.endpoint, { force: true })
    } }
  } catch (error) { await stopComposedHost(child); throw error }
}

async function stopComposedHost(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}
