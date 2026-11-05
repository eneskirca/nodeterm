# Durable agent mail

Agent messages have two independent lifecycles:

| Transport | Recipient processing |
| --- | --- |
| Pending, queued, delivered, uncertain or failed | Unacknowledged, accepted, blocked, completed or rejected |

Queued does not mean delivered. Delivery, an idle hook, opening a message and sending a reply
never acknowledge or complete work. Completion is the recipient's declaration, not an independent
review of the result. Each authenticated recipient handles its own acknowledgements.

## Agent CLI

The installed **manage-nodeterm-canvas** skill contains the correct CLI path for its host and
profile. Use that path; do not copy a desktop path to an SSH host. The examples below abbreviate it
as `nodeterm.sh`.

```sh
sh nodeterm.sh inbox --state open --limit 50 --json
sh nodeterm.sh outbox --state open --limit 50 --json
sh nodeterm.sh read --message MESSAGE_ID --json
```

Inbox, Outbox and `read` are read-only. After incorporating a message into the work plan, explicitly
accept its current revision:

```sh
sh nodeterm.sh ack --message MESSAGE_ID --state accepted --revision REVISION \
  --note "Included in work plan" --request-id UNIQUE_ACK_KEY --json
```

Use `--state blocked` with the concrete missing prerequisite when work cannot proceed. Blocked
messages remain open. After doing the work and checks, complete the latest revision with the claim
returned by `ack`:

```sh
sh nodeterm.sh complete --message MESSAGE_ID --outcome done --revision REVISION \
  --claim CLAIM_ID --note "Result and checks" --request-id UNIQUE_COMPLETE_KEY --json
```

An explicit rejection uses `--outcome rejected`. On a revision or claim conflict, read again and
reconcile. Each new mutation needs a unique request ID. Retry an uncertain operation only with the
same key and identical arguments. Existing `send` and `reply` calls remain supported; include
`--request-id` for safe retries. A reply creates mail and does not process its parent.

Check the Inbox at the start of a turn, at natural milestones during longer work and before
reporting completion. Do useful independent work before yielding on a blocker; do not poll for a
queued reply. Unsupported transports or unavailable authentication are explicit limitations,
not evidence that an Inbox is empty or processed.

## Desktop views and historical messages

The node's mailbox panel displays Inbox, Outbox and message bodies. Viewing it does not act as the
agent and cannot acknowledge work. The separate historical hold view is read-only: older queue
records have unverified delivery history and are not automatically assigned, rebound or resent.

An existing local Linux SessionHost session can be authorized only through the local MainWindow's
explicit human confirmation of the current project, provider, host generation and process births.
Unsupported evidence is refused. Restarting or attaching a pane does not establish ownership.

## Explicit observed SSH resumes

The existing native transport is the Windows default; POSIX can explicitly opt into it with
`NODETERM_NATIVE_SSH=1` when the application is launched. Mail does not change this selection or
reconnect existing projects.

SSH mail requires a captured, genuinely new authenticated native SSH connection and a new observed
Codex frontend. Existing plain/OpenSSH sessions are not retroactively attested. There is no agent,
CLI or relay command to grant this ownership.

For an already ended terminal with a known conversation, the desktop offers **observed resume**.
This inspects an existing account daemon and actual executables without starting or installing a
daemon. A native dialog shows the actual endpoint, connection generation, conversation, account,
folder and executable hashes. Approval requests one fresh frontend; it neither proves a successful
resume nor authorizes mail. A living previous frontend, unknown process state or changed identity
refuses the operation. No terminal is killed or replaced.

After the provider has actually resumed the requested conversation, attach the terminal view and
use the separate human authorization action. The application compares fresh provider and Linux
tmux/process/socket evidence before and after confirmation. Its private record selects the expected
identity; every subsequent mail operation revalidates that identity over the captured transport.
Loss or replacement never triggers a new connection or direct fallback for mail.

This first observed SSH path supports an existing native Linux Codex executable and an already
running account daemon. Wrappers whose child owns the connection, unsupported providers and resume
responses larger than the observer's 1 MiB JSON limit fail closed. Synthetic protocol/kernel tests
are not a claim of compatibility with every installed Codex version or conversation history.
Remote-source delivery to a local native/SessionHost target is refused where its operation guard
cannot be transferred to that backend. Historical held mail remains unverified throughout this flow.
