import {
  ANDROID_BUTTON_KEYS,
  ANDROID_ROTATION_Z,
  type SimulatorFrame,
  type SimulatorInput,
  type SimulatorStatusEvent
} from '../../shared/simulator'
import {
  EmulatorClient,
  IMAGE_PNG,
  KEY_DOWN,
  KEY_PRESS,
  KEY_UP,
  decodeImage,
  imageFormat,
  namedKeyEvent,
  rotationModel,
  touchEvent,
  usbKeyEvent
} from './android-grpc'
import { findRunning, listAvds } from './android-sdk'

/**
 * An Android virtual device on the canvas: frames streamed from the emulator's gRPC interface,
 * touches / keys / buttons / rotation sent back over the same connection. The Android twin of the
 * iOS helper in simulator-service.ts, behind the same node-facing events.
 *
 * MEASURED (emulator 36.6.11, Pixel 9, macOS): PNG frames fitted into a 1616-pixel box run at about
 * 25 fps while the screen moves and cost nothing while it is still (the stream sends a frame only on
 * change). The requested size is a bounding box the frame is fitted into, so a SQUARE box serves
 * both orientations and a rotation never needs a new stream.
 */

/** The shortest side frames are scaled to (the iOS helper's is 900 at JPEG; PNG costs more). */
const FRAME_SHORT_SIDE = 720
const RETRY_MS = 1000
const MAX_RETRIES = 30

export interface AndroidHooks {
  frame(nodeId: string, f: SimulatorFrame): void
  status(nodeId: string, e: SimulatorStatusEvent): void
}

interface Session {
  avd: string
  nodes: Set<string>
  client: EmulatorClient | null
  cancelStream: (() => void) | null
  /** Portrait panel size in pixels: touches are sent in this space. */
  panel: { w: number; h: number }
  stopping: boolean
  ready: boolean
  displays: SimulatorStatusEvent | null
  retries: number
  /** Inputs wait here so they reach the emulator in order, one call at a time. */
  queue: SimulatorInput[]
  sending: boolean
  hooks: AndroidHooks
  /** The square box frames are fitted into (see the header). */
  box: number
}

const sessions = new Map<string, Session>()
const nodeAvd = new Map<string, string>()

export function androidNodeAvd(nodeId: string): string | undefined {
  return nodeAvd.get(nodeId)
}

export async function startAndroid(nodeId: string, avd: string, hooks: AndroidHooks): Promise<{ ok: true } | { ok: false; error: string }> {
  const live = sessions.get(avd)
  if (live && !live.stopping) {
    live.nodes.add(nodeId)
    nodeAvd.set(nodeId, avd)
    if (live.displays) hooks.status(nodeId, live.displays)
    if (live.ready) hooks.status(nodeId, { kind: 'ready' })
    return { ok: true }
  }
  const running = await findRunning(avd)
  if (!running?.endpoint) return { ok: false, error: 'This Android device is not running — Boot it to see its screen.' }
  const info = (await listAvds()).find((a) => a.name === avd)
  const w = info?.lcdWidth ?? 1080
  const h = info?.lcdHeight ?? 2400
  const panel = { w: Math.min(w, h), h: Math.max(w, h) }
  const s: Session = {
    avd,
    nodes: new Set([nodeId]),
    client: null,
    cancelStream: null,
    panel,
    stopping: false,
    ready: false,
    displays: {
      kind: 'displays',
      displays: [{ index: 0, width: panel.w, height: panel.h, name: 'Screen', screenID: 0, ...(info?.density ? { scale: info.density / 160 } : {}) }],
      active: 0,
      pinned: false
    },
    retries: 0,
    queue: [],
    sending: false,
    hooks,
    box: Math.round(panel.h * Math.min(1, FRAME_SHORT_SIDE / panel.w))
  }
  sessions.set(avd, s)
  nodeAvd.set(nodeId, avd)
  hooks.status(nodeId, s.displays!)
  connect(s, running.endpoint, hooks)
  return { ok: true }
}

function each(s: Session, fn: (id: string) => void): void {
  for (const id of s.nodes) fn(id)
}

function connect(s: Session, endpoint: { port: number; token: string }, hooks: AndroidHooks): void {
  const client = new EmulatorClient(endpoint)
  s.client = client
  s.cancelStream = client.stream(
    'streamScreenshot',
    imageFormat(IMAGE_PNG, s.box, s.box),
    (msg) => {
      s.retries = 0
      if (!s.ready) {
        s.ready = true
        each(s, (id) => hooks.status(id, { kind: 'ready' }))
      }
      emitImage(s, msg)
    },
    (err) => {
      if (s.stopping || sessions.get(s.avd) !== s) return
      client.close()
      // The emulator restarting (Restart) or still coming up closes the stream: reconnect while it
      // is running, and say why once it is gone.
      setTimeout(() => void reconnect(s, hooks, err), RETRY_MS)
    }
  )
}

function emitImage(s: Session, msg: Buffer): void {
  const img = decodeImage(msg)
  if (!img || !img.width || !img.height) return
  const frame: SimulatorFrame = { width: img.width, height: img.height, display: 0, jpeg: new Uint8Array(img.image), mime: 'image/png' }
  each(s, (id) => s.hooks.frame(id, frame))
}

/**
 * One frame taken on demand. MEASURED: the stream sends a frame only when the guest's screen
 * changes, and turning a device whose app stays portrait (the launcher) changes nothing there — the
 * emulator turns the picture, not the guest — so after a rotation no frame would come until
 * something moved. Two shots, because the emulator applies the rotation a moment after the call.
 */
function refreshAfterRotation(s: Session): void {
  for (const delay of [350, 1200]) {
    setTimeout(() => {
      if (s.stopping || sessions.get(s.avd) !== s || !s.client || s.client.isClosed) return
      void s.client
        .unary('getScreenshot', imageFormat(IMAGE_PNG, s.box, s.box), 10_000)
        .then((msg) => emitImage(s, msg))
        .catch(() => undefined)
    }, delay)
  }
}

async function reconnect(s: Session, hooks: AndroidHooks, err?: Error): Promise<void> {
  if (s.stopping || sessions.get(s.avd) !== s) return
  const running = await findRunning(s.avd)
  if (running?.endpoint && s.retries++ < MAX_RETRIES) {
    connect(s, running.endpoint, hooks)
    return
  }
  sessions.delete(s.avd)
  const message = running ? `Lost the emulator's screen${err ? `: ${err.message}` : '.'}` : 'The emulator stopped.'
  each(s, (id) => {
    hooks.status(id, { kind: 'error', code: 'stream', message })
    hooks.status(id, { kind: 'exited', code: null, signal: null })
    if (nodeAvd.get(id) === s.avd) nodeAvd.delete(id)
  })
}

export function stopAndroid(nodeId: string): void {
  const avd = nodeAvd.get(nodeId)
  nodeAvd.delete(nodeId)
  const s = avd ? sessions.get(avd) : undefined
  if (!s) return
  s.nodes.delete(nodeId)
  if (s.nodes.size > 0) return
  s.stopping = true
  sessions.delete(s.avd)
  s.cancelStream?.()
  s.client?.close()
}

export function stopAllAndroid(): void {
  for (const id of [...nodeAvd.keys()]) stopAndroid(id)
}

/** Queue one input. A drag point still waiting is replaced by a newer one — only where the finger
 *  is NOW matters — while downs, ups and keys are never dropped. */
export function sendAndroidInput(nodeId: string, cmd: SimulatorInput): boolean {
  const avd = nodeAvd.get(nodeId)
  const s = avd ? sessions.get(avd) : undefined
  if (!s || !s.client || s.client.isClosed) return false
  const last = s.queue[s.queue.length - 1]
  if (cmd.t === 'move' && last?.t === 'move') s.queue[s.queue.length - 1] = cmd
  else s.queue.push(cmd)
  if (s.queue.length > 256) s.queue.splice(0, s.queue.length - 256)
  void drain(s)
  return true
}

async function drain(s: Session): Promise<void> {
  if (s.sending) return
  s.sending = true
  try {
    while (s.queue.length && s.client && !s.client.isClosed) {
      const cmd = s.queue.shift()!
      const call = inputCall(s, cmd)
      if (!call) continue
      const ok = await s.client.unary(call[0], call[1], 5_000).then(
        () => true,
        () => false
      )
      if (ok && cmd.t === 'orientation') refreshAfterRotation(s)
    }
  } finally {
    s.sending = false
  }
}

/** The gRPC call one input becomes, or null when it has none on Android. */
export function inputCall(s: Pick<Session, 'panel'>, cmd: SimulatorInput): [string, Buffer] | null {
  switch (cmd.t) {
    case 'down':
    case 'move':
      return ['sendTouch', touchEvent(cmd.x * (s.panel.w - 1), cmd.y * (s.panel.h - 1), 1024)]
    case 'up':
      return ['sendTouch', touchEvent(cmd.x * (s.panel.w - 1), cmd.y * (s.panel.h - 1), 0)]
    case 'key':
      return ['sendKey', usbKeyEvent(cmd.usage, cmd.down ? KEY_DOWN : KEY_UP)]
    case 'button': {
      const key = ANDROID_BUTTON_KEYS[cmd.name]
      return key ? ['sendKey', namedKeyEvent(key, KEY_PRESS)] : null
    }
    case 'orientation': {
      const z = ANDROID_ROTATION_Z[cmd.value]
      return z === undefined ? null : ['setPhysicalModel', rotationModel(z)]
    }
    default:
      return null
  }
}

/** One call on a running emulator, for the ⋯ menu (opens its own connection when no node shows it). */
export async function androidUnary(avd: string, method: string, body: Buffer, timeoutMs = 15_000): Promise<Buffer> {
  const live = sessions.get(avd)
  if (live?.client && !live.client.isClosed) return live.client.unary(method, body, timeoutMs)
  const running = await findRunning(avd)
  if (!running?.endpoint) throw new Error('This Android device is not running.')
  const client = new EmulatorClient(running.endpoint)
  try {
    return await client.unary(method, body, timeoutMs)
  } finally {
    client.close()
  }
}
