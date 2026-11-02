/**
 * Pure copy and decisions for the project Secrets dialog (components/ProjectSecretsDialog.tsx) and
 * the cross-project prompt on a terminal node. Names and states only: the renderer never holds a
 * value (docs/project-secrets.md).
 */
import type {
  ProjectSecretState,
  ProjectSecretsAuthorizeResult,
  ProjectSecretsUnsupported,
  ProjectSecretsView
} from '@shared/project-secrets'

export const SECRET_STATE_LABEL: Record<ProjectSecretState, string> = {
  'not-fetched': 'Not fetched',
  available: 'In memory',
  failed: 'Fetch failed',
  'declaration-changed': 'Declaration changed — fetch again'
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

/** The Fetch button's label: "again" once anything was fetched or attempted this run. */
export function fetchButtonLabel(view: ProjectSecretsView): string {
  return view.secrets.some((s) => s.state !== 'not-fetched') ? 'Fetch again…' : 'Fetch secrets…'
}

export function canFetch(view: ProjectSecretsView | null, busy: boolean): boolean {
  return !!view && !busy && !view.unavailable && view.secrets.length > 0
}

export function canClear(view: ProjectSecretsView | null, busy: boolean): boolean {
  return !!view && !busy && view.secrets.some((s) => s.state === 'available' || s.state === 'declaration-changed' || s.state === 'failed')
}

/** One line after an authorization, naming counts only. */
export function authorizeSummary(r: ProjectSecretsAuthorizeResult): string | null {
  if (r.kind === 'cancelled') return 'Nothing was fetched.'
  if (r.kind === 'refused') {
    if (r.reason === 'nothing-declared') return 'This project declares no secrets.'
    if (r.reason === 'busy') return 'A fetch for this project is already running.'
    return SECRETS_UNAVAILABLE_TEXT[r.reason]
  }
  const ok = r.view.secrets.filter((s) => s.state === 'available').length
  const failed = r.view.secrets.filter((s) => s.state === 'failed').length
  const parts = [`${ok} of ${r.view.secrets.length} in memory`]
  if (failed) parts.push(`${failed} failed`)
  return parts.join(', ') + '.'
}

/** The example declaration shown when a project declares none. Generic on purpose: any program
 *  that prints the value works. */
export const SECRETS_EXAMPLE = `{
  "agents": {
    "secrets": [
      { "env": "API_TOKEN", "command": ["./scripts/print-api-token"] }
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
