# Automatic Claude account failover

When the primary Claude account reaches its 5-hour session limit, nodeterm can move the Claude
sessions running on it to a secondary account, and move them back once the primary is free again.
The conversation continues on the other account without a `/login` in the pane.

## Setting it up

Settings → Accounts → **Automatic Claude failover**:

- **Switch**: turns the feature on. Off by default.
- **Primary**: the account your sessions normally run on.
- **Secondary**: the account used only while the primary is in its 5-hour limit.

Either side may be the system account (`~/.claude`) or any settled managed or linked account on
this machine. Accounts pinned to an SSH host and accounts still waiting for their login are not
offered. If both sides name the same account, or one side is unset, the block says so and the
feature stays inactive.

The setting lives in this machine's `settings.json` (`claudeFailover`), never in the git-shared
`.nodeterm/project.json`:

```json
"claudeFailover": { "enabled": true, "primary": "@system", "secondary": "<account id>" }
```

`@system` names the system account. The file is hand-editable, so the value is re-validated on
every read (`resolveFailover`): anything malformed reads as "off".

## What happens

Once a minute the canvas reads the primary account's usage. The usage service answers most of
these reads from its own 5-minute cache, so this costs at most about 12 requests an hour for the
primary. The secondary is read only when a move is actually due.

| Primary | Secondary | Result |
|---|---|---|
| 5-hour limit reached, weekly not | free | idle Claude sessions on the primary move to the secondary |
| 5-hour limit reached | 5-hour or weekly limit reached | nothing moves |
| weekly limit reached | any | nothing moves |
| free again | any | sessions the failover moved go back to the primary |
| usage could not be read | any | nothing moves |

Rules behind the table:

- **Only a fresh, successful usage read decides.** A failed read, a missing session window or the
  last good numbers held over a failed read (status `error`) never move anything.
- **A model-scoped weekly cap** (one model's own limit) does not count as a weekly limit, because
  the account still works for other models.
- **Busy sessions are never interrupted.** A session that is working, or waiting on a permission
  prompt, is skipped and tried again on a later tick. A session that hit the limit is normally
  idle, so it moves on the next tick.
- **Only the sessions the failover moved go back.** Each moved node is marked
  (`data.claudeFailover`, persisted in the project, so the way back survives an app restart). A
  manual account switch from the node's right-click menu clears the mark, so a session you placed
  yourself stays where you put it.
- **Past the session reset**, the cached snapshot still says "limited". Once the reset time has
  passed, the tick forces one fresh read, at most every 2 minutes.

Each move uses the same steps as the manual "Switch Claude account" action: the CLI exits, the
transcript is copied into the target account's config dir, the node is rebound, and the terminal is
recycled so `claude --resume` continues the same conversation under the new account. A notice
says what happened, for example: "Work reached its 5-hour limit. Moved 2 sessions to Personal."

## Scope and limits

- **Desktop and Server Edition.** The logic runs in the renderer and uses only `usage.fetch` and
  `claudeAccounts.copySession`, which both shells serve. On the Server Edition it runs only while a
  browser tab is open, and only a **visible** tab acts, so two open tabs do not both switch the same
  session.
- **Active project only.** Sessions in projects that are not on screen are moved once that project
  is opened.
- **Local sessions only.** SSH projects and nodes running on an SSH host are not covered (their
  accounts live on the host). Relay tabs never act.
- **Detection delay.** Between the cache and the 1-minute tick, a reached limit can take up to
  about 6 minutes to be noticed.
- **New sessions** still open on the account you pick (or the project default), not on the
  secondary.
- **Mobile:** not applicable.

## Code

- `src/renderer/canvas/claude-failover.ts`: the pure rules (`resolveFailover`,
  `failoverLimitState`, `planFailover`), tested in `claude-failover.test.ts`.
- `src/renderer/canvas/Canvas.tsx`: the 1-minute watcher, which calls `runClaudeAccountSwitch`
  with the new `failover` flag.
- `src/renderer/terminal/agent-restart.ts`: `RecyclePatch` carries `claudeFailover` beside
  `accountId`, so the mark lands in the same node update as the rebind.
- `src/renderer/components/settings/sections/AccountsSection.tsx`: the settings block.
