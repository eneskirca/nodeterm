/**
 * Renderer-side microphone capture: mono 16 kHz PCM via an AudioWorklet,
 * with a ScriptProcessorNode fallback for engines that reject
 * `audioWorklet.addModule` (older/atypical Chromium builds, or a CSP that
 * somehow blocks it).
 *
 * Kept free of React and of any top-level browser-API references so
 * `concatChunks` stays importable (and testable) under plain Node — only
 * `PcmCapture`'s methods touch `navigator`/`AudioContext`/etc.
 *
 * Deliberately does NOT import `./pcm-worklet` — that file calls the
 * worklet-global `registerProcessor(...)` at module scope, which only
 * exists inside an AudioWorkletGlobalScope. Importing it here would run
 * that call in the renderer's normal window scope (ReferenceError) and,
 * worse, under this module's own Node-based unit test. The worklet is
 * instead loaded indirectly by URL (see `startWorklet`), and its processor
 * name is duplicated as a plain string constant below.
 */

import { micErrorMessage, micPlatform, type MicPlatform } from './micPermission'

/** Must match `PCM_WORKLET_NAME` in `./pcm-worklet.ts` (not imported — see file header). */
const WORKLET_PROCESSOR_NAME = 'pcm-capture'

const CAPTURE_SAMPLE_RATE = 16000
/** Buffer size for the `ScriptProcessorNode` fallback; 4096 frames @ 16 kHz ≈ 256 ms per chunk. */
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096


/** Concatenates PCM chunks, in order, into one buffer. Pure — no side effects. */
export function concatChunks(chunks: Float32Array[]): Float32Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** RMS of a chunk, clamped to [0, 1] (samples are already in [-1, 1], so RMS can't exceed 1). */
function rms(chunk: Float32Array): number {
  if (chunk.length === 0) return 0
  let sumSquares = 0
  for (let i = 0; i < chunk.length; i++) sumSquares += chunk[i] * chunk[i]
  return Math.min(1, Math.sqrt(sumSquares / chunk.length))
}

/**
 * Captures the default microphone as mono 16 kHz PCM until `stop()`.
 * `teardown()` resets to constructor state, so a fresh `start()` after
 * `stop()`/`cancel()` is fully supported — including one that landed while an
 * earlier `start()` was still opening the microphone (see `generation`).
 */
export class PcmCapture {
  /** Which platform's denial copy to show; injectable so tests can pin each one. */
  constructor(private readonly platform: () => MicPlatform = micPlatform) {}

  private chunks: Float32Array[] = []
  private lastChunk: Float32Array = new Float32Array(0)
  private running = false

  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private scriptNode: ScriptProcessorNode | null = null
  /** Silent sink the ScriptProcessorNode fallback routes through — see `startScriptProcessor`. */
  private scriptSink: GainNode | null = null
  /**
   * Bumped by every `teardown()`. A `start()` remembers the value it began with and, after each
   * await, gives up if it moved: `stop()`/`cancel()` landed while the microphone was still
   * opening. That window is routine — getUserMedia + the AudioContext + the worklet module take
   * hundreds of ms (seconds when a Bluetooth headset switches profile), and hold-to-talk closes
   * inside it on every quick tap. Adopting the late stream anyway left a live mic that nothing
   * would ever stop.
   */
  private generation = 0

  /**
   * Requests the microphone and starts collecting chunks. Resolves `true` once capturing, and
   * `false` when `stop()`/`cancel()` arrived before the microphone finished opening — the late
   * stream is released here, so nothing is live and the caller has nothing to undo. Idempotent
   * while already running (`true`).
   */
  async start(): Promise<boolean> {
    if (this.running) return true

    // Set the flag synchronously before the first await to guard against
    // re-entry: a second `start()` called during setup will see this.running
    // true and return early. Doubled as an in-flight guard so it must flip
    // before any suspension point.
    this.running = true
    const generation = this.generation
    const cancelled = (): boolean => generation !== this.generation

    try {
      const stream = await this.acquireStream()
      if (cancelled()) {
        // Its owner already tore down — these tracks are on no field, so release them here or
        // the OS microphone stays open.
        for (const track of stream.getTracks()) track.stop()
        return false
      }
      // Adopt the stream IMMEDIATELY: if AudioContext construction or
      // createMediaStreamSource throws below, the catch's teardown() must be
      // able to stop these tracks — a live mic (OS indicator lit) must never
      // outlive a failed start().
      this.stream = stream
      const audioContext = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE })
      this.audioContext = audioContext
      const sourceNode = audioContext.createMediaStreamSource(stream)
      this.sourceNode = sourceNode

      const onChunk = (chunk: Float32Array): void => {
        this.lastChunk = chunk
        this.chunks.push(chunk)
      }

      try {
        await this.startWorklet(audioContext, sourceNode, onChunk, cancelled)
      } catch {
        if (cancelled()) return false
        // `addModule` (or worklet construction) failed — fall back to the
        // deprecated-but-universal ScriptProcessorNode. Same chunk flow.
        this.startScriptProcessor(audioContext, sourceNode, onChunk)
      }
      // The teardown that cancelled us already stopped the tracks and closed the context; a
      // newer start() may own the fields by now, so touch nothing.
      return !cancelled()
    } catch (err) {
      if (cancelled()) return false
      // On any failure, reset running and tear down partial state.
      this.running = false
      this.teardown()
      throw err
    }
  }

  /** Stops capture, tears everything down, and returns the concatenated take. */
  stop(): Float32Array {
    const result = concatChunks(this.chunks)
    this.teardown()
    return result
  }

  /** Stops capture and tears everything down, discarding whatever was captured. */
  cancel(): void {
    this.teardown()
  }

  /** 0..1 RMS level of the most recently captured chunk, for a live level meter. */
  level = (): number => rms(this.lastChunk)

  private async acquireStream(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      })
    } catch (err) {
      // Denied / in use / missing → copy that names the setting to change (per platform: the
      // Windows privacy toggle, macOS System Settings, or the browser's site settings).
      const readable = micErrorMessage(err, this.platform())
      if (readable) throw new Error(readable)
      throw err
    }
  }

  private async startWorklet(
    audioContext: AudioContext,
    sourceNode: MediaStreamAudioSourceNode,
    onChunk: (chunk: Float32Array) => void,
    cancelled: () => boolean
  ): Promise<void> {
    // Vite/electron-vite statically recognizes this `new URL(relative,
    // import.meta.url)` pattern and emits pcm-worklet.ts as its own
    // same-origin asset, satisfying CSP `worker-src 'self' blob:'`.
    const workletUrl = new URL('./pcm-worklet.ts', import.meta.url)
    await audioContext.audioWorklet.addModule(workletUrl)
    // Torn down during the module load: the context is closed, and `workletNode` may already
    // belong to a newer start() — build nothing.
    if (cancelled()) return

    const node = new AudioWorkletNode(audioContext, WORKLET_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1
    })
    node.port.onmessage = (event: MessageEvent<Float32Array>): void => onChunk(event.data)
    sourceNode.connect(node)
    this.workletNode = node
  }

  private startScriptProcessor(
    audioContext: AudioContext,
    sourceNode: MediaStreamAudioSourceNode,
    onChunk: (chunk: Float32Array) => void
  ): void {
    const node = audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1)
    node.onaudioprocess = (event: AudioProcessingEvent): void => {
      // Copy: `getChannelData` returns a live view that the audio engine
      // may reuse for the next block.
      onChunk(event.inputBuffer.getChannelData(0).slice())
      event.outputBuffer.getChannelData(0).fill(0)
    }
    // A ScriptProcessorNode only fires `onaudioprocess` while it's on a path
    // to the destination. We write silence to its output above, but route
    // through a zero-gain sink anyway so nothing is ever audible even if a
    // browser deviates from spec here.
    const sink = audioContext.createGain()
    sink.gain.value = 0
    sourceNode.connect(node)
    node.connect(sink)
    sink.connect(audioContext.destination)
    this.scriptNode = node
    this.scriptSink = sink
  }

  private teardown(): void {
    this.generation += 1
    if (this.workletNode) this.workletNode.port.onmessage = null
    this.workletNode?.disconnect()
    this.workletNode = null

    this.scriptNode?.disconnect()
    this.scriptNode = null
    this.scriptSink?.disconnect()
    this.scriptSink = null

    this.sourceNode?.disconnect()
    this.sourceNode = null

    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null

    if (this.audioContext && this.audioContext.state !== 'closed') {
      void this.audioContext.close()
    }
    this.audioContext = null

    this.running = false
    this.chunks = []
    this.lastChunk = new Float32Array(0)
  }
}
