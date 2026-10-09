import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useReactFlow, useStore } from '@xyflow/react'
import {
  attachConnected,
  canHotSwitch,
  deviceClaims,
  resolveEntry,
  runDirLabel,
  runNodeTitle,
  type LaunchEntry,
  type RunDevice,
  type RunEntriesResult,
  type RunNodeConfig,
  type RunSnapshot,
  type RunStatus
} from '@shared/run-config'
import { isShellCommand } from '@shared/agents/pane'
import { useSession } from '../session/session'
import { useProjects } from '../state/projects'
import { terminalNodeSize, type CanvasNode } from '../state/workspace'
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

type Busy = 'booting' | 'starting' | 'stopping' | 'reloading' | 'restarting' | 'switching' | null

const CHOOSE_FOLDER = '\u0000choose'
const NO_ENTRY = '\u0000none'

interface Props {
  nodeId: string
  config: RunNodeConfig
  /** A compound's sibling: start the run once on mount. */
  autoStart: boolean
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

export function RunBar({ nodeId, config, autoStart }: Props) {
  const { api } = useSession()
  const { updateNodeData, setNodes } = useReactFlow()
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
  /** The entry the node resolves to now (kept current below), for callbacks and the status poll. */
  const entryRef = useRef<LaunchEntry | undefined>(undefined)
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
  entryRef.current = entry

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
  /** What the live run was started from — what a folder switch must match to keep the app.
   *  Set at Run; recovered from the node's config when the run was already going at mount (the
   *  config cannot have changed before this view existed to change it). Cleared when it ends. */
  const runningRef = useRef<RunSnapshot | null>(null)
  const pollStatus = useCallback(async () => {
    const s = await api.runConfig.status(nodeId)
    if (!mounted.current) return s.running
    if (!s.running && !stoppingRef.current) runningRef.current = null
    if (s.running && !runningRef.current && entryRef.current) {
      const c = cfgRef.current
      runningRef.current = { projectDir: c.projectDir, deviceId: c.deviceId, flavor: entryRef.current.flavor, hotReload: entryRef.current.hotReload }
    }
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
        window.dispatchEvent(new CustomEvent('nodeterm:open-url-node', { detail: { url: r.url, sourceNodeId: nodeId } }))
        if (!/^https?:\/\//i.test(r.url)) say('error', `Only http(s) URLs open in a browser node (${r.url}).`)
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
      runningRef.current = { projectDir: cfg.projectDir, deviceId: cfg.deviceId, flavor: target?.flavor, hotReload: r.hotReload }
      const sent = await api.pty.sendText(nodeId, r.command)
      setNeedsRerun(false)
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

  /**
   * Switch the running Flutter app to the node's (new) folder WITHOUT rebuilding it:
   *  1. `d` — flutter run/attach's own "detach": the tool exits, the app keeps running;
   *  2. `flutter attach` from the new folder, to the same device;
   *  3. once it has connected, a hot RESTART (SIGUSR2). Not a reload: a freshly attached tool only
   *     pushes files that change after it connected, so the new checkout's code would mostly not
   *     reach the app. A restart pushes the whole program — the app's state resets, nothing native
   *     is rebuilt.
   * Every failure leaves the app running and says so; Rebuild stays one click away.
   */
  const switchKeepApp = useCallback(async () => {
    const cfg = cfgRef.current
    setBusy('switching')
    stoppingRef.current = true
    await api.pty.sendText(nodeId, 'd', { enter: false })
    const detached = await waitStopped(10_000)
    stoppingRef.current = false
    if (!detached) {
      setBusy(null)
      say('error', 'The running tool did not detach — open ⋯ to check the terminal.')
      return
    }
    const r = await api.runConfig.start(nodeId, cfg, { attach: true })
    if (!r.ok || r.kind !== 'process') {
      setBusy(null)
      say('error', `${r.ok ? 'Could not attach.' : r.error} The app is still running on the device; Rebuild restarts it from this folder.`)
      return
    }
    const sent = await api.pty.sendText(nodeId, r.command)
    if (sent !== true) {
      setBusy(null)
      say('error', sent === 'pasted-not-submitted' ? 'The attach command is in the terminal — press Enter.' : 'Could not type into this terminal.')
      return
    }
    // Wait for the attach to connect (it prints its key help once it has). Discovering the app
    // can take a while on a busy simulator; an attach that exits early has failed.
    let connected = false
    let sawRunning = false
    const deadline = Date.now() + 120_000
    while (mounted.current && Date.now() < deadline) {
      if (attachConnected(await api.pty.capture(nodeId))) {
        connected = true
        break
      }
      const alive = await pollStatus()
      if (alive) sawRunning = true
      else if (sawRunning) break
      await sleep(700)
    }
    if (!mounted.current) return
    if (!connected) {
      setBusy(null)
      say('error', 'flutter attach did not connect — open ⋯ to see why. Rebuild starts the app from this folder.')
      return
    }
    const restarted = await api.runConfig.signal(nodeId, 'restart')
    runningRef.current = { projectDir: cfg.projectDir, deviceId: cfg.deviceId, flavor: entryRef.current?.flavor, hotReload: true }
    setNeedsRerun(false)
    setBusy(null)
    say(
      restarted ? 'info' : 'error',
      restarted
        ? `Switched to ${runDirLabel(cfg.projectDir)} without rebuilding — hot restarted (the app's state was reset).`
        : 'Attached, but the hot restart failed — press R in the terminal.'
    )
  }, [api, nodeId, waitStopped, pollStatus, say])

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
    if (showTerminal) return
    const bar = barRef.current
    if (!bar) return
    fitCompact()
    const ro = new ResizeObserver(() => fitCompact())
    ro.observe(bar)
    return () => ro.disconnect()
  }, [showTerminal, fitCompact])

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
  // Folder/configuration changed under a running Flutter app that the new choice would build the
  // same way: offer to switch without rebuilding (canHotSwitch states the rule).
  const hotSwitch = canHotSwitch(runningRef.current, { config, entry })
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
              : busy === 'switching'
                ? 'Switching…'
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
    <div ref={barRef} className={`run-bar nodrag nowheel${showTerminal ? '' : ' run-bar--compact'}`}>
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
        {needsRerun && running && hotSwitch && (
          <>
            <button
              type="button"
              className="run-bar__btn run-bar__btn--accent"
              title="Keep the app on the device: detach, attach from the new folder, hot restart. Its state resets; nothing native is rebuilt."
              disabled={!!busy}
              onClick={() => void switchKeepApp()}
            >
              ⇄ Switch (keep app)
            </button>
            <button
              type="button"
              className="run-bar__btn"
              title="Stop and run again from scratch — needed when the folders differ in native code (plugins, ios/, Info.plist)"
              disabled={!!busy}
              onClick={() => void restart()}
            >
              Rebuild
            </button>
          </>
        )}
        {needsRerun && running && !hotSwitch && (
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
        </div>
      )}

      {(note || blocker) && (
        <div className={`run-bar__note run-bar__note--${note?.kind ?? 'error'}`}>{note?.text ?? blocker}</div>
      )}
    </div>
  )
}
