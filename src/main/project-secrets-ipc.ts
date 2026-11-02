// Project secrets — the desktop main-process leg (docs/project-secrets.md).
//
// Raw ipcMain handlers, each refusing any sender that is not the live main window: a `<webview>`
// guest is a webContents in this process too (Electron security checklist #17, "validate the sender
// of all IPC messages"). Not on the CorePlatform table, so no relay peer and no Server Edition
// browser can reach them; they are also in HOST_ONLY_CHANNELS as a belt.
//
// The fetch runs only after TWO human acts: the click in the renderer's Secrets dialog, and the
// "Fetch secrets" answer in the native confirmation this file raises — so a compromised renderer
// cannot start a fetch by itself, and what the person approves is the exact command list main is
// about to run (`displayCommand`), read from this process's own index and settings, never from the
// renderer.
//
// A pasted secret (a declaration with no command) is typed into a small window this process opens
// (`secret-entry-window.ts`), never into the canvas window; the click in the Secrets dialog only
// asks for that window.

import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../shared/ipc'
import { resolveProjectSettings } from '../shared/project-settings'
import {
  displayCommand,
  normalizeCrossProjectSecretsPolicy,
  type CrossProjectSecretsGate,
  type ProjectSecretsAuthorizeResult,
  type ProjectSecretsPasteResult,
  type ProjectSecretsView
} from '../shared/project-secrets'
import {
  ProjectSecretsService,
  type DeclarationsRead,
  type DeclaredSecret
} from '../core/project-secrets'
import type { WorkspaceStore } from '../core/workspace-store'
import { promptSecretEntry } from './secret-entry-window'
import type { Settings } from '../shared/types'

export interface ProjectSecretsIpcDeps {
  workspace: Pick<WorkspaceStore, 'projectTargetInfo' | 'readProjectSettings' | 'openProjectFolders' | 'onSaved'>
  settings: () => Pick<Settings, 'projectSecretsCrossProject'>
  mainWindow: () => BrowserWindow | null | undefined
}

/** The project's declarations as THIS process reads them. SSH and cwd-less projects are refused
 *  by name. Exported for tests. */
export async function readDeclarationsFrom(
  workspace: ProjectSecretsIpcDeps['workspace'],
  projectId: string
): Promise<DeclarationsRead> {
  const info = workspace.projectTargetInfo(projectId)
  if (!info) return { kind: 'unavailable', reason: 'unknown-project' }
  if (info.ssh) return { kind: 'unavailable', reason: 'ssh' }
  if (!info.cwd) return { kind: 'unavailable', reason: 'no-folder' }
  const snap = await workspace.readProjectSettings(projectId)
  const resolved = resolveProjectSettings(snap?.local, snap?.shared ?? undefined).agents.secrets
  const secrets: DeclaredSecret[] = (resolved?.value ?? []).map((decl) => ({
    decl: decl.command ? { env: decl.env, command: [...decl.command] } : { env: decl.env },
    source: resolved!.source
  }))
  return { kind: 'ok', cwd: info.cwd, secrets }
}

/** The native confirmation's text. Exported for tests (it must never contain a value — it is
 *  built before any fetch runs, from declarations only). */
export function confirmText(projectName: string, secrets: DeclaredSecret[]): { message: string; detail: string } {
  const shared = secrets.some((s) => s.source === 'shared')
  const lines = secrets.map((s) => `${s.decl.env}  ←  ${displayCommand(s.decl.command ?? [])}`)
  return {
    message: `Run ${secrets.length === 1 ? 'this command' : `these ${secrets.length} commands`} for “${projectName}” and give the values to its agent nodes?`,
    detail: [
      ...lines,
      '',
      shared
        ? 'Declared in the project’s .nodeterm/settings.json, which is shared with everyone who has the repository. Run only commands you recognise.'
        : 'Declared in this machine’s local project settings.',
      'Each command runs once, in the project folder, without a shell. The values stay in nodeterm’s memory until you quit, close the project or clear them; they are never written to disk.'
    ].join('\n')
  }
}

export function registerProjectSecretsIpc(deps: ProjectSecretsIpcDeps): ProjectSecretsService {
  const service = new ProjectSecretsService({
    readDeclarations: (projectId) => readDeclarationsFrom(deps.workspace, projectId),
    crossProjectPolicy: () => normalizeCrossProjectSecretsPolicy(deps.settings().projectSecretsCrossProject),
    confirm: async (projectId, secrets) => {
      const win = deps.mainWindow()
      if (!win || win.isDestroyed()) return false
      const name = deps.workspace.projectTargetInfo(projectId)?.name ?? 'this project'
      const { message, detail } = confirmText(name, secrets)
      const answer = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Fetch project secrets',
        message,
        detail,
        buttons: ['Cancel', 'Fetch secrets'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return answer.response === 1
    },
    promptValue: async (projectId, secret, check) => {
      const win = deps.mainWindow()
      if (!win || win.isDestroyed()) return null
      const name = deps.workspace.projectTargetInfo(projectId)?.name ?? 'this project'
      return promptSecretEntry({ parent: win, projectName: name, env: secret.decl.env, check })
    }
  })

  const fromMain = (event: IpcMainInvokeEvent): boolean => {
    const win = deps.mainWindow()
    return !!win && !win.isDestroyed() && win.webContents.id === event.sender.id
  }
  const refusedView: ProjectSecretsView = { unavailable: 'unsupported', secrets: [] }
  const id = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null)

  ipcMain.handle(IPC.projectSecretsStatus, async (event, projectId: unknown): Promise<ProjectSecretsView> => {
    const pid = id(projectId)
    if (!fromMain(event) || !pid) return refusedView
    return service.status(pid)
  })
  ipcMain.handle(
    IPC.projectSecretsAuthorize,
    async (event, projectId: unknown): Promise<ProjectSecretsAuthorizeResult> => {
      const pid = id(projectId)
      if (!fromMain(event) || !pid) return { kind: 'refused', reason: 'unsupported', view: refusedView }
      return service.authorize(pid)
    }
  )
  ipcMain.handle(
    IPC.projectSecretsPaste,
    async (event, projectId: unknown, env: unknown): Promise<ProjectSecretsPasteResult> => {
      const pid = id(projectId)
      const name = typeof env === 'string' && env.length > 0 && env.length <= 128 ? env : null
      if (!fromMain(event) || !pid || !name) return { kind: 'refused', reason: 'unsupported', view: refusedView }
      return service.paste(pid, name)
    }
  )
  ipcMain.handle(IPC.projectSecretsClear, async (event, projectId: unknown): Promise<ProjectSecretsView> => {
    const pid = id(projectId)
    if (!fromMain(event) || !pid) return refusedView
    return service.clear(pid)
  })
  ipcMain.handle(
    IPC.projectSecretsCrossGate,
    async (event, projectId: unknown, nodeId: unknown): Promise<CrossProjectSecretsGate> => {
      const pid = id(projectId)
      // An empty node id is allowed: an open that has not minted its nodes yet asks "would this
      // project ask?" (no node can have a decision then).
      const nid = nodeId === '' ? '' : id(nodeId)
      // Refused = start without secrets: proceeding never GRANTS (spawnEnv still says no).
      if (!fromMain(event) || !pid || nid === null) return { kind: 'proceed' }
      return service.crossProjectGate(pid, nid)
    }
  )
  ipcMain.handle(
    IPC.projectSecretsCrossDecide,
    async (event, projectId: unknown, nodeId: unknown, grant: unknown): Promise<void> => {
      const pid = id(projectId)
      const nid = id(nodeId)
      if (!fromMain(event) || !pid || !nid) return
      service.decideCrossProject(pid, nid, grant === true)
    }
  )

  service.onChanged((projectId) => {
    const win = deps.mainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.projectSecretsChanged, projectId)
  })
  // Closing, deleting or re-binding a project drops its values: every workspace write re-checks.
  deps.workspace.onSaved(() => service.retainProjects(deps.workspace.openProjectFolders()))
  return service
}
