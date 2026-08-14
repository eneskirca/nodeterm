/**
 * POSIX-sh prelude prepended to every managed hook script.
 *
 * WHY IT EXISTS: with the shared app-server, the shell a Codex TOOL runs in is spawned by that
 * server, not by the TUI client NodeTerm launched. It therefore inherits `CODEX_THREAD_ID` but
 * none of the `NODETERM_*` env we set on the pane — so the hook it runs has no idea which canvas
 * node it belongs to, and the node's badge/status would simply never move. This recovers the node
 * binding from the thread id.
 *
 * The mapping file is parsed as DATA (`sed`), never sourced as shell code, and both recovered
 * fields are re-validated before they are exported. The record itself is HMAC-signed by
 * `codex-identity-proxy.ts`; this prelude cannot verify that signature (no key in an agent's
 * shell), which is why the charset re-validation below is not redundant.
 *
 * Inert for every other agent: without `CODEX_THREAD_ID` the whole block is skipped, and the
 * generated script is otherwise byte-identical to what it was. That is intentional — the prelude
 * is prepended once in `buildManagedScript`, so it lands in claude/gemini/codex/grok/opencode
 * scripts alike rather than in a codex-only fork of the builder.
 *
 * Deliberately free of Node/Electron imports beyond the path it is given: the generated-script
 * cores are shared by the desktop and the Server Edition.
 */
import { posixQuote } from '../shared/ssh'

/**
 * @param identityRoot absolute path of the thread → node record directory
 *   (`codexThreadIdentityRoot()`, i.e. under `CorePlatform.userDataDir` — NOT `~`).
 */
export function codexThreadIdentityResolverSh(identityRoot: string): string {
  return `# A shared-app-server Codex tool shell inherits CODEX_THREAD_ID, not the TUI client's
# NODETERM_* env. Recover this thread's exact node binding, or change nothing at all.
if [ -z "\${NODETERM_NODE_ID-}" ] && [ -n "\${CODEX_THREAD_ID-}" ]; then
  case "$CODEX_THREAD_ID" in
    # '.' and '..' MATCH the charset and are path segments: "$identityRoot"/.. is the record dir's
    # PARENT. Refused by name here for the same reason isSafeThreadId refuses them in TypeScript.
    ''|.|..|*[!A-Za-z0-9._-]*) ;;
    *)
      nt_codex_map=${posixQuote(identityRoot)}/"$CODEX_THREAD_ID"
      if [ -r "$nt_codex_map" ]; then
        nt_codex_node=$(sed -n 's/^nodeId=//p' "$nt_codex_map" | head -n 1)
        nt_codex_endpoint=$(sed -n 's/^endpoint=//p' "$nt_codex_map" | head -n 1)
        case "$nt_codex_node" in ''|*[!A-Za-z0-9._-]*) nt_codex_node='' ;; esac
        case "$nt_codex_endpoint" in /*) ;; *) nt_codex_endpoint='' ;; esac
        if [ -n "$nt_codex_endpoint" ] &&
           [ "$(printf %s "$nt_codex_endpoint" | tr -cd 'A-Za-z0-9._/ -')" != "$nt_codex_endpoint" ]
        then
          nt_codex_endpoint=''
        fi
        if [ -n "$nt_codex_node" ] && [ -n "$nt_codex_endpoint" ]; then
          NODETERM_NODE_ID="$nt_codex_node"
          NODETERM_HOOK_ENDPOINT="$nt_codex_endpoint"
          NODETERM_AGENT_ID=codex
          NODETERM_CANVAS_CONTROL=1
          export NODETERM_NODE_ID NODETERM_HOOK_ENDPOINT NODETERM_AGENT_ID NODETERM_CANVAS_CONTROL
        fi
      fi
      ;;
  esac
fi`
}
