/**
 * Pure copy and decisions for the project Secrets dialog (components/ProjectSecretsDialog.tsx) and
 * the cross-project prompt on a terminal node. Names and states only: the renderer never holds a
 * value (docs/project-secrets.md).
 */
import type {
  ProjectSecretState,
  ProjectSecretStatus,
  ProjectSecretsAuthorizeResult,
  ProjectSecretsPasteResult,
  ProjectSecretsUnsupported,
  ProjectSecretsView
} from '@shared/project-secrets'
import { REPO_URL } from './bugReport'

/** The user guide (docs/project-secrets.md): how to declare, paste and fetch. Linked from the
 *  Secrets dialog, so a person who has never read it can find it where they need it. */
export const SECRETS_GUIDE_URL = `${REPO_URL}/blob/main/docs/project-secrets.md`

export const SECRET_STATE_LABEL: Record<ProjectSecretState, string> = {
  'not-fetched': 'Not fetched',
  available: 'In memory',
  failed: 'Fetch failed',
  'declaration-changed': 'Declaration changed — paste or fetch again'
}

export const SECRETS_UNAVAILABLE_TEXT: Record<ProjectSecretsUnsupported, string> = {
  unsupported: 'Project secrets are available in the desktop app only.',
  ssh: 'Project secrets are not available for SSH projects yet: a value would have to be sent to the host.',
  'no-folder': 'This project has no folder, so it has no .nodeterm/settings.json to declare secrets in.',
  'unknown-project': 'This project is not known on this computer.'
}

/** May the Secrets menu row be offered for this project at all? Desktop, a local folder project. */
export function secretsMenuOffered(project: { cwd?: string; ssh?: unknown; remote?: unknown }, browser: boolean): boolean {
  return !browser && !project.remote && !project.ssh && !!project.cwd
}

/** The secrets whose value comes from a command (the Fetch button runs those; pasted ones have
 *  their own button per row). */
export function fetchedSecrets(view: ProjectSecretsView | null): ProjectSecretStatus[] {
  return view?.secrets.filter((s) => s.input === 'command') ?? []
}

/** The Fetch button's label: "again" once anything was fetched or attempted this run. */
export function fetchButtonLabel(view: ProjectSecretsView): string {
  return fetchedSecrets(view).some((s) => s.state !== 'not-fetched') ? 'Fetch again…' : 'Fetch secrets…'
}

/** Is the Fetch button shown at all? Only when some secret has a command. */
export function fetchOffered(view: ProjectSecretsView | null): boolean {
  return !!view && !view.unavailable && fetchedSecrets(view).length > 0
}

export function canFetch(view: ProjectSecretsView | null, busy: boolean): boolean {
  return !busy && fetchOffered(view)
}

/** A pasted row's button: "Replace" once a value is held for it. */
export function pasteButtonLabel(s: ProjectSecretStatus): string {
  return s.state === 'available' ? 'Replace value…' : 'Paste value…'
}

/** One line after a paste attempt. */
export function pasteSummary(env: string, r: ProjectSecretsPasteResult): string | null {
  if (r.kind === 'cancelled') return `Nothing was kept for ${env}.`
  if (r.kind === 'refused') {
    if (r.reason === 'not-pasted') return `${env} is no longer declared as a pasted secret.`
    if (r.reason === 'busy') return 'Another fetch or paste for this project is still open.'
    return SECRETS_UNAVAILABLE_TEXT[r.reason]
  }
  return `${env} is in memory.`
}

export function canClear(view: ProjectSecretsView | null, busy: boolean): boolean {
  return !!view && !busy && view.secrets.some((s) => s.state === 'available' || s.state === 'declaration-changed' || s.state === 'failed')
}

/** One line after an authorization, naming counts only. */
export function authorizeSummary(r: ProjectSecretsAuthorizeResult): string | null {
  if (r.kind === 'cancelled') return 'Nothing was fetched.'
  if (r.kind === 'refused') {
    if (r.reason === 'nothing-declared') return 'This project declares no secrets that are fetched by a command.'
    if (r.reason === 'busy') return 'A fetch for this project is already running.'
    return SECRETS_UNAVAILABLE_TEXT[r.reason]
  }
  const ok = r.view.secrets.filter((s) => s.state === 'available').length
  const failed = r.view.secrets.filter((s) => s.state === 'failed').length
  const parts = [`${ok} of ${r.view.secrets.length} in memory`]
  if (failed) parts.push(`${failed} failed`)
  return parts.join(', ') + '.'
}

/** The example declaration shown when a project declares none: one pasted, one fetched. Generic
 *  on purpose: any program that prints the value works. */
export const SECRETS_EXAMPLE = `{
  "agents": {
    "secrets": [
      { "env": "API_TOKEN" },
      { "env": "DB_PASSWORD", "command": ["./scripts/print-db-password"] }
    ]
  }
}`

/** The cross-project prompt on a node, from the names that would be given. */
export function crossProjectPromptText(projectName: string, names: string[]): string {
  const list = names.join(', ')
  return `An agent of another project opened this node in “${projectName}”. Give it this project’s secrets (${list})?`
}

/**
 * Appended to an open's reply when the target project's cross-project policy is 'ask': the opening
 * agent learns that the node's terminal waits for the person, so it must ask them.
 */
export function crossProjectAskReplyClause(projectName: string): string {
  return (
    ` — "${projectName}" holds secrets for its agents: each node opened here waits until the person ` +
    'answers, in that node, whether it receives them. Ask the person to open the project and answer; ' +
    'until then the node does not start'
  )
}
