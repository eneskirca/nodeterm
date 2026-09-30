import { parseControlRequest } from '../core/canvas-control-core'
import type { ServerControlReply } from './headless-node-factory'

/**
 * The Server Edition's answer to `/control/*`: a NAMED, permanent refusal.
 *
 * `src/server/index.ts` starts the same hook server as the desktop but never calls
 * `setControlHandler`, so every control verb fell through to the null branch's
 * `{ ok: false, error: 'control unavailable' }` → HTTP 400. That sentence reads to a language model
 * exactly like a transient outage, **and a model retries an outage** — so an agent on a headless
 * host burned its turns re-sending a request that can never succeed, and the operator saw a stream
 * of 400s with nothing naming the cause.
 *
 * Registering a refusing handler rather than leaving the branch null is deliberate: the refusal
 * then travels the same reply shape as every other verb (JSON gets a machine-readable `error`, the
 * POSIX-sh shim gets one printable line), and nobody has to special-case "unavailable" downstream.
 *
 * Shared with the agent-messaging plan by agreement — one string, one mechanism, every verb.
 */

/** The machine-readable name. Structured clients key on this, never on the prose. */
export const CONTROL_UNSUPPORTED_ERROR = 'control-unsupported-on-this-edition'

/**
 * The prose, which must say the thing a retrying model needs to hear IN WORDS: the literal
 * "do not retry". A refusal that only a status code distinguishes from an outage is not a refusal
 * an agent can act on.
 */
export const CONTROL_UNSUPPORTED_SENTENCE =
  'Canvas control is not available on the nodeterm Server Edition. This is permanent on this ' +
  'host, not a temporary failure — do not retry.'

/**
 * `browser` gets one extra clause naming WHY it is structural, so nobody files it as unimplemented
 * and nobody tries to implement it here. A browser node on this edition renders in the VIEWER's own
 * Chrome tab: there is no Electron, no `webContents`, no `<webview>` and no CDP on this host, and
 * the server has no debugger for a page in somebody else's browser and never can.
 */
export const BROWSER_UNSUPPORTED_CLAUSE =
  'There is no browser control on this edition: a browser node here renders in your own browser ' +
  'tab, which this server has no debugger for.'

/**
 * One line, always — control replies are rendered as a single line by the shim, and a multi-line
 * body buries whichever half the reader stops at. The machine name is repeated inside the prose so
 * the text/plain dialect (which carries no `error` field) still names the refusal.
 */
export function controlUnsupportedMessage(verb: string): string {
  const why = verb === 'browser' ? ` ${BROWSER_UNSUPPORTED_CLAUSE}` : ''
  return `${CONTROL_UNSUPPORTED_ERROR}: ${CONTROL_UNSUPPORTED_SENTENCE}${why}`
}

/**
 * What `src/server/index.ts` hands to `hookServer.setControlHandler` while the feature flag is
 * OFF. This preserves the pre-Phase-1 response byte-for-byte, which is both the safe upgrade
 * default and the explicit rollback path.
 */
export async function serverEditionControlHandler({ verb }: { verb: string }): Promise<{
  ok: false
  error: string
  message: string
}> {
  return { ok: false, error: CONTROL_UNSUPPORTED_ERROR, message: controlUnsupportedMessage(verb) }
}

export interface ServerEditionControlActions {
  openProject(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply>
  openTerminal(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply>
  openAgent(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply>
  close(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply>
  link(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply>
  group(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply>
  rename(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply>
  color(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply>
  sticky(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply>
  /** Reads only; `--set` is refused by name (src/server/settings-control.ts). */
  settings(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply>
  /** `run --node <id>` (#925): deliver a retained launch for the node's creator. */
  run(sourceNodeId: string, args: Record<string, string>, verified: boolean): Promise<ServerControlReply>
  /** `report-outcome` (@shared/station-outcome): a station's report about ITSELF — no creator check,
   *  because it touches no other node. */
  reportOutcome(sourceNodeId: string, args: Record<string, string>, verified: boolean): Promise<ServerControlReply>
  /** `issues` / `prs` (core/github/control-read.ts): the board's GitHub lane, read-only, from the
   *  GitHub service's cache. The caller's own project only (this edition keeps no grant ledger). */
  githubRead(verb: 'issues' | 'prs', sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply>
  deliver(input: {
    verb: 'send' | 'reply' | 'notify'
    sourceNodeId: string
    targetNodeId: string
    body: string
  }): Promise<ServerControlReply>
}

const SERVER_V1_VERBS: ReadonlySet<string> = new Set([
  'open-project',
  'open-terminal',
  'open-agent',
  'close',
  'link',
  'group',
  'rename',
  'color',
  'send',
  'reply',
  'notify',
  'sticky',
  'settings',
  'run',
  'report-outcome',
  'issues',
  'prs'
])

/** A permanent, verb-specific refusal used only while canvas control itself is enabled. */
export function unsupportedServerVerbMessage(verb: string): string {
  const why = verb === 'browser' ? ` ${BROWSER_UNSUPPORTED_CLAUSE}` : ''
  return (
    `${CONTROL_UNSUPPORTED_ERROR}: The "${verb}" canvas-control verb is not supported by ` +
    `nodeterm Server Edition v1. This is not a temporary failure — do not retry.${why}`
  )
}

/**
 * Build the real Server Edition handler. Authentication remains entirely in HookServer: this
 * callback receives only requests that passed the app bearer, per-node verdict and the
 * verified-only gate for messaging/sticky. Parsing is shared with desktop; dispatch is deliberately
 * small and exhaustive so every deferred verb receives a named permanent edition refusal.
 */
export function createServerEditionControlHandler(actions: ServerEditionControlActions): (req: {
  verb: string
  nodeId: string
  args: Record<string, string>
  verified: boolean
}) => Promise<ServerControlReply> {
  return async ({ verb, nodeId, args, verified }) => {
    if (!SERVER_V1_VERBS.has(verb)) {
      return {
        ok: false,
        error: CONTROL_UNSUPPORTED_ERROR,
        message: unsupportedServerVerbMessage(verb)
      }
    }
    const command = parseControlRequest(verb, args)
    if ('error' in command) return { ok: false, error: command.error }
    // Creator ownership is meaningful only for an authenticated node identity. Keep this at the
    // Server boundary so every mutating/executing verb — including ones whose factory method has no
    // `verified` parameter — fails before it can inspect or change shared state.
    if (!verified) {
      return {
        ok: false,
        error: `${command.verb}-identity-refused: Server Edition canvas control requires verified node identity`
      }
    }

    switch (command.verb) {
      case 'open-project':
        return actions.openProject(nodeId, command.args, verified)
      case 'open-terminal':
        return actions.openTerminal(nodeId, command.args, verified)
      case 'open-agent':
        return actions.openAgent(nodeId, command.args, verified)
      case 'close':
        return actions.close(nodeId, command.args, verified)
      case 'link':
        return actions.link(nodeId, command.args, verified)
      case 'group':
        return actions.group(nodeId, command.args)
      case 'rename':
        return actions.rename(nodeId, command.args)
      case 'color':
        return actions.color(nodeId, command.args)
      case 'sticky':
        return actions.sticky(nodeId, command.args)
      case 'settings':
        return actions.settings(nodeId, command.args)
      case 'run':
        return actions.run(nodeId, command.args, verified)
      case 'report-outcome':
        return actions.reportOutcome(nodeId, command.args, verified)
      case 'issues':
      case 'prs':
        return actions.githubRead(command.verb, nodeId, command.args)
      case 'send':
      case 'reply':
      case 'notify':
        return actions.deliver({
          verb: command.verb,
          sourceNodeId: nodeId,
          targetNodeId: command.args.node,
          body: command.verb === 'notify' ? '' : command.args.text
        })
      default:
        // `SERVER_V1_VERBS` and this switch are kept separate on purpose: the parser's wider
        // ControlVerb union can grow without silently making a new server action reachable.
        return {
          ok: false,
          error: CONTROL_UNSUPPORTED_ERROR,
          message: unsupportedServerVerbMessage(verb)
        }
    }
  }
}
