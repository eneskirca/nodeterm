import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NodeResizer, useReactFlow, useStore, type NodeProps } from '@xyflow/react'
import {
  afterTouch,
  INPUT_HELD_HINT,
  TOUCH_ANSWER_MS,
  ORIENTATION_DEGREES,
  ORIENTATION_PURPLE,
  displayLabel,
  displayToFramebuffer,
  draggedSide,
  fitNodeToScreen,
  hidUsageForCode,
  picturePreRotated,
  touchEdge,
  rotateOrientation,
  simulatorPlatformOf,
  pointerToScreenRatio,
  type SimulatorDevice,
  type SimulatorDisplayInfo,
  type SimulatorPlatform,
  type SimulatorAction,
  type SimulatorCaptureTarget,
  type SimulatorDeviceState,
  type SimulatorInput,
  type SimulatorNodeConfig,
  type SimulatorOrientation,
  type SimulatorStatusEvent,
  type TouchEdge
} from '@shared/simulator'
import { useSession } from '../session/session'
import { ContextMenu } from '../components/ContextMenu'
import { buildAndroidMenu, buildSimulatorMenu, type SimulatorMenuHandlers } from './simulatorMenu'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'

/**
 * The Simulator node: a live iOS simulator screen on the canvas (see @shared/simulator and
 * core/simulator). The mouse is the finger — click = tap, drag = swipe, scroll wheel = a swipe —
 * the keyboard types into the device while the screen has focus, and Home / Lock are buttons.
 *
 * Frames arrive as JPEGs (only when the screen changed) and are drawn `object-fit: contain`, so the
 * phone keeps its proportions in any node size; `pointerToScreenRatio` maps a click through the
 * letterbox. The helper streams only while this node is mounted.
 */

type Phase = 'idle' | 'starting' | 'live' | 'error'

const WHEEL_END_MS = 140
/** A wheel notch moves the synthetic finger by this fraction of the screen per 100 px of delta. */
const WHEEL_SCALE = 0.25

/** A Simulator node: the view, in its own box with a title, a close button and resize handles. */
export function SimulatorNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements, setNodes } = useReactFlow()
  const config = useMemo(() => (data.simulator as SimulatorNodeConfig | undefined) ?? {}, [data.simulator])
  const dockTo = config.dockTo
  const canDock = useStore((st) => !!dockTo && st.nodeLookup.get(dockTo)?.data?.runConfig !== undefined)
  const host = useMemo<SimulatorHost>(
    () => ({
      selected: !!selected,
      color: data.color as string,
      resize: (width, height) =>
        setNodes((ns) =>
          ns.map((n) => (n.id !== id || (n.width === width && n.height === height) ? n : { ...n, width, height, style: { ...n.style, width, height } }))
        )
    }),
    [id, selected, data.color, setNodes]
  )
  const onConfig = useCallback(
    (next: SimulatorNodeConfig, pickedName?: string) =>
      updateNodeData(id, (n) => ({
        simulator: { ...next, ...(dockTo ? { dockTo } : {}) },
        ...(pickedName && n.data.titleAuto !== false ? { title: pickedName } : {})
      })),
    [id, dockTo, updateNodeData]
  )
  return (
    <SimulatorView
      streamId={id}
      config={config}
      onConfig={onConfig}
      label={(data.title as string) || config.name || 'Simulator'}
      className={`sim-node${selected ? ' selected' : ''}`}
      host={host}
      header={
        <div className="sim-node__header" style={{ background: `${data.color}22` }}>
          <span className="sim-node__title" title={data.title as string}>
            {data.title as string}
          </span>
          {canDock && dockTo && (
            <button
              className="run-bar__icon nodrag"
              title="Dock back into its run node"
              aria-label="Dock into run node"
              onClick={() => window.dispatchEvent(new CustomEvent('nodeterm:dock-preview', { detail: { nodeId: id, runNodeId: dockTo } }))}
            >
              ⇲
            </button>
          )}
          <button className="term-node__close nodrag" title="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
            ×
          </button>
        </div>
      }
    />
  )
}

/** What a standalone node gives the view: it can size the node to the screen, and draws handles. */
export interface SimulatorHost {
  selected: boolean
  color: string
  resize: (width: number, height: number) => void
}

export interface SimulatorViewProps {
  /** Keys the frame stream (`simulator:frame:<id>`): the node id, or `<runNodeId>.sim` inline. */
  streamId: string
  config: SimulatorNodeConfig
  /** A device pick (with its name) or a rotation, to persist. */
  onConfig: (next: SimulatorNodeConfig, pickedName?: string) => void
  /** Names captures. */
  label: string
  className: string
  style?: React.CSSProperties
  header?: React.ReactNode
  /** Standalone node only: fit-to-screen, Actual Size and resize handles. */
  host?: SimulatorHost
  /** Buttons appended to the toolbar (inline: pop out). */
  barExtras?: React.ReactNode
}

/**
 * The simulator screen with its toolbar, ⋯ menu and input — everything but the box around it, so a
 * Simulator node and a run node's inline panel show the same thing.
 */
export function SimulatorView({ streamId: id, config, onConfig, label, className, style, header, host, barExtras }: SimulatorViewProps) {
  const { api } = useSession()
  const configRef = useRef(config)
  configRef.current = config
  const udid = config.udid
  const orientation: SimulatorOrientation = config.orientation ?? 'portrait'
  const plat: SimulatorPlatform = simulatorPlatformOf(udid) ?? 'ios'
  const platRef = useRef(plat)
  platRef.current = plat
  // Read by the draw loop and the input path, which live in long-lived closures.
  const orientationRef = useRef(orientation)
  orientationRef.current = orientation
  /** The newest decoded frame, kept so a rotation can redraw it even when the device sends no new
   *  frame (an app that does not rotate leaves the framebuffer unchanged). */
  const lastBitmap = useRef<ImageBitmap | null>(null)

  const [devices, setDevices] = useState<SimulatorDevice[] | null>(null)
  const [androidError, setAndroidError] = useState<string | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [displays, setDisplays] = useState<SimulatorDisplayInfo[]>([])
  const [activeDisplay, setActiveDisplay] = useState(0)
  const [pinned, setPinned] = useState(false)
  const [frameSize, setFrameSize] = useState<{ w: number; h: number } | null>(null)
  const [booting, setBooting] = useState(false)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [devState, setDevState] = useState<SimulatorDeviceState>({})
  const [recording, setRecording] = useState(false)
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)
  const [prompt, setPrompt] = useState<PromptSpec | null>(null)
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  const [dropping, setDropping] = useState(false)
  /** "DeviceHub may be holding the input": shown after several touches in a row changed nothing. */
  const [inputHint, setInputHint] = useState(false)
  /** Frames received so far; a touch is answered when this moves after it lifts. */
  const framesSeen = useRef(0)
  const unanswered = useRef(0)
  const touchTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const sim = devices ?? []
  const device = sim.find((d) => d.id === udid)
  const booted = device?.state === 'booted'

  const loadDevices = useCallback(
    (refresh: boolean) => {
      void api.simulator.devices(refresh).then((r) => {
        setDevices(r.devices)
        setAndroidError(r.androidError)
      })
    },
    [api]
  )
  useEffect(() => loadDevices(false), [loadDevices])

  /** Draw the newest frame, turned to match how the device is held: the framebuffer is always
   *  portrait and iOS draws rotated content into it, so the picture is turned, as on a real panel. */
  const paint = useCallback(() => {
    const canvas = canvasRef.current
    const b = lastBitmap.current
    if (!canvas || !b) return
    // An Android emulator sends its frames already turned; only iOS frames are always portrait.
    const deg = picturePreRotated(platRef.current) ? 0 : ORIENTATION_DEGREES[orientationRef.current]
    const w = deg % 180 ? b.height : b.width
    const h = deg % 180 ? b.width : b.height
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (deg === 90) ctx.setTransform(0, 1, -1, 0, w, 0)
    else if (deg === 180) ctx.setTransform(-1, 0, 0, -1, w, h)
    else if (deg === 270) ctx.setTransform(0, -1, 1, 0, 0, h)
    ctx.drawImage(b, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    setFrameSize((s) => (s && s.w === w && s.h === h ? s : { w, h }))
  }, [])
  useEffect(() => paint(), [orientation, paint])

  // ── Stream ───────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!udid || !booted) {
      setPhase('idle')
      return
    }
    let live = true
    setPhase('starting')
    setMessage(null)
    // Frames are decoded straight to an ImageBitmap and drawn on a canvas. Not an <img> with a
    // blob: URL: the renderer's CSP allows img-src 'self' data: nt-media: only, so every frame was
    // a broken image — and a canvas needs no URL at all.
    let pending: { bitmap: ImageBitmap; w: number; h: number } | null = null
    let raf = 0
    let decoding = 0
    const offFrame = api.simulator.onFrame(id, (f) => {
      if (!live) return
      framesSeen.current++
      const seq = ++decoding
      void createImageBitmap(new Blob([f.jpeg as BlobPart], { type: f.mime ?? 'image/jpeg' })).then(
        (bitmap) => {
          // A newer frame decoded first (or the node went away): this one is stale.
          if (!live || seq < decoding) {
            bitmap.close()
            return
          }
          pending?.bitmap.close()
          pending = { bitmap, w: f.width, h: f.height }
          // Draw at most once per animation frame: a burst of frames shows the newest.
          if (!raf) {
            raf = requestAnimationFrame(() => {
              raf = 0
              if (!pending) return
              const { bitmap } = pending
              pending = null
              lastBitmap.current?.close()
              lastBitmap.current = bitmap
              paint()
              setPhase('live')
            })
          }
        },
        () => undefined
      )
    })
    const offStatus = api.simulator.onStatus(id, (e: SimulatorStatusEvent) => {
      if (!live) return
      if (e.kind === 'ready') {
        // Tell the device how the node holds it: after a reboot it is portrait whatever was saved.
        void api.simulator.input(id, { t: 'orientation', value: ORIENTATION_PURPLE[orientationRef.current] })
      } else if (e.kind === 'displays') {
        setDisplays(e.displays)
        setActiveDisplay(e.active)
        setPinned(e.pinned)
      } else if (e.kind === 'error') {
        setMessage(e.message)
        if (e.code !== 'hid-send' && e.code !== 'button') setPhase('error')
      } else if (e.kind === 'exited') {
        setPhase('error')
        // The helper reports why before it exits; keep that sentence when there is one.
        setMessage((prev) => prev ?? `The simulator view stopped (exit ${e.code ?? e.signal}).`)
      }
    })
    void api.simulator.start(id, udid).then((r) => {
      if (!live) return
      if (!r.ok) {
        setPhase('error')
        setMessage(r.error)
      }
    })
    return () => {
      live = false
      offFrame()
      offStatus()
      if (raf) cancelAnimationFrame(raf)
      pending?.bitmap.close()
      lastBitmap.current?.close()
      lastBitmap.current = null
      void api.simulator.stop(id)
    }
  }, [api, id, udid, booted, paint])

  // ── Fit the node to the screen ───────────────────────────────────────────────────────────────
  //
  // No black bars: whenever the screen's shape changes (first frame, a rotation, a foldable moving
  // to its other screen) the node is resized so the screen area has exactly that shape. The longer
  // side of the screen keeps its length, so a rotation turns a tall phone into a wide one of the
  // same size rather than shrinking it into the old box. The header and toolbar are measured, not
  // assumed (the toolbar wraps on a narrow node), so a second pass a frame later settles any wrap.
  // Layout pixels (offsetWidth/Height), which the canvas zoom does not touch — the same units as
  // the node's own size.
  const fitToScreen = useCallback(
    (by: 'long' | 'width' | 'height' = 'long') => {
      const root = rootRef.current
      const screen = screenRef.current
      if (!host || !root || !screen || !frameSize || screen.offsetWidth <= 0 || screen.offsetHeight <= 0) return
      const { width, height } = fitNodeToScreen({
        screenW: screen.offsetWidth,
        screenH: screen.offsetHeight,
        chromeW: root.offsetWidth - screen.offsetWidth,
        chromeH: root.offsetHeight - screen.offsetHeight,
        aspect: frameSize.w / frameSize.h,
        by,
        minW: NODE_MIN_SIZES.simulator.width,
        minH: NODE_MIN_SIZES.simulator.height
      })
      host.resize(width, height)
    },
    [frameSize, host]
  )
  /** The screen area's size when a hand resize began, to tell which side was dragged. */
  const resizeFrom = useRef<{ w: number; h: number } | null>(null)

  useEffect(() => {
    if (!frameSize) return
    fitToScreen()
    const raf = requestAnimationFrame(() => fitToScreen())
    return () => cancelAnimationFrame(raf)
    // Only when the screen's SHAPE changes — not on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameSize?.w, frameSize?.h])

  // ── Input ────────────────────────────────────────────────────────────────────────────────────
  const touchEdgeRef = useRef<TouchEdge>(0)
  // Touches are measured on the (turned) picture and sent in portrait framebuffer coordinates.
  const send = useCallback(
    (cmd: SimulatorInput) => {
      let out: SimulatorInput = cmd
      if (cmd.t === 'down' || cmd.t === 'move' || cmd.t === 'up') {
        const p = displayToFramebuffer(cmd.x, cmd.y, orientationRef.current)
        // The panel edge the finger went down on rides the whole contact: it is how iOS tells the
        // home swipe (up from the bottom) from a drag in the app. Android has no such flag.
        if (cmd.t === 'down') touchEdgeRef.current = platRef.current === 'ios' ? touchEdge(p.x, p.y) : 0
        const edge = touchEdgeRef.current
        out = { ...cmd, ...p, ...(edge ? { edge } : {}) }
        if (cmd.t === 'up') touchEdgeRef.current = 0
      }
      void api.simulator.input(id, out)
    },
    [api, id]
  )

  // A touch that lifted with no frame after it changed nothing on the screen (see afterTouch).
  // Counted from the finger going DOWN, so a drag that moved the screen while held is answered.
  const touchStartFrames = useRef(0)
  const watchTouch = useCallback(() => {
    // The hint is about DeviceHub holding an iOS device's input; Android has no such rule.
    if (platRef.current !== 'ios') return
    const before = touchStartFrames.current
    const t = setTimeout(() => {
      touchTimers.current.delete(t)
      const r = afterTouch(unanswered.current, framesSeen.current !== before)
      unanswered.current = r.count
      setInputHint(r.hint)
    }, TOUCH_ANSWER_MS)
    touchTimers.current.add(t)
  }, [])
  useEffect(() => {
    const timers = touchTimers.current
    return () => {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    }
  }, [])
  // A different device starts with a clean slate.
  useEffect(() => {
    unanswered.current = 0
    setInputHint(false)
  }, [udid])

  const rotate = useCallback(
    (dir: 'left' | 'right') => {
      const next = rotateOrientation(orientationRef.current, dir)
      orientationRef.current = next
      onConfig({ ...configRef.current, orientation: next })
      void api.simulator.input(id, { t: 'orientation', value: ORIENTATION_PURPLE[next] })
    },
    [api, id, onConfig]
  )

  const ratioAt = useCallback(
    (clientX: number, clientY: number) => {
      const box = screenRef.current?.getBoundingClientRect()
      if (!box || !frameSize) return null
      // Client-space on both sides, so the canvas zoom cancels out.
      return pointerToScreenRatio(clientX - box.left, clientY - box.top, box.width, box.height, frameSize.w, frameSize.h)
    },
    [frameSize]
  )

  const pressed = useRef<{ x: number; y: number } | null>(null)
  const moveRaf = useRef(0)
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || phase !== 'live') return
    const p = ratioAt(e.clientX, e.clientY)
    screenRef.current?.focus()
    if (!p) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pressed.current = p
    touchStartFrames.current = framesSeen.current
    send({ t: 'down', ...p })
    e.preventDefault()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pressed.current) return
    const { clientX, clientY } = e
    if (moveRaf.current) return
    moveRaf.current = requestAnimationFrame(() => {
      moveRaf.current = 0
      const box = screenRef.current?.getBoundingClientRect()
      if (!box || !frameSize || !pressed.current) return
      // While pressed, a drag past the screen's edge pins to the edge instead of dropping out.
      const p = ratioAt(clientX, clientY) ?? clampedRatio(clientX, clientY, box, frameSize)
      pressed.current = p
      send({ t: 'move', ...p })
    })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!pressed.current) return
    const box = screenRef.current?.getBoundingClientRect()
    const p = ratioAt(e.clientX, e.clientY) ?? (box && frameSize ? clampedRatio(e.clientX, e.clientY, box, frameSize) : pressed.current)
    pressed.current = null
    send({ t: 'up', ...p })
    watchTouch()
  }

  // The scroll wheel becomes a swipe: a finger that goes down where the pointer is, follows the
  // wheel, and lifts once the wheel stops.
  const wheel = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const onWheel = (e: React.WheelEvent) => {
    if (phase !== 'live') return
    const box = screenRef.current?.getBoundingClientRect()
    if (!box || !frameSize) return
    if (!wheel.current) {
      const p = ratioAt(e.clientX, e.clientY)
      if (!p) return
      touchStartFrames.current = framesSeen.current
      send({ t: 'down', ...p })
      wheel.current = { ...p, timer: setTimeout(() => undefined, 0) }
    }
    const w = wheel.current
    clearTimeout(w.timer)
    w.x = Math.min(1, Math.max(0, w.x - (e.deltaX / 100) * WHEEL_SCALE))
    w.y = Math.min(1, Math.max(0, w.y - (e.deltaY / 100) * WHEEL_SCALE))
    send({ t: 'move', x: w.x, y: w.y })
    w.timer = setTimeout(() => {
      send({ t: 'up', x: w.x, y: w.y })
      wheel.current = null
      watchTouch()
    }, WHEEL_END_MS)
  }

  // Keys go to the device as physical keys (it applies its own layout and Shift). ⌘-chords stay
  // with nodeterm so the app's own shortcuts keep working while the screen has focus.
  const onKey = (down: boolean) => (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    // ⌘V on Android: let the app's own paste happen — the screen's paste event carries the text.
    if (phase === 'live' && e.metaKey && e.code === 'KeyV' && plat === 'android') return
    // ⌘V pastes the Mac clipboard: sync it to the device, then press ⌘V there.
    if (phase === 'live' && e.metaKey && e.code === 'KeyV') {
      e.preventDefault()
      e.stopPropagation()
      if (down && !e.repeat) {
        void act({ a: 'pasteboard', dir: 'to-device' }).then(() => {
          send({ t: 'key', usage: 0xe3, down: true })
          send({ t: 'key', usage: 0x19, down: true })
          send({ t: 'key', usage: 0x19, down: false })
          send({ t: 'key', usage: 0xe3, down: false })
        })
      }
      return
    }
    // ⌘← / ⌘→ rotate, as they did in Simulator.app.
    if (phase === 'live' && e.metaKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      e.preventDefault()
      e.stopPropagation()
      if (down && !e.repeat) rotate(e.code === 'ArrowLeft' ? 'left' : 'right')
      return
    }
    if (phase !== 'live' || (e.metaKey && e.code !== 'MetaLeft' && e.code !== 'MetaRight')) return
    const usage = hidUsageForCode(e.code)
    if (usage === undefined) return
    e.preventDefault()
    e.stopPropagation()
    if (down && e.repeat) return
    send({ t: 'key', usage, down })
  }

  // Android ⌘V: put the host's text on the device clipboard, then press Ctrl+V there (Android's own
  // paste shortcut in a text field).
  const onPaste = (e: React.ClipboardEvent) => {
    if (plat !== 'android' || phase !== 'live') return
    const text = e.clipboardData.getData('text/plain')
    e.preventDefault()
    e.stopPropagation()
    if (!text) return
    void act({ a: 'clipboard-set', text }).then(() => {
      send({ t: 'key', usage: 0xe0, down: true })
      send({ t: 'key', usage: 0x19, down: true })
      send({ t: 'key', usage: 0x19, down: false })
      send({ t: 'key', usage: 0xe0, down: false })
    })
  }

  // ── Header actions ───────────────────────────────────────────────────────────────────────────
  const pick = (value: string) => {
    const d = sim.find((x) => x.id === value)
    onConfig({ udid: value, name: d?.name }, d?.name)
  }
  const boot = async () => {
    if (!udid) return
    setBooting(true)
    setMessage(null)
    const r = await api.simulator.boot(udid)
    setBooting(false)
    if (!r.ok) setMessage(r.error)
    loadDevices(true)
  }
  const shutdown = async () => {
    if (!udid) return
    await api.simulator.shutdown(udid)
    loadDevices(true)
  }

  // ── ⋯ menu ───────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.error ? 6000 : 3500)
    return () => clearTimeout(t)
  }, [toast])

  const say = (r: { ok: true; message?: string } | { ok: false; error: string }) => {
    if (r.ok) {
      if (r.message) setToast({ text: r.message })
    } else setToast({ text: r.error, error: true })
  }

  const act = useCallback(
    async (a: SimulatorAction) => {
      if (!udid) return
      const r = await api.simulator.action(udid, a)
      say(r)
      if (r.ok && r.text !== undefined) api.clipboard.writeText(r.text)
      if (r.ok && (a.a === 'appearance' || a.a === 'increase-contrast' || a.a === 'content-size')) {
        void api.simulator.state(udid).then(setDevState)
      }
      if (r.ok && (a.a === 'restart' || a.a === 'erase')) loadDevices(true)
    },
    [api, udid, loadDevices]
  )

  const activeScreenID = displays[activeDisplay]?.screenID ?? 0
  const deviceName = label

  const screenshot = async (target: SimulatorCaptureTarget) => {
    if (!udid) return
    const r = await api.simulator.screenshot(udid, activeScreenID, target, deviceName)
    say(r)
    if (r.ok && target === 'canvas' && r.path) window.dispatchEvent(new CustomEvent('nodeterm:open-file', { detail: { path: r.path } }))
  }

  const toggleRecording = async () => {
    if (!udid) return
    if (recording) {
      const r = await api.simulator.stopRecording(udid)
      setRecording(false)
      say(r)
      if (r.ok && r.path) window.dispatchEvent(new CustomEvent('nodeterm:open-file', { detail: { path: r.path } }))
    } else {
      const r = await api.simulator.startRecording(udid, activeScreenID, deviceName)
      if (r.ok) setRecording(true)
      else say(r)
    }
  }
  useEffect(() => {
    if (udid) void api.simulator.isRecording(udid).then(setRecording)
  }, [api, udid])

  /** One device point per canvas point: the framebuffer's pixels over the device's scale (2× iPad,
   *  3× iPhone — the two scales current simulators use). */
  const actualSize = () => {
    const disp = displays[activeDisplay]
    const root = rootRef.current
    const screen = screenRef.current
    if (!host || !disp || !root || !screen) return
    const scale = disp.scale ?? (/ipad/i.test(device?.name ?? config.name ?? '') ? 2 : 3)
    const turned = ORIENTATION_DEGREES[orientationRef.current] % 180 !== 0
    const w = Math.round((turned ? disp.height : disp.width) / scale + (root.offsetWidth - screen.offsetWidth))
    const h = Math.round((turned ? disp.width : disp.height) / scale + (root.offsetHeight - screen.offsetHeight))
    host.resize(w, h)
  }

  const pickFile = async (kind: 'install' | 'media') => {
    const p = await api.dialog.selectFile()
    if (!p) return
    if (kind === 'install') void act({ a: 'install', path: p })
    else void act({ a: 'add-media', paths: [p] })
  }

  const openMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenuAt({ x: r.left, y: r.bottom + 4 })
    if (udid) void api.simulator.state(udid).then(setDevState)
  }

  const menuHandlers: SimulatorMenuHandlers = {
      button: (name) => send({ t: 'button', name }),
      rotate,
      action: (a) => void act(a),
      screenshot: (t) => void screenshot(t),
      toggleRecording: () => void toggleRecording(),
      shutDown: () => void shutdown(),
      confirmErase: () =>
        setConfirm({
          title: 'Reset Content and Settings?',
          body: `Erases everything on “${deviceName}” — apps, data and settings — like a factory reset. It restarts afterwards.`,
          confirmLabel: 'Erase',
          onConfirm: () => void act({ a: 'erase' })
        }),
      promptCustomLocation: () =>
        setPrompt({
          title: 'Custom Location',
          fields: [
            { key: 'lat', label: 'Latitude', placeholder: '37.3349' },
            { key: 'lon', label: 'Longitude', placeholder: '-122.0090' }
          ],
          submitLabel: 'Set Location',
          onSubmit: (v) => void act({ a: 'location-set', lat: Number(v.lat), lon: Number(v.lon) })
        }),
      promptOpenUrl: () =>
        setPrompt({
          title: 'Open URL',
          fields: [{ key: 'url', label: 'URL or deep link', placeholder: 'https://… or myapp://path' }],
          submitLabel: 'Open',
          onSubmit: (v) => void act({ a: 'open-url', url: v.url })
        }),
      promptPush: () =>
        setPrompt({
          title: 'Send Push Notification',
          fields: [
            { key: 'bundleId', label: 'App bundle ID', placeholder: 'com.example.app' },
            {
              key: 'payload',
              label: 'Payload (JSON)',
              multiline: true,
              value: JSON.stringify({ aps: { alert: { title: 'Hello', body: 'From nodeterm' }, sound: 'default' } }, null, 2)
            }
          ],
          submitLabel: 'Send',
          onSubmit: (v) => void act({ a: 'push', bundleId: v.bundleId.trim(), payload: v.payload })
        }),
      promptPrivacy: (op) =>
        setPrompt({
          title: op === 'grant' ? 'Grant All Permissions' : 'Revoke All Permissions',
          fields: [{ key: 'bundleId', label: 'App bundle ID', placeholder: 'com.example.app' }],
          submitLabel: op === 'grant' ? 'Grant' : 'Revoke',
          onSubmit: (v) => void act({ a: 'privacy', op, service: 'all', bundleId: v.bundleId.trim() })
        }),
      pickInstall: () => void pickFile('install'),
      pickMedia: () => void pickFile('media'),
      actualSize: host ? actualSize : undefined,
      fitToScreen: host ? () => fitToScreen('long') : undefined
    }
  const menuItems =
    plat === 'android'
      ? buildAndroidMenu(menuHandlers, { device: devState })
      : buildSimulatorMenu(menuHandlers, { device: devState, recording })

  // Drop a built .app to install it, photos/videos to add them to the library.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDropping(false)
    if (!udid || phase !== 'live') return
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.nodeTerminal.getPathForFile(f))
      .filter(Boolean)
    const apps = paths.filter((p) => (plat === 'android' ? /\.apks?$/i : /\.app\/?$/).test(p))
    const media = paths.filter((p) => /\.(png|jpe?g|gif|heic|heif|webp|mov|mp4|m4v)$/i.test(p))
    for (const app of apps) void act({ a: 'install', path: app.replace(/\/$/, '') })
    if (media.length) void act({ a: 'add-media', paths: media })
    if (!apps.length && !media.length)
      setToast({
        text: plat === 'android' ? 'Drop an .apk to install it, or photos and videos to add them to Pictures.' : 'Drop a built .app to install it, or photos and videos to add them to Photos.',
        error: true
      })
  }

  const statusText =
    booting
      ? 'Booting…'
      : phase === 'starting'
        ? 'Connecting…'
        : phase === 'live'
          ? ''
          : !udid
            ? ''
            : device && !booted
              ? 'Shut down'
              : ''

  const twins = useMemo(() => new Set(sim.filter((d, i) => sim.findIndex((o) => o.name === d.name && o.os === d.os) !== i).map((d) => `${d.name}|${d.os}`)), [sim])
  const deviceLabel = (d: SimulatorDevice) =>
    `${d.name}${d.os ? ` · ${d.os}` : ''}${twins.has(`${d.name}|${d.os}`) ? ` · ${d.id.replace(/^avd:/, '').slice(0, 4)}` : ''}${d.state === 'booted' ? '' : ' (off)'}`
  const iosDevices = sim.filter((d) => d.platform === 'ios')
  const androidDevices = sim.filter((d) => d.platform === 'android')

  return (
    <>
      <div ref={rootRef} className={className} style={style}>
        {header}
        <div className="sim-node__bar nodrag nowheel">
          <select className="run-bar__select sim-node__device" value={udid ?? ''} onChange={(e) => pick(e.target.value)}>
            {!udid && <option value="">{devices ? 'Pick a simulator…' : 'Loading…'}</option>}
            {udid && !device && <option value={udid}>{config.name ?? udid}</option>}
            {iosDevices.length > 0 && (
              <optgroup label="iOS">
                {iosDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {deviceLabel(d)}
                  </option>
                ))}
              </optgroup>
            )}
            {androidDevices.length > 0 && (
              <optgroup label="Android">
                {androidDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {deviceLabel(d)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button className="run-bar__icon" title="Refresh simulators" onClick={() => loadDevices(true)}>
            ⟳
          </button>
          {udid && device && !booted && (
            <button className="run-bar__btn run-bar__btn--run" disabled={booting} onClick={() => void boot()}>
              Boot
            </button>
          )}
          {displays.length > 1 && (
            <select
              className="run-bar__select"
              title="Which screen to show (a foldable has two)"
              value={pinned ? String(activeDisplay) : '-1'}
              onChange={(e) => send({ t: 'display', index: Number(e.target.value) })}
            >
              <option value="-1">Auto ({displayLabel(displays[activeDisplay] ?? displays[0], displays)})</option>
              {displays.map((d) => (
                <option key={d.index} value={d.index}>
                  {displayLabel(d, displays)}
                </option>
              ))}
            </select>
          )}
          <span className="run-bar__spacer" />
          {phase === 'live' && (
            <>
              <button className="run-bar__icon" title="Rotate left (⌘←)" onClick={() => rotate('left')}>
                ↺
              </button>
              <button className="run-bar__icon" title="Rotate right (⌘→)" onClick={() => rotate('right')}>
                ↻
              </button>
              {plat === 'android' && (
                <button className="run-bar__icon" title="Back" onClick={() => send({ t: 'button', name: 'back' })}>
                  ◁
                </button>
              )}
              <button className="run-bar__icon" title="Home" onClick={() => send({ t: 'button', name: 'home' })}>
                ⌂
              </button>
              {plat === 'android' && (
                <button className="run-bar__icon" title="Recent apps" onClick={() => send({ t: 'button', name: 'recents' })}>
                  ▢
                </button>
              )}
              <button className="run-bar__icon" title="Lock / side button" onClick={() => send({ t: 'button', name: 'lock' })}>
                ⏻
              </button>
              <button className="run-bar__icon" title="Shut down this simulator" onClick={() => void shutdown()}>
                ⏏
              </button>
            </>
          )}
          {recording && (
            <button className="sim-node__rec" title="Recording — click to stop" onClick={() => void toggleRecording()}>
              ● REC
            </button>
          )}
          {udid && booted && (
            <button className="run-bar__icon" title={plat === 'android' ? 'More' : 'More (everything DeviceHub offers)'} aria-label="More" onClick={openMenu}>
              ⋯
            </button>
          )}
          {statusText && <span className="run-bar__status">{statusText}</span>}
          {barExtras}
        </div>
        <div
          ref={screenRef}
          className="sim-node__screen nodrag nowheel"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onKeyDown={onKey(true)}
          onKeyUp={onKey(false)}
          onPaste={onPaste}
          onDragOver={(e) => {
            if (phase !== 'live') return
            e.preventDefault()
            setDropping(true)
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={onDrop}
        >
          <canvas ref={canvasRef} className="sim-node__frame" style={{ visibility: phase === 'live' ? 'visible' : 'hidden' }} />
          {phase !== 'live' && (
            <div className="sim-node__placeholder">
              {!udid
                ? `Pick a simulator above.${androidError ? ` ${androidError}` : ''}`
                : device && !booted
                  ? 'This simulator is shut down — Boot it to see its screen.'
                  : phase === 'starting'
                    ? plat === 'android'
                      ? 'Connecting to the emulator…'
                      : 'Connecting to the simulator… (the first time builds a small helper with Xcode)'
                    : (message ?? '')}
            </div>
          )}
          {phase === 'live' && message && <div className="sim-node__note">{message}</div>}
          {phase === 'live' && inputHint && (
            <div className="sim-node__hint" role="status">
              <span>{INPUT_HELD_HINT}</span>
              <button
                className="sim-node__hint-close"
                aria-label="Dismiss"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  unanswered.current = 0
                  setInputHint(false)
                }}
              >
                ×
              </button>
            </div>
          )}
          {dropping && <div className="sim-node__drop">Drop a .app to install · photos or videos to add</div>}
        </div>
        {toast && <div className={`sim-node__toast${toast.error ? ' sim-node__toast--error' : ''}`}>{toast.text}</div>}
        {prompt && <SimPrompt spec={prompt} onClose={() => setPrompt(null)} />}
        {confirm && (
          <div className="sim-node__overlay nodrag nowheel">
            <div className="sim-node__dialog">
              <div className="sim-node__dialog-title">{confirm.title}</div>
              <div className="sim-node__dialog-body">{confirm.body}</div>
              <div className="sim-node__dialog-actions">
                <button className="run-bar__btn" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
                <button
                  className="run-bar__btn run-bar__btn--stop"
                  onClick={() => {
                    confirm.onConfirm()
                    setConfirm(null)
                  }}
                >
                  {confirm.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      {menuAt && <ContextMenu x={menuAt.x} y={menuAt.y} items={menuItems} onClose={() => setMenuAt(null)} />}
      {host && (
      <NodeResizer
        minWidth={NODE_MIN_SIZES.simulator.width}
        minHeight={NODE_MIN_SIZES.simulator.height}
        isVisible={host.selected}
        color={host.color}
        // A hand resize snaps to the screen's shape when it ends, following the side that was
        // dragged — widen it and the height follows; make it taller and the width follows.
        onResizeStart={() => {
          const sc = screenRef.current
          resizeFrom.current = sc ? { w: sc.offsetWidth, h: sc.offsetHeight } : null
        }}
        onResizeEnd={() =>
          requestAnimationFrame(() => {
            const sc = screenRef.current
            const from = resizeFrom.current
            resizeFrom.current = null
            fitToScreen(sc && from ? draggedSide(from, { w: sc.offsetWidth, h: sc.offsetHeight }) : 'long')
          })
        }
      />
      )}
    </>
  )
}

/** A point outside the drawn screen, pinned to its nearest edge (a drag that leaves the screen). */
function clampedRatio(clientX: number, clientY: number, box: DOMRect, frame: { w: number; h: number }) {
  const scale = Math.min(box.width / frame.w, box.height / frame.h)
  const left = box.left + (box.width - frame.w * scale) / 2
  const top = box.top + (box.height - frame.h * scale) / 2
  return {
    x: Math.min(1, Math.max(0, (clientX - left) / (frame.w * scale))),
    y: Math.min(1, Math.max(0, (clientY - top) / (frame.h * scale)))
  }
}

interface PromptField {
  key: string
  label: string
  placeholder?: string
  multiline?: boolean
  value?: string
}
interface PromptSpec {
  title: string
  fields: PromptField[]
  submitLabel: string
  onSubmit: (values: Record<string, string>) => void
}
interface ConfirmSpec {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
}

/** A small in-node form for the menu items that need a value (URL, push payload, coordinates). */
function SimPrompt({ spec, onClose }: { spec: PromptSpec; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(spec.fields.map((f) => [f.key, f.value ?? '']))
  )
  const submit = () => {
    spec.onSubmit(values)
    onClose()
  }
  return (
    <div className="sim-node__overlay nodrag nowheel" onKeyDown={(e) => e.stopPropagation()}>
      <form
        className="sim-node__dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="sim-node__dialog-title">{spec.title}</div>
        {spec.fields.map((f, i) => (
          <label key={f.key} className="sim-node__field">
            <span>{f.label}</span>
            {f.multiline ? (
              <textarea
                autoFocus={i === 0}
                rows={7}
                spellCheck={false}
                value={values[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            ) : (
              <input
                autoFocus={i === 0}
                spellCheck={false}
                value={values[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            )}
          </label>
        ))}
        <div className="sim-node__dialog-actions">
          <button type="button" className="run-bar__btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="run-bar__btn run-bar__btn--run">
            {spec.submitLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
