/**
 * The platform seam of the Server Edition split: everything in src/core talks
 * to its shell (Electron main today, the Linux server later) only through this
 * interface. src/core must never import 'electron' (see no-electron.test.ts).
 */
export interface CorePlatform {
  /** Root for all persistent state (Electron: app.getPath('userData')). */
  readonly userDataDir: string
  readonly appVersion: string
  readonly isPackaged: boolean
  /** Electron's `process.resourcesPath` — `<app>/Contents/Resources` in a packaged build, where
   *  extraResources (today: the bundled tmux, see tmux-hint.ts `bundledTmuxPath`) land. OPTIONAL
   *  because it is an Electron notion: the Server Edition has no such directory and simply omits
   *  it, which is also how src/core stays Electron-free (no-electron.test.ts). */
  readonly resourcesPath?: string
  /** Electron's `app.getAppPath()` — `<resourcesPath>/app.asar` when packaged, the repo root in
   *  dev. This is where `build.files` carries `out/**`, so it is where the session-host bundle
   *  lands; see session-host-launcher.ts for why it must be resolved from INSIDE the asar rather
   *  than copied beside it. OPTIONAL for the same reason as `resourcesPath`: an Electron notion
   *  the Server Edition omits. */
  readonly appPath?: string
  /** Seal / unseal a secret at rest, byte-in byte-out. Present together on a shell that can
   *  encrypt (Desktop: Electron safeStorage). Their ABSENCE is a supported configuration, not a
   *  degradation: the Server Edition runs headless with no OS keychain and deliberately stores
   *  node secrets as raw 0600 bytes instead. A shell supplies BOTH hooks or NEITHER — supplying
   *  exactly one is a programming error that node-auth-secret.ts rejects. */
  sealSecret?(b: Buffer): Buffer
  unsealSecret?(b: Buffer): Buffer
  /** Register a request/response RPC handler (Electron: ipcMain.handle, event stripped). */
  handle(channel: string, fn: (...args: any[]) => unknown): void
  /** Register a fire-and-forget handler (Electron: ipcMain.on, event stripped). */
  on(channel: string, fn: (...args: any[]) => void): void
  /** Like handle, but fn receives the calling UI's numeric id first (Electron: event.sender.id). */
  handleWithSender(channel: string, fn: (senderId: number, ...args: any[]) => unknown): void
  /** Like on, but fn receives the calling UI's numeric id first (Electron: event.sender.id).
   *  The seam presence (and, later, typing attribution) needs: a cast must say WHO sent it. */
  onWithSender(channel: string, fn: (senderId: number, ...args: any[]) => void): void
  /** Send to one attached UI by id (Electron: webContents.fromId). Silently drops if gone. */
  sendTo(uiId: number, channel: string, ...args: any[]): void
  /** Send to every attached UI (Electron: the main window). */
  broadcast(channel: string, ...args: any[]): void
  /** Ids of every attached UI, in attach order (Server: each authenticated WS connection;
   *  Electron: the main window, or none while it is closed). Lets a service address "everyone
   *  EXCEPT the sender", which broadcast() cannot express — see src/core/canvas-sync.ts. */
  clientIds(): number[]
  /** Open a URL in the user's default browser. */
  openExternal(url: string): Promise<void>
}

let current: CorePlatform | null = null

export function initPlatform(p: CorePlatform): void {
  current = p
}

export function platform(): CorePlatform {
  if (!current) throw new Error('core platform not initialized — call initPlatform() at boot')
  return current
}

export function resetPlatformForTests(): void {
  current = null
}
