/**
 * POSIX-sh prelude prepended to every managed hook script.
 *
 * WHY IT EXISTS: with the shared app-server, the shell a Codex TOOL runs in is spawned by that
 * server, not by the TUI client NodeTerm launched. It therefore inherits `CODEX_THREAD_ID` but
 * none of the `NODETERM_*` env we set on the pane — so the hook it runs has no idea which canvas
 * node it belongs to, and the node's badge/status would simply never move. This recovers the node
 * binding from the thread id.
 *
 * The mapping file is parsed as DATA (a `read` loop — no process per field), never sourced as shell code, and both recovered
 * fields are re-validated before they are exported. The record itself is HMAC-signed by
 * `codex-identity-proxy.ts`; this prelude cannot verify that signature (no key in an agent's
 * shell), which is why the charset re-validation below is not redundant.
 *
 * ACCOUNT SCOPING (S6): a SYSTEM record lives at the bare root (`<root>/<threadId>`) and a MANAGED
 * record under `<root>/<accountId>/<threadId>`. This prelude reads `NODETERM_CODEX_ACCOUNT_ID` from
 * the daemon's env to pick the scope:
 *   - a known, safe account id ⇒ read ONLY that account's record, and require the record's
 *     `accountId=` line to agree with the daemon scope;
 *   - an EMPTY account id (the classic shared tool shell that knows only a bare thread id) ⇒ scan
 *     EVERY scope (bare-root system + each managed subdir) and bind ONLY when exactly one candidate
 *     matches (`nt_codex_matches -eq 1`). Two accounts holding the same thread id ⇒ ambiguous ⇒
 *     change nothing (Property 3 / Constraint 8, the same fail-closed posture as the TypeScript
 *     `resolveCodexThreadNodeIdentity`).
 *
 * WHAT IT EXPORTS IS WHAT THE RECORD SAYS — it does not decide. `NODETERM_AGENT_ID` and
 * `NODETERM_CANVAS_CONTROL` used to be constants here (`codex`, granted), and both are facts only
 * `hookServer.buildPtyEnv` knows: it labels the node with its OWN agent id, which for a custom
 * agent inheriting the codex harness is `custom:<uuid>`, and it gates the grant on
 * `canControlCanvas`. Asserting them here mislabelled every such node, and asserted a grant that
 * agrees with the pane today only because `SHARED_IDENTITY_CAPABLE ⊆ CANVAS_CONTROL_CAPABLE` — a
 * coincidence that list's own comment invites the next shared-identity agent to break. So the pair
 * is recorded at bind time and read back here. A PRE-AGENT record (written before those fields
 * existed) carries neither and means `codex` with the grant, which is precisely what it meant when
 * it was written; a record that names an agent is exported as it stands, grant included, and never
 * falls back to the guess.
 *
 * Inert for every other agent: without `CODEX_THREAD_ID` the whole block is skipped. A machine with
 * no managed accounts has no subdirs, so the scan reduces to the one bare-root read S4 did — the
 * legacy layout keeps resolving byte-for-byte (Constraint 12).
 *
 * Deliberately free of Node/Electron imports beyond the path it is given: the generated-script
 * cores are shared by the desktop and the Server Edition.
 */
import { posixQuote } from '../shared/ssh'

/**
 * PROBE U5 (Codex 0.146.0, 2026-08-19 — docs/superpowers/probes/2026-08-codex-tool-shell-env.md):
 * a shared `app-server`-spawned tool shell carries `CODEX_THREAD_ID` (measured — a fresh id per
 * thread) and NOT the per-pane `NODETERM_*` (the tool shell forks from the shared daemon, not the
 * connecting client; corroborated by the deployed S4 resolver that depends on exactly this). The
 * premise HOLDS, so the account-scoped scan below is warranted. Caveat: an in-process app-server
 * (`codex exec`) leaks `NODETERM_*`, but the outer `[ -z "$NODETERM_NODE_ID" ]` guard no-ops there.
 *
 * @param identityRoot absolute path of the thread → node record directory
 *   (`codexThreadIdentityRoot()`, i.e. under `CorePlatform.userDataDir` — NOT `~`).
 */
export function codexThreadIdentityResolverSh(identityRoot: string): string {
  return `# A shared-app-server Codex tool shell inherits CODEX_THREAD_ID, not the TUI client's
# NODETERM_* env. Recover this thread's exact node binding (account-scoped), or change nothing.
if [ -z "\${NODETERM_NODE_ID-}" ] && [ -n "\${CODEX_THREAD_ID-}" ]; then
  case "$CODEX_THREAD_ID" in
    # '.' and '..' MATCH the charset and are path segments: "$identityRoot"/.. is the record dir's
    # PARENT. Refused by name here for the same reason isSafeThreadId refuses them in TypeScript.
    ''|.|..|*[!A-Za-z0-9._-]*) ;;
    *)
      nt_codex_root=${posixQuote(identityRoot)}
      nt_codex_matches=0
      nt_codex_node=''
      nt_codex_endpoint=''
      nt_codex_agent=''
      nt_codex_grant=''
      # Validate one candidate record file for an expected scope, parsed as DATA. On success it
      # records the node/endpoint/agent/grant and counts the match. $1=file, $2=expected scope
      # ('' = system).
      nt_codex_try() {
        [ -r "$1" ] || return 0
        # ONE PASS, by the shell itself. This used to be five \`sed | head\` command substitutions —
        # fifteen processes per record, on every hook event of every tool shell — and it is the
        # same read: the FIRST line that starts with each key wins (what \`head -n 1\` took, and what
        # \`codex-identity-proxy.ts\` matches on the TypeScript side), the value is everything after
        # the first \`=\`, and a record whose last line has no newline still counts (\`read\` answers
        # non-zero there but has already assigned the line, hence the \`|| [ -n … ]\`). \`IFS=\` and
        # \`-r\` keep the value byte-for-byte: no trimming, no backslash processing. Still DATA, never
        # sourced. The \`nt_s*\` flags are what make "first" mean first even for an empty value.
        nt_a='' nt_n='' nt_e='' nt_g='' nt_c=''
        nt_sa='' nt_sn='' nt_se='' nt_sg='' nt_sc=''
        while IFS= read -r nt_l || [ -n "$nt_l" ]; do
          # A CRLF record. Git for Windows' \`sed\` reads in text mode and dropped the CR, so the old
          # pipeline resolved such a record on Windows; \`read\` keeps it and every charset check
          # below would then refuse the value. Drop ONE trailing CR to keep that working. (On
          # Linux/macOS the old \`sed\` kept the CR and the record was refused, so this is the one
          # place the rewrite is more lenient — harmlessly: the values are validated AFTER the
          # strip, exactly as before.) The \`printf\` costs a process only for a line that really
          # ends in a control character, which no record we write does.
          case "$nt_l" in
            *[[:cntrl:]]) nt_cr=$(printf '\\r'); nt_l=\${nt_l%"$nt_cr"} ;;
          esac
          case "$nt_l" in
            accountId=*) [ -n "$nt_sa" ] || { nt_a=\${nt_l#accountId=}; nt_sa=1; } ;;
            nodeId=*) [ -n "$nt_sn" ] || { nt_n=\${nt_l#nodeId=}; nt_sn=1; } ;;
            endpoint=*) [ -n "$nt_se" ] || { nt_e=\${nt_l#endpoint=}; nt_se=1; } ;;
            agentId=*) [ -n "$nt_sg" ] || { nt_g=\${nt_l#agentId=}; nt_sg=1; } ;;
            canvasControl=*) [ -n "$nt_sc" ] || { nt_c=\${nt_l#canvasControl=}; nt_sc=1; } ;;
          esac
        done < "$1" 2>/dev/null
        # The record's own account line must AGREE with the directory it was found in. A system
        # record's line is empty or the reserved word 'system'; a managed record's line is its id.
        case "$2" in
          '') case "$nt_a" in ''|system) ;; *) return 0 ;; esac ;;
          *) [ "$nt_a" = "$2" ] || return 0 ;;
        esac
        case "$nt_n" in ''|*[!A-Za-z0-9._-]*) return 0 ;; esac
        case "$nt_e" in /*) ;; *) return 0 ;; esac
        # SPACES ARE ADMITTED DELIBERATELY, and this line is the reason to say so. The endpoint is
        # this app's own data-dir path, which on macOS is "~/Library/Application Support/…" — a
        # filter without the space would reject every macOS record and silently disable the whole
        # recovery there. What the value is used FOR is what makes that safe: both shims DOT-SOURCE
        # it with the dot command (canvas-control-core.ts / context-link-core.ts) and the
        # socket it names then reaches curl --unix-socket "$NODETERM_HOOK_SOCK" — every expansion
        # inside double quotes, so a space cannot split into extra arguments. The charset is what
        # keeps quoting and command substitution out; the leading slash above keeps it absolute.
        # The same alphabet as a negated \`case\` class — the idiom the node id and the agent id use
        # two lines away — instead of a \`tr -cd\` round-trip compared with the original: identical
        # verdict, no command substitution and no pipeline. The space is the one character that
        # needs quoting inside the class.
        case "$nt_e" in *[!A-Za-z0-9._/\\ -]*) return 0 ;; esac
        # A PRE-AGENT record (no agentId line, or an empty one) means codex with canvas control:
        # every record written before the agent fields existed was written by this same Codex
        # spine, and codex is unconditionally canvas-control-capable, so the implied pair
        # reproduces what this prelude hardcoded. A record that DOES name an agent is exported as
        # it stands and never falls back to the guess — including its grant, which is then the
        # canControlCanvas answer the pane itself got, not an assumption made here.
        case "$nt_g" in
          '')
            nt_g=codex
            nt_c=1
            ;;
          *[!A-Za-z0-9._:-]*) return 0 ;;
        esac
        nt_codex_node=$nt_n
        nt_codex_endpoint=$nt_e
        nt_codex_agent=$nt_g
        nt_codex_grant=$nt_c
        nt_codex_matches=$((nt_codex_matches + 1))
      }
      case "\${NODETERM_CODEX_ACCOUNT_ID-}" in
        '')
          # Unknown account: scan every scope, bind only if exactly one candidate matches.
          nt_codex_try "$nt_codex_root/$CODEX_THREAD_ID" ''
          for nt_codex_dir in "$nt_codex_root"/*/; do
            [ -d "$nt_codex_dir" ] || continue
            nt_codex_scope=\${nt_codex_dir%/}
            nt_codex_scope=\${nt_codex_scope##*/}
            case "$nt_codex_scope" in
              ''|.|..|system|*[!A-Za-z0-9._-]*) continue ;;
            esac
            nt_codex_try "$nt_codex_dir$CODEX_THREAD_ID" "$nt_codex_scope"
          done
          ;;
        # A daemon scope that could escape the mapping directory, or the reserved system word used
        # as a managed id: resolve nothing.
        .|..|system|*[!A-Za-z0-9._-]*) ;;
        *)
          nt_codex_try "$nt_codex_root/\${NODETERM_CODEX_ACCOUNT_ID}/$CODEX_THREAD_ID" \\
            "$NODETERM_CODEX_ACCOUNT_ID"
          ;;
      esac
      if [ "$nt_codex_matches" -eq 1 ] && [ -n "$nt_codex_node" ] && [ -n "$nt_codex_endpoint" ]
      then
        NODETERM_NODE_ID="$nt_codex_node"
        NODETERM_HOOK_ENDPOINT="$nt_codex_endpoint"
        NODETERM_AGENT_ID="$nt_codex_agent"
        export NODETERM_NODE_ID NODETERM_HOOK_ENDPOINT NODETERM_AGENT_ID
        # The grant is EXPORTED ONLY WHEN THE RECORD CARRIES IT, and is left UNSET otherwise —
        # absent, never '0', the same shape buildPtyEnv produces, because both shims gate on
        # \`[ -z "$NODETERM_CANVAS_CONTROL" ]\`. Withholding is the honest degrade: the tool shell
        # loses a verb its pane still has, whereas asserting a grant the pane was denied is the
        # widening this file must never do.
        if [ "$nt_codex_grant" = 1 ]; then
          NODETERM_CANVAS_CONTROL=1
          export NODETERM_CANVAS_CONTROL
        fi
      fi
      ;;
  esac
fi`
}
