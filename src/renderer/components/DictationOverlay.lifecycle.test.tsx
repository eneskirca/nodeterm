// @vitest-environment jsdom
//
// The overlay's lifecycle against a microphone that takes time to open. Opening the mic is not
// instant (getUserMedia + an AudioContext + the worklet module — seconds on some Macs, longer
// when a Bluetooth headset switches profile), and hold-to-talk closes the overlay inside that
// window all the time: a sub-400 ms tap, any ⌘⌥<key> shortcut (the misfire guard), a window
// blur. A capture that finishes opening AFTER its overlay is gone used to be adopted anyway —
// nothing was left to stop it, so it recorded the room until the 2:30 cap and then typed the
// transcript (whisper's "Thank you." over silence, or a meeting's audio) into the terminal.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => {
  class FakeCapture {
    static instances: FakeCapture[] = []
    /** True from a successful open until stop()/cancel() — the OS mic indicator. */
    live = false
    ended = false
    private openMic: (() => void) | null = null
    constructor() {
      FakeCapture.instances.push(this)
    }
    start(): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        this.openMic = () => {
          // A real PcmCapture cancelled mid-open releases the stream and reports false.
          if (this.ended) return resolve(false)
          this.live = true
          resolve(true)
        }
      })
    }
    /** Test hook: the OS finishes opening the microphone. */
    finishOpening(): void {
      this.openMic?.()
    }
    stop(): Float32Array {
      this.live = false
      this.ended = true
      return new Float32Array(16_000)
    }
    cancel(): void {
      this.live = false
      this.ended = true
    }
    level(): number {
      return 0
    }
  }
  return {
    FakeCapture,
    sendText: vi.fn(async (_id: string, _text: string, _opts?: { enter?: boolean }) => true)
  }
})

vi.mock('../lib/pcm-capture', () => ({ PcmCapture: h.FakeCapture }))
vi.mock('../session/session', () => ({ useSession: () => ({ api: { pty: { sendText: h.sendText } } }) }))

import { DictationOverlay, type DictationTarget } from './DictationOverlay'
import { useSettings } from '../state/settings'

const target: DictationTarget = { kind: 'terminal', nodeId: 'n1', title: 'ssh mini' }
const CAP_PLUS_MARGIN_MS = 200_000 // past MAX_RECORDING_MS (2:30)

let host: HTMLDivElement
let root: Root
let onClose: Mock<() => void>
let micConsent: ReturnType<typeof vi.fn>
let transcribe: ReturnType<typeof vi.fn>

async function render(open: boolean, stopSignal = 0): Promise<void> {
  await act(async () => {
    root.render(
      open ? (
        <DictationOverlay target={target} stopSignal={stopSignal} onClose={onClose} onOpenLicense={() => {}} />
      ) : null
    )
  })
}

/** Let pending promise continuations (the consent round trip, start()) run. */
async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

function capture(): InstanceType<typeof h.FakeCapture> {
  expect(h.FakeCapture.instances).toHaveLength(1)
  return h.FakeCapture.instances[0]
}

beforeEach(() => {
  vi.useFakeTimers()
  h.FakeCapture.instances = []
  h.sendText.mockClear()
  onClose = vi.fn()
  micConsent = vi.fn(async () => true)
  transcribe = vi.fn(async () => ({ text: 'Thank you.' }))
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { speech: { micConsent, transcribe } }
  const s = useSettings.getState().settings
  useSettings.setState({ settings: { ...s, speech: { ...s.speech, engine: 'whisper', model: 'tiny' } } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('DictationOverlay — closed while the microphone is still opening', () => {
  it('a quick tap (Canvas unmounts the overlay) leaves no live mic and types nothing', async () => {
    await render(true)
    await flush()
    const c = capture()

    await render(false) // hold-to-talk cancel(): <400 ms tap, ⌘⌥<key> misfire, window blur
    expect(c.ended).toBe(true) // the in-flight open is told to give up at unmount, not later
    c.finishOpening()
    await flush()
    expect(c.live).toBe(false) // the OS mic indicator must not light up for a closed overlay
    expect(vi.getTimerCount()).toBe(0) // nor may a 20 Hz level poll run on the unmounted instance

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAP_PLUS_MARGIN_MS)
    })
    // The reported symptom: 2:30 later the room's audio was transcribed and typed in.
    expect(h.sendText).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('a hold released before the mic opened discards the take and releases the mic', async () => {
    await render(true)
    await flush()
    const c = capture()

    await render(true, 1) // hold-to-talk stop(): stopSignal bump while phase is still 'idle'
    expect(onClose).toHaveBeenCalledTimes(1)
    await render(false)
    c.finishOpening()
    await flush()
    expect(c.live).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAP_PLUS_MARGIN_MS)
    })
    expect(h.sendText).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('a remount over a still-opening instance (header-mic retarget) never leaves the first mic live', async () => {
    await render(true)
    await flush()
    const first = capture()

    // A new React key = a fresh instance; the old one unmounts with its start still pending.
    await act(async () => {
      root.render(
        <DictationOverlay key="2" target={target} stopSignal={0} onClose={onClose} onOpenLicense={() => {}} />
      )
    })
    first.finishOpening()
    await flush()
    expect(first.live).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAP_PLUS_MARGIN_MS)
    })
    // Only the live instance's own take may land (it auto-stops at the cap and inserts).
    expect(h.sendText.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('closed during the consent round trip, it never opens the mic at all', async () => {
    let grant: (ok: boolean) => void = () => {}
    micConsent.mockImplementation(() => new Promise<boolean>((r) => (grant = r)))
    await render(true)
    await render(false)
    grant(true)
    await flush()

    expect(h.FakeCapture.instances).toHaveLength(0)
  })
})

describe('DictationOverlay — the ordinary hold still works', () => {
  it('opens, records, and on stop transcribes and inserts without Enter', async () => {
    await render(true)
    await flush()
    const c = capture()
    c.finishOpening()
    await flush()
    expect(c.live).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500)
    })
    await render(true, 1) // release after a real hold → STOP
    await flush()

    expect(c.live).toBe(false)
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(h.sendText).toHaveBeenCalledWith('n1', 'Thank you.', { enter: false })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('DictationOverlay — a denied microphone', () => {
  const asWindows = (): void => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
  }
  afterEach(() => vi.restoreAllMocks())

  it('on Windows names the privacy toggle and offers to open it', async () => {
    asWindows()
    const openMicSettings = vi.fn(async () => true)
    micConsent.mockResolvedValue(false)
    ;(window as unknown as { nodeTerminal: { speech: object } }).nodeTerminal.speech = {
      micConsent,
      transcribe,
      openMicSettings
    }
    await render(true)
    await flush()

    expect(h.FakeCapture.instances).toHaveLength(0)
    expect(document.body.textContent).toContain('Let desktop apps access your microphone')
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open microphone settings')
    expect(button).toBeTruthy()
    await act(async () => button!.click())
    expect(openMicSettings).toHaveBeenCalledOnce()
  })

  it('renders no settings button where the bridge has no openMicSettings (Server Edition)', async () => {
    asWindows()
    micConsent.mockResolvedValue(false)
    await render(true)
    await flush()

    expect(document.body.textContent).toContain('Microphone access')
    expect(document.body.textContent).not.toContain('Open microphone settings')
  })
})
