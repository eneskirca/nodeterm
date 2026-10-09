import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useReactFlow, useStore } from '@xyflow/react'
import {
  deviceClaims,
  resolveEntry,
  runDirLabel,
  runNodeTitle,
  type LaunchEntry,
  type RunDevice,
  type RunEntriesResult,
  type RunNodeConfig,
  type RunStatus
} from '@shared/run-config'
import { isShellCommand } from '@shared/agents/pane'
import { SIMULATOR_UDID } from '@shared/run-config'
import { INLINE_SIM_HEIGHT, type InlineSimulatorConfig, type SimulatorNodeConfig } from '@shared/simulator'
import { SimulatorView } from './SimulatorNode'
import { BrowserSurface } from './BrowserSurface'
import {
  isWebDeviceId,
  isPreviewUrl,
  localUrlFromOutput,
  previewKindFor,
  type PreviewKind,
  type RunBrowserConfig
} from '@shared/run-preview'
import { simulatorAvailable } from '../lib/addMenuSpec'
import { useSession } from '../session/session'
import { useProjects } from '../state/projects'
import { createBrowserNode, createSimulatorNode, terminalNodeSize, type CanvasNode } from '../state/workspace'
import { IconPlay, IconReload } from '../components/icons'

/**
 * The run node's toolbar: VS Code's "Run Without Debugging" for any `.vscode/launch.json`
 * configuration, over the node's own terminal.
 *
 *   [folder ▾] [configuration ▾] [device ▾ — Flutter only] [⟳]
 *   ▶ Run / ■ Stop   ⚡ Reload  ↻ Restart   [reload on save]          status  ⋯
 *
 * The host writes a launcher script for the chosen configuration (see `buildLauncher`) and this bar
 * types the one line that runs it, so the run's output, keys and lifetime are the terminal's.
 * Stop is SIGINT to the run's process group (Ctrl+C), then SIGTERM if it will not go. Flutter's
 * `flutter run` additionally gets hot reload / hot restart by signal and reload on save; every
 * other type's Restart is stop + run.
 *
 * The terminal is hidden by default (⋯ shows it, with the extra-arguments field): hidden, the node
 * is just these rows, fitted to their height.
 */

const STATUS_POLL_MS = 2_000
const STOP_GRACE_MS = 5_000
const NOTE_MS = 6_000

type Busy = 'booting' | 'starting' | 'stopping' | 'reloading' | 'restarting' | null

const CHOOSE_FOLDER = '\u0000choose'
const NO_ENTRY = '\u0000none'

interface Props {
  nodeId: string
  config: RunNodeConfig
  /** A compound's sibling: start the run once on mount. */
  autoStart: boolean
  /** The simulator shown inside this node, when it is (`data.runSimulator`). */
  simulator?: InlineSimulatorConfig
  /** The browser shown inside this node, when it is (`data.runBrowser`). */
  browser?: RunBrowserConfig
}

/** Node id → title → device, for every run node on the live canvas, as one primitive. */
function liveSig(s: { nodes: unknown[] }): string {
  let out = ''
  for (const n of s.nodes as CanvasNode[]) {
    const r = n.data?.runConfig
    if (r?.deviceId) out += `${n.id}\u0001${n.data.title}\u0001${r.deviceId}\u0002`
  }
  return out
}

function storedSig(s: ReturnType<typeof useProjects.getState>): string {
  let out = ''
  for (const p of s.projects) {
    if (p.closed) continue
    for (const n of p.nodes) {
      if (n.runConfig?.deviceId) out += `${n.id}\u0001${n.title}\u0001${n.runConfig.deviceId}\u0002`
    }
  }
  return out
}

function parseSig(sig: string): Array<{ id: string; title: string; runConfig: { deviceId: string } }> {
  return sig
    .split('\u0002')
    .filter(Boolean)
    .map((row) => {
      const [id, title, deviceId] = row.split('\u0001')
      return { id, title, runConfig: { deviceId } }
    })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function RunBar({ nodeId, config, autoStart, simulator, browser: browserPanel }: Props) {
  const { api } = useSession()
  const { updateNodeData, setNodes, getNodes } = useReactFlow()
  const [listing, setListing] = useState<RunEntriesResult | null>(null)
  const [devices, setDevices] = useState<RunDevice[] | null>(null)
  const [devicesError, setDevicesError] = useState<string | null>(null)
  const [projects, setProjects] = useState<string[]>([])
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [note, setNote] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [needsRerun, setNeedsRerun] = useState(false)
  const [argsDraft, setArgsDraft] = useState(config.extraArgs ?? '')
  const mounted = useRef(true)
  useEffect(() => () => void (mounted.current = false), [])

  const cfgRef = useRef(config)
  cfgRef.current = config
  // The preview panel, for the run-start path above it (see the 📱 / 🌐 section below).
  const browserOpenRef = useRef(false)
  const popOutRef = useRef<{ kind: PreviewKind; id: string } | null>(null)
  const setPreviewRef = useRef<(next: { kind: 'browser'; cfg: RunBrowserConfig }) => void>(() => undefined)
  const running = !!status?.running

  const say = useCallback((kind: 'error' | 'info', text: string) => setNote({ kind, text }), [])
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), NOTE_MS)
    return () => clearTimeout(t)
  }, [note])

  /** Patch the node's run config; the title follows folder + configuration while it is ours. */
  const patch = useCallback(
    (next: Partial<RunNodeConfig>, opts?: { changesRun?: boolean; entryName?: string }) => {
      updateNodeData(nodeId, (n) => {
        const prev = (n.data.runConfig as RunNodeConfig | undefined) ?? cfgRef.current
        const runConfig: RunNodeConfig = { ...prev, ...next }
        const data: Record<string, unknown> = { runConfig }
        if (next.projectDir && next.projectDir !== prev.projectDir) data.cwd = next.projectDir
        if (n.data.titleAuto !== false && (next.projectDir || next.launchConfig || opts?.entryName)) {
          data.title = runNodeTitle(runConfig.projectDir, opts?.entryName ?? runConfig.launchConfig)
        }
        return data
      })
      if (opts?.changesRun && cfgRef.current && running) setNeedsRerun(true)
    },
    [nodeId, updateNodeData, running]
  )

  // ── Loads ────────────────────────────────────────────────────────────────────────────────

  const loadEntries = useCallback(() => {
    void api.runConfig.entries(cfgRef.current.projectDir).then((r) => {
      if (mounted.current) setListing(r)
    })
  }, [api])

  useEffect(() => {
    let live = true
    setListing(null)
    void api.runConfig.entries(config.projectDir).then((r) => {
      if (live) setListing(r)
    })
    void api.runConfig.discoverProjects(config.projectDir).then((dirs) => {
      if (live) setProjects(dirs)
    })
    return () => {
      live = false
    }
  }, [api, config.projectDir])

  const entries = listing?.entries ?? []
  const entry: LaunchEntry | undefined = useMemo(
    () => resolveEntry(entries, config.launchConfig),
    [entries, config.launchConfig]
  )
  const wantsDevices = entries.some((e) => e.usesDevice)

  const loadDevices = useCallback(
    (refresh: boolean) => {
      void api.runConfig.devices(refresh).then((r) => {
        if (!mounted.current) return
        setDevices(r.devices)
        setDevicesError(r.error ?? null)
      })
    },
    [api]
  )
  useEffect(() => {
    if (wantsDevices && devices === null) loadDevices(false)
  }, [wantsDevices, devices, loadDevices])

  // Set while WE are stopping the run, so its end is not reported as unexpected.
  const stoppingRef = useRef(false)
  const lastRunningRef = useRef<boolean | null>(null)
  const pollStatus = useCallback(async () => {
    const s = await api.runConfig.status(nodeId)
    if (!mounted.current) return s.running
    if (lastRunningRef.current === true && !s.running && !stoppingRef.current && !cfgRef.current.showTerminal) {
      const how = s.exitCode === null || s.exitCode === 0 ? 'The run ended' : `The run exited with code ${s.exitCode}`
      setNote({ kind: s.exitCode ? 'error' : 'info', text: `${how} — open ⋯ to see the terminal output.` })
    }
    lastRunningRef.current = s.running
    setStatus(s)
    return s.running
  }, [api, nodeId])

  useEffect(() => {
    void pollStatus()
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void pollStatus()
    }, STATUS_POLL_MS)
    return () => clearInterval(t)
  }, [pollStatus])

  // Reload on save lives in core and outlives this view (the run keeps going in tmux).
  const hotReload = !!entry?.hotReload
  useEffect(() => {
    void api.runConfig.watch(nodeId, hotReload && config.reloadOnSave ? config.projectDir : null)
  }, [api, nodeId, hotReload, config.reloadOnSave, config.projectDir])

  // ── Derived ──────────────────────────────────────────────────────────────────────────────

  const showDevice = !!entry?.usesDevice && !entry.pinnedDevice
  const live = useStore(liveSig)
  const stored = useProjects(storedSig)
  const claimsFor = useCallback(
    (deviceId: string | undefined) => {
      const l = parseSig(live)
      const ids = new Set(l.map((n) => n.id))
      return deviceClaims([...l, ...parseSig(stored).filter((n) => !ids.has(n.id))], nodeId, deviceId)
    },
    [live, stored, nodeId]
  )

  // First open: adopt the configuration VS Code would show first, and (Flutter) a running
  // simulator nobody else is using — so a fresh node is usually one click from running.
  useEffect(() => {
    if (listing && !config.launchConfig && entry) patch({ launchConfig: entry.name }, { entryName: entry.name })
  }, [listing, config.launchConfig, entry, patch])
  useEffect(() => {
    if (!devices || config.deviceId || !showDevice) return
    const free = devices.find((d) => d.kind === 'simulator' && d.state === 'booted' && claimsFor(d.id).length === 0)
    if (free) patch({ deviceId: free.id, deviceName: free.name })
  }, [devices, config.deviceId, showDevice, claimsFor, patch])

  const device = devices?.find((d) => d.id === config.deviceId)
  const claims = showDevice ? claimsFor(config.deviceId) : []

  // ── Actions ──────────────────────────────────────────────────────────────────────────────

  const start = useCallback(
    async (override?: Partial<RunNodeConfig>) => {
      const cfg = { ...cfgRef.current, ...override }
      const target = resolveEntry(entries, cfg.launchConfig)
      if (target?.usesDevice && !target.pinnedDevice && !cfg.deviceId) {
        say('error', 'Pick a device first.')
        return
      }
      const pane = await api.pty.paneCommand(nodeId)
      if (pane !== null && !isShellCommand(pane)) {
        say('error', `“${pane}” is running in this terminal — stop it first.`)
        return
      }
      const dev = devices?.find((d) => d.id === cfg.deviceId)
      if (target?.usesDevice && !target.pinnedDevice && dev?.kind === 'simulator' && dev.state !== 'booted') {
        setBusy('booting')
        if (!(await api.runConfig.bootDevice(dev.id))) {
          setBusy(null)
          say('error', `Could not boot ${dev.name}.`)
          return
        }
        loadDevices(true)
      }
      setBusy('starting')
      const r = await api.runConfig.start(nodeId, cfg)
      if (!r.ok) {
        setBusy(null)
        say('error', r.error)
        return
      }
      if (r.kind === 'browser') {
        setBusy(null)
        if (!isPreviewUrl(r.url)) {
          say('error', `Only http(s) URLs open in the browser panel (${r.url}).`)
          return
        }
        // The page opens in this node's browser panel (or the panel popped out of it).
        const out = popOutRef.current
        if (out?.kind === 'browser') updateNodeData(out.id, { url: r.url })
        else setPreviewRef.current({ kind: 'browser', cfg: { url: r.url } })
        return
      }
      if (r.kind === 'compound') {
        // This node runs the first member; the rest open beside it and start at once.
        const [first, ...rest] = r.members
        setBusy(null)
        if (rest.length) {
          const base = cfgRef.current
          window.dispatchEvent(
            new CustomEvent('nodeterm:open-run-config', {
              detail: {
                sourceNodeId: nodeId,
                configs: rest.map((name) => ({ projectDir: base.projectDir, launchConfig: name, reloadOnSave: base.reloadOnSave }))
              }
            })
          )
        }
        patch({ launchConfig: first }, { entryName: first })
        await start({ launchConfig: first })
        return
      }
      const sent = await api.pty.sendText(nodeId, r.command)
      setNeedsRerun(false)
      // A Flutter web run shows in this node (the host runs it on Flutter's web server — see
      // `webServerDevice`): open the browser panel for it, unless it is open or popped out already.
      const runDevice = target?.pinnedDevice ?? cfg.deviceId
      if (target?.usesDevice && isWebDeviceId(runDevice) && cfg.embedBrowser !== false && !browserOpenRef.current) {
        setPreviewRef.current({ kind: 'browser', cfg: {} })
      }
      if (sent === 'pasted-not-submitted') say('info', 'The command is in the terminal — press Enter to start.')
      else if (sent !== true) say('error', 'Could not type into this terminal.')
      const deadline = Date.now() + 15_000
      while (mounted.current && Date.now() < deadline) {
        if (await pollStatus()) break
        await sleep(400)
      }
      if (mounted.current) setBusy(null)
    },
    [api, nodeId, entries, devices, loadDevices, pollStatus, patch, say]
  )

  const waitStopped = useCallback(
    async (ms: number) => {
      const deadline = Date.now() + ms
      while (mounted.current && Date.now() < deadline) {
        if (!(await pollStatus())) return true
        await sleep(300)
      }
      return false
    },
    [pollStatus]
  )

  const stop = useCallback(async () => {
    setBusy('stopping')
    stoppingRef.current = true
    let stopped = false
    if (await api.runConfig.stop(nodeId)) {
      stopped = await waitStopped(STOP_GRACE_MS)
      // Ctrl+C was not enough (a program that traps it): ask harder, once.
      if (!stopped && (await api.runConfig.stop(nodeId, true))) stopped = await waitStopped(STOP_GRACE_MS)
    } else {
      stopped = !(await pollStatus())
    }
    stoppingRef.current = false
    if (mounted.current) {
      setBusy(null)
      if (!stopped) say('error', 'The run did not stop — open ⋯ to check the terminal.')
    }
    return stopped
  }, [api, nodeId, waitStopped, pollStatus, say])

  const restart = useCallback(async () => {
    if (running && !(await stop())) return
    await start()
  }, [running, stop, start])

  const signal = useCallback(
    async (kind: 'reload' | 'restart') => {
      setBusy(kind === 'reload' ? 'reloading' : 'restarting')
      const ok = await api.runConfig.signal(nodeId, kind)
      if (!mounted.current) return
      setTimeout(() => mounted.current && setBusy(null), 600)
      if (!ok) say('error', 'The app is not running.')
    },
    [api, nodeId, say]
  )

  // A compound's sibling starts by itself, once.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!autoStart || autoStarted.current || !listing || (wantsDevices && devices === null)) return
    autoStarted.current = true
    updateNodeData(nodeId, { runAutoStart: undefined })
    void start()
  }, [autoStart, listing, wantsDevices, devices, start, nodeId, updateNodeData])

  const onFolder = useCallback(
    async (value: string) => {
      let dir: string | null = value
      if (value === CHOOSE_FOLDER) dir = await api.dialog.selectFolder()
      if (!dir || dir === cfgRef.current.projectDir) return
      patch({ projectDir: dir, launchConfig: undefined }, { changesRun: true })
    },
    [api, patch]
  )

  const onDevice = useCallback(
    (id: string) => {
      const d = devices?.find((x) => x.id === id)
      patch({ deviceId: id, deviceName: d?.name }, { changesRun: true })
    },
    [devices, patch]
  )

  // ── Terminal toggle + compact sizing ─────────────────────────────────────────────────────
  //
  // Hidden (the default), the node is just its control rows: the terminal body is hidden by CSS
  // (`.term-node:has(.run-bar--compact)`, the same `display: none` path collapse uses — xterm and
  // the tmux client stay alive) and the node's height is fitted to what is left. The height the
  // terminal had is remembered on the node (not persisted) and handed back on show.

  const showTerminal = !!config.showTerminal
  const barRef = useRef<HTMLDivElement>(null)

  const fitCompact = useCallback(() => {
    const bar = barRef.current
    const root = bar?.closest('.term-node') as HTMLElement | null
    if (!bar || !root) return
    let h = 0
    for (const child of Array.from(root.children) as HTMLElement[]) {
      if (child.classList.contains('term-node__body')) continue
      const pos = getComputedStyle(child).position
      if (pos === 'absolute' || pos === 'fixed') continue
      h += child.offsetHeight
    }
    const cs = getComputedStyle(root)
    h = Math.ceil(h + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0))
    if (h <= 0) return
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== nodeId || n.data.collapsed || n.height === h) return n
        return { ...n, height: h, style: { ...n.style, height: h } }
      })
    )
  }, [nodeId, setNodes])

  useLayoutEffect(() => {
    // With a simulator open the NODE's size is the user's: the panel fills it and scales with it.
    if (showTerminal || simulator || browserPanel) return
    const bar = barRef.current
    if (!bar) return
    fitCompact()
    const ro = new ResizeObserver(() => fitCompact())
    ro.observe(bar)
    return () => ro.disconnect()
  }, [showTerminal, simulator, browserPanel, fitCompact])

  // ── 📱 / 🌐 The preview panel, inside this node ────────────────────────────────────────────
  //
  // One panel under the control rows, of the kind the run calls for (`previewKindFor`): a simulator
  // for a run on a phone (its device preselected when it is one — an iOS UDID, or an Android
  // emulator's adb serial, which is what Flutter names it — else empty to pick any), a browser for a
  // run that targets one or serves a page (its URL from the launch configuration, or picked out of
  // the run's output once it prints one). The button opens and closes it; ⇱ pops it out into its
  // own node, whose ⇲ (or this button) docks it back. While it is open the panel fills the node, so
  // resizing the node scales it; the compact fit above stands down. Opening grows the node by a
  // panel's worth; closing hands it back (the compact fit, or the same amount with the terminal shown).

  const panelRef = useRef<HTMLDivElement>(null)
  const previewKind = previewKindFor({
    picksDevice: showDevice,
    deviceId: config.deviceId,
    deviceKind: device?.kind,
    browserConfig: !!entry?.browser,
    pinnedDeviceId: entry?.usesDevice ? entry.pinnedDevice : undefined
  })
  const panelOpen = !!simulator || !!browserPanel
  /** A panel popped out of this node into its own: its id and kind. Read as one primitive. */
  const poppedOutSig = useStore((st) => {
    for (const n of st.nodeLookup.values()) {
      if (n.type === 'simulator' && (n.data.simulator as SimulatorNodeConfig | undefined)?.dockTo === nodeId) return `simulator:${n.id}`
      if (n.type === 'browser' && n.data.dockTo === nodeId) return `browser:${n.id}`
    }
    return ''
  })
  const poppedOut = poppedOutSig ? { kind: poppedOutSig.slice(0, poppedOutSig.indexOf(':')) as PreviewKind, id: poppedOutSig.slice(poppedOutSig.indexOf(':') + 1) } : null
  browserOpenRef.current = !!browserPanel || poppedOut?.kind === 'browser'
  popOutRef.current = poppedOut

  /** The kind the button shows: an open or popped-out panel's own, else what the run calls for. */
  const shownKind: PreviewKind = simulator ? 'simulator' : browserPanel ? 'browser' : poppedOut ? poppedOut.kind : previewKind

  type Preview = { kind: 'simulator'; cfg: InlineSimulatorConfig } | { kind: 'browser'; cfg: RunBrowserConfig } | undefined

  /** Show `next` inside this node (or nothing), resizing the node around the change. `extra` adds or
   *  removes other nodes in the same update (pop out / dock back). */
  const setPreview = useCallback(
    (next: Preview, extra?: (ns: CanvasNode[]) => CanvasNode[]) => {
      const panelNow = panelRef.current?.offsetHeight || INLINE_SIM_HEIGHT
      setNodes((all) => {
        const ns = (extra ? extra(all as CanvasNode[]) : all) as CanvasNode[]
        return ns.map((n) => {
          if (n.id !== nodeId) return n
          const was = !!n.data.runSimulator || !!n.data.runBrowser
          const data = {
            ...n.data,
            runSimulator: next?.kind === 'simulator' ? next.cfg : undefined,
            runBrowser: next?.kind === 'browser' ? next.cfg : undefined
          }
          if (was === !!next) return { ...n, data }
          const showing = !!(n.data.runConfig as RunNodeConfig | undefined)?.showTerminal
          // Hidden terminal + closing: the compact fit takes the height back by itself.
          if (!next && !showing) return { ...n, data }
          const now = (n.height as number | undefined) ?? n.measured?.height ?? 0
          const height = Math.max(120, now + (next ? INLINE_SIM_HEIGHT : -panelNow))
          return { ...n, height, style: { ...n.style, height }, data }
        })
      })
    },
    [nodeId, setNodes]
  )

  setPreviewRef.current = setPreview

  /** ⇲ / the button on a popped-out panel: its node goes, and it comes back inside this one. */
  const dockBack = useCallback(
    (otherId: string) => {
      const other = getNodes().find((n) => n.id === otherId)
      if (!other) return
      const remove = (ns: CanvasNode[]) => ns.filter((n) => n.id !== otherId)
      if (other.type === 'browser') {
        const url = other.data.url as string | undefined
        setPreview({ kind: 'browser', cfg: isPreviewUrl(url) ? { url } : {} }, remove)
        return
      }
      const { dockTo: _d, ...device } = (other.data.simulator as SimulatorNodeConfig | undefined) ?? {}
      void _d
      setPreview({ kind: 'simulator', cfg: device }, remove)
    },
    [getNodes, setPreview]
  )

  // A popped-out node's ⇲ asks for this.
  useEffect(() => {
    const onDock = (e: Event) => {
      const d = (e as CustomEvent<{ nodeId?: string; runNodeId?: string }>).detail
      if (d?.runNodeId === nodeId && d.nodeId) dockBack(d.nodeId)
    }
    window.addEventListener('nodeterm:dock-preview', onDock)
    return () => window.removeEventListener('nodeterm:dock-preview', onDock)
  }, [nodeId, dockBack])

  /** The page this run shows: a browser configuration's own URL, else the newest local URL in the
   *  run's output. Null when there is none yet. */
  const browserUrlNow = useCallback(async (): Promise<RunBrowserConfig> => {
    if (entry?.browser) {
      const r = await api.runConfig.start(nodeId, cfgRef.current).catch(() => null)
      return r?.ok && r.kind === 'browser' && isPreviewUrl(r.url) ? { url: r.url } : {}
    }
    const text = await api.pty.capture(nodeId, true).catch(() => '')
    const url = localUrlFromOutput(text)
    return url ? { url, auto: true } : {}
  }, [api, nodeId, entry?.browser])

  // The run's own device (the configuration's, else the pick) — a Flutter web run when it is a
  // browser device, which shows here unless `embedBrowser` is off.
  const runDevice = entry?.usesDevice ? (entry.pinnedDevice ?? config.deviceId) : undefined
  const flutterWebRun = isWebDeviceId(runDevice)

  /** The button: hides an open panel, docks a popped-out one back, and otherwise shows the one this
   *  run calls for — a node runs one thing, so it is never a choice. */
  const onPreviewButton = () => {
    if (panelOpen) return setPreview(undefined)
    if (poppedOut) return dockBack(poppedOut.id)
    void openPreview(previewKind)
  }

  const openPreview = async (kind: PreviewKind) => {
    if (kind === 'browser') {
      if (flutterWebRun && running && config.embedBrowser === false) {
        say('info', 'This Flutter web run is in its own Chrome window — turn on ⋯ → “Show web inside this node” and run again to show it here.')
      }
      setPreview({ kind: 'browser', cfg: await browserUrlNow() })
      return
    }
    const id = showDevice ? config.deviceId : undefined
    let next: InlineSimulatorConfig = {}
    if (id && SIMULATOR_UDID.test(id)) next = { udid: id.toUpperCase(), name: device?.name ?? config.deviceName }
    else if (id && /^emulator-\d+$/.test(id)) {
      const avd = (await api.simulator.devices().catch(() => ({ devices: [] }))).devices.find((d) => d.serial === id)
      if (avd) next = { udid: avd.id, name: avd.name }
    }
    setPreview({ kind: 'simulator', cfg: next })
  }

  // An open panel follows the run: pick a browser device and the simulator becomes the browser, and
  // the other way round. The popped-out kind is left alone (the person moved it out on purpose).
  const openPreviewRef = useRef(openPreview)
  openPreviewRef.current = openPreview
  const openKind: PreviewKind | null = simulator ? 'simulator' : browserPanel ? 'browser' : null
  useEffect(() => {
    if (openKind && openKind !== previewKind) void openPreviewRef.current(previewKind)
  }, [openKind, previewKind])

  /** ⇱: the panel becomes its own node beside this one, which can dock back. */
  const popOut = () => {
    if (!simulator && !browserPanel) return
    setPreview(undefined, (ns) => {
      const src = ns.find((n) => n.id === nodeId)
      if (!src) return ns
      let node: CanvasNode
      if (simulator) node = createSimulatorNode(ns.length, { ...simulator, dockTo: nodeId })
      else {
        node = createBrowserNode(ns.length, browserPanel?.url ?? '')
        node.data = { ...node.data, dockTo: nodeId }
      }
      const w = src.measured?.width ?? (src.width as number | undefined) ?? 640
      node.position = { x: src.position.x + w + 40, y: src.position.y }
      return [...ns, src.parentId ? { ...node, parentId: src.parentId, extent: 'parent' as const } : node]
    })
  }

  const onSimConfig = useCallback(
    (next: SimulatorNodeConfig) => {
      updateNodeData(nodeId, (n) => (n.data.runSimulator ? { runSimulator: { ...next, dockTo: undefined } } : {}))
    },
    [nodeId, updateNodeData]
  )

  const onBrowserUrl = useCallback(
    (url: string) => {
      if (!isPreviewUrl(url)) return
      updateNodeData(nodeId, (n) => {
        const was = n.data.runBrowser as RunBrowserConfig | undefined
        if (!was || was.url === url) return {}
        return { runBrowser: { url, ...(was.auto ? { auto: true } : {}) } }
      })
    },
    [nodeId, updateNodeData]
  )

  // Waiting for a page: while the browser panel has none and the run is up, read its output until
  // it prints a local URL. A new run starts the wait over when the last URL was picked out of the
  // output (a dev server may come back on another port); a URL the person typed is kept.
  const lastRunning = useRef(running)
  useEffect(() => {
    const was = lastRunning.current
    lastRunning.current = running
    if (!was && running && browserPanel?.auto) updateNodeData(nodeId, { runBrowser: {} })
  }, [running, browserPanel?.auto, nodeId, updateNodeData])
  const waitingForUrl = !!browserPanel && !browserPanel.url && running && !entry?.browser
  useEffect(() => {
    if (!waitingForUrl) return
    let live = true
    const look = async () => {
      const text = await api.pty.capture(nodeId, true).catch(() => '')
      const url = live ? localUrlFromOutput(text) : null
      if (url) updateNodeData(nodeId, (n) => (n.data.runBrowser && !(n.data.runBrowser as RunBrowserConfig).url ? { runBrowser: { url, auto: true } } : {}))
    }
    void look()
    const t = setInterval(() => void look(), 1500)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [waitingForUrl, api, nodeId, updateNodeData])

  const toggleTerminal = useCallback(() => {
    const next = !showTerminal
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== nodeId) return n
        const runConfig = { ...((n.data.runConfig as RunNodeConfig | undefined) ?? cfgRef.current), showTerminal: next }
        const current = (n.measured?.height ?? (n.height as number | undefined)) || 0
        if (next) {
          const remembered = n.data.runTerminalHeight as number | undefined
          const height = Math.max(remembered ?? 0, terminalNodeSize().height)
          return { ...n, height, style: { ...n.style, height }, data: { ...n.data, runConfig } }
        }
        return { ...n, data: { ...n.data, runConfig, runTerminalHeight: current } }
      })
    )
  }, [showTerminal, nodeId, setNodes])

  // ── Render ───────────────────────────────────────────────────────────────────────────────

  const folderOptions = useMemo(() => {
    const set = new Set(projects)
    set.add(config.projectDir)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [projects, config.projectDir])

  const deviceLabel = (d: RunDevice) => {
    const used = claimsFor(d.id)
    const plat = d.platform ? (d.kind === 'simulator' ? ` · ${d.platform}` : ` (${d.platform})`) : ''
    const twin = devices?.some((o) => o.id !== d.id && o.name === d.name && o.platform === d.platform)
    return `${d.name}${plat}${twin ? ` · ${d.id.slice(0, 4)}` : ''}${used.length ? ` — in use by ${used[0]}` : ''}`
  }
  const booted = devices?.filter((d) => d.kind === 'simulator' && d.state === 'booted') ?? []
  const shutdown = devices?.filter((d) => d.kind === 'simulator' && d.state !== 'booted') ?? []
  const others = devices?.filter((d) => d.kind !== 'simulator') ?? []

  const configs = entries.filter((e) => e.kind === 'config')
  const compounds = entries.filter((e) => e.kind === 'compound')
  const entryOption = (e: LaunchEntry) => (
    <option key={e.name} value={e.name}>
      {e.name}
      {e.kind === 'config' ? ` · ${e.typeLabel}` : ''}
      {e.supported ? '' : ' (can’t run here)'}
    </option>
  )

  const browser = !!entry?.browser
  const canRun = !!entry?.supported && !busy
  const statusText =
    busy === 'booting'
      ? 'Booting simulator…'
      : busy === 'starting'
        ? 'Starting…'
        : busy === 'stopping'
          ? 'Stopping…'
          : busy === 'reloading'
            ? 'Hot reload'
            : busy === 'restarting'
              ? 'Hot restart'
              : running
                ? 'Running'
                : status?.exitCode
                  ? `Exited (${status.exitCode})`
                  : status
                    ? 'Stopped'
                    : ''
  const statusKind = busy ? 'busy' : running ? 'running' : status?.exitCode ? 'failed' : 'stopped'

  const blocker =
    listing?.error ??
    (listing && entries.length === 0 ? 'No .vscode/launch.json in this folder — choose another folder.' : null) ??
    (entry && !entry.supported ? entry.reason : null)

  return (
    <div ref={barRef} className={`run-bar nodrag nowheel${showTerminal ? '' : ' run-bar--compact'}${panelOpen ? ' run-bar--sim' : ''}`}>
      <div className="run-bar__row">
        <select
          className="run-bar__select run-bar__select--folder"
          value={config.projectDir}
          title={config.projectDir}
          onChange={(e) => void onFolder(e.target.value)}
        >
          {folderOptions.map((d) => (
            <option key={d} value={d}>
              {runDirLabel(d)}
            </option>
          ))}
          <option value={CHOOSE_FOLDER}>Choose folder…</option>
        </select>

        <select
          className="run-bar__select run-bar__select--config"
          value={entry?.name ?? NO_ENTRY}
          disabled={entries.length === 0}
          title={entry ? `${entry.name}${entry.preLaunchTask ? ` — runs “${entry.preLaunchTask}” first` : ''}` : ''}
          onChange={(e) => patch({ launchConfig: e.target.value }, { changesRun: true, entryName: e.target.value })}
        >
          {entries.length === 0 && <option value={NO_ENTRY}>{listing ? 'No configurations' : 'Loading…'}</option>}
          {configs.map(entryOption)}
          {compounds.length > 0 && <optgroup label="Compounds">{compounds.map(entryOption)}</optgroup>}
        </select>

        {entry?.usesDevice && entry.pinnedDevice && (
          <span className="run-bar__pinned" title="This configuration chooses its own device">
            {entry.pinnedDevice}
          </span>
        )}
        {showDevice && (
          <select
            className={`run-bar__select${claims.length ? ' run-bar__select--warn' : ''}`}
            value={config.deviceId ?? ''}
            title={
              claims.length
                ? `Also selected by ${claims.join(', ')} — two runs on one device replace each other`
                : (devicesError ?? device?.name ?? 'Device')
            }
            onChange={(e) => onDevice(e.target.value)}
          >
            {!config.deviceId && <option value="">{devices ? 'Pick a device…' : 'Loading devices…'}</option>}
            {config.deviceId && !device && <option value={config.deviceId}>{config.deviceName ?? config.deviceId}</option>}
            {booted.length > 0 && (
              <optgroup label="Running simulators">
                {booted.map((d) => (
                  <option key={d.id} value={d.id}>
                    {deviceLabel(d)}
                  </option>
                ))}
              </optgroup>
            )}
            {shutdown.length > 0 && (
              <optgroup label="Simulators (boots on run)">
                {shutdown.map((d) => (
                  <option key={d.id} value={d.id}>
                    {deviceLabel(d)}
                  </option>
                ))}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label="Other devices">
                {others.map((d) => (
                  <option key={d.id} value={d.id}>
                    {deviceLabel(d)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        )}
        <button
          type="button"
          className="run-bar__icon"
          title={showDevice ? 'Reload launch.json and devices' : 'Reload launch.json'}
          aria-label="Refresh"
          onClick={() => {
            loadEntries()
            if (wantsDevices) loadDevices(true)
          }}
        >
          ⟳
        </button>
      </div>

      <div className="run-bar__row">
        {running ? (
          <button type="button" className="run-bar__btn run-bar__btn--stop" title="Stop (Ctrl+C)" disabled={!!busy} onClick={() => void stop()}>
            <span className="run-bar__stop-glyph" aria-hidden /> Stop
          </button>
        ) : (
          <button
            type="button"
            className="run-bar__btn run-bar__btn--run"
            title={browser ? 'Open in a browser node' : entry?.kind === 'compound' ? 'Run every configuration in this compound' : 'Run'}
            disabled={!canRun}
            onClick={() => void start()}
          >
            <IconPlay /> {browser ? 'Open' : 'Run'}
          </button>
        )}
        {hotReload ? (
          <>
            <button type="button" className="run-bar__btn" title="Hot reload (r)" disabled={!running || !!busy} onClick={() => void signal('reload')}>
              ⚡ Reload
            </button>
            <button type="button" className="run-bar__btn" title="Hot restart (R)" disabled={!running || !!busy} onClick={() => void signal('restart')}>
              <IconReload /> Restart
            </button>
            <label className="run-bar__toggle" title="Hot reload when a .dart file under lib/ changes">
              <input type="checkbox" checked={config.reloadOnSave} onChange={(e) => patch({ reloadOnSave: e.target.checked })} />
              Reload on save
            </label>
          </>
        ) : (
          !browser && (
            <button type="button" className="run-bar__btn" title="Stop and run again" disabled={!running || !!busy} onClick={() => void restart()}>
              <IconReload /> Restart
            </button>
          )
        )}
        {needsRerun && running && (
          <button
            type="button"
            className="run-bar__btn run-bar__btn--accent"
            title="Stop and run again with the new folder, configuration or device"
            disabled={!!busy}
            onClick={() => void restart()}
          >
            Apply &amp; re-run
          </button>
        )}

        <span className="run-bar__spacer" />

        <span className={`run-bar__status run-bar__status--${statusKind}`}>{statusText}</span>
        {simulatorAvailable() && (
          <>
            {browserPanel && (
              <button type="button" className="run-bar__icon" title="Pop the browser out into its own node" aria-label="Pop out" onClick={popOut}>
                ⇱
              </button>
            )}
            <button
              type="button"
              className={`run-bar__icon${panelOpen || poppedOut ? ' run-bar__icon--on' : ''}`}
              title={previewButtonTitle(shownKind, panelOpen, !!poppedOut)}
              aria-label={panelOpen ? `Hide the ${shownKind}` : `Show the ${shownKind}`}
              aria-pressed={panelOpen}
              onClick={onPreviewButton}
            >
              {shownKind === 'browser' ? '🌐' : '📱'}
            </button>
          </>
        )}
        <button
          type="button"
          className={`run-bar__icon${showTerminal ? ' run-bar__icon--on' : ''}`}
          title={showTerminal ? 'Hide the terminal' : 'Show the terminal and extra arguments'}
          aria-label={showTerminal ? 'Hide the terminal' : 'Show the terminal'}
          aria-pressed={showTerminal}
          onClick={toggleTerminal}
        >
          ⋯
        </button>
      </div>

      {showTerminal && (
        <div className="run-bar__row">
          <input
            className="run-bar__args"
            placeholder="Extra arguments, e.g. --dart-define=API_BASE_URL=http://localhost:8081/api/"
            value={argsDraft}
            spellCheck={false}
            onChange={(e) => setArgsDraft(e.target.value)}
            onBlur={() => patch({ extraArgs: argsDraft.trim() || undefined }, { changesRun: true })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              e.stopPropagation()
            }}
          />
          {flutterWebRun && (
            <label
              className="run-bar__check"
              title="On: Flutter’s web server serves the app to the browser inside this node. Off: Flutter opens its own Chrome window."
            >
              <input
                type="checkbox"
                checked={config.embedBrowser !== false}
                onChange={(e) => patch({ embedBrowser: e.target.checked ? undefined : false }, { changesRun: true })}
              />
              Show web inside this node
            </label>
          )}
        </div>
      )}

      {(note || blocker) && (
        <div className={`run-bar__note run-bar__note--${note?.kind ?? 'error'}`}>{note?.text ?? blocker}</div>
      )}

      {browserPanel && (
        <div ref={panelRef} className="run-sim-host">
          <div className="run-web">
            <BrowserSurface
              nodeId={`${nodeId}.web`}
              url={browserPanel.url ?? ''}
              onUrlChange={onBrowserUrl}
              onTitleChange={ignoreTitle}
              blank={
                <div className="run-web__waiting">
                  {running ? 'Waiting for the run to print its local address… or type one above.' : 'Run it to show its page here — or type an address above.'}
                </div>
              }
            />
          </div>
        </div>
      )}
      {simulator && (
        <div ref={panelRef} className="run-sim-host">
          <SimulatorView
            streamId={`${nodeId}.sim`}
            config={simulator}
            onConfig={onSimConfig}
            label={simulator.name ?? 'Simulator'}
            className="run-sim"
            barExtras={
              <button className="run-bar__icon" title="Pop out into its own node" aria-label="Pop out" onClick={popOut}>
                ⇱
              </button>
            }
          />
        </div>
      )}
    </div>
  )
}

/** The browser panel keeps no title (the run node has its own); stable, so the page's listeners
 *  are not re-attached on every render. */
function ignoreTitle(): void {}

function previewButtonTitle(kind: PreviewKind, open: boolean, poppedOut: boolean): string {
  const what = kind === 'browser' ? 'browser' : 'simulator'
  if (open) return `Hide the ${what}`
  if (poppedOut) return `Dock the ${what} back into this node`
  return 'Show a simulator or a browser here'
}
