# Project secrets

Agents often need a secret to do their work: an API token for `gh`, a cloud CLI, a password
manager's service account, an internal API. Project secrets let you give such a value to the agents
of one project **without writing it to disk**:

- you declare, in the project's `.nodeterm/settings.json`, the **name** of each environment variable
  your agents expect;
- you put the value into nodeterm yourself: **paste** it, or let nodeterm **fetch** it once by running
  a command you declared;
- nodeterm keeps the value in memory only, and every agent node of that project that starts afterwards
  receives it as an environment variable.

nodeterm knows nothing about any secret manager. A fetch runs whatever command you declare, so it
works with any password manager's CLI or any script that prints the value.

## Which way to choose

| | **Paste** | **Fetch with a command** |
|---|---|---|
| Declaration | the name only | the name and a command |
| How the value gets in | you copy it (for example from your password manager's app) and paste it into nodeterm | nodeterm runs the command once, after you confirm, and reads the value from its output |
| Good for | a token you look up by hand, or a secret manager without a CLI | a password manager or secret store with a command-line tool |
| Needs | nothing else | the command-line tool installed and signed in on this computer |

You can mix both in one project. Either way, the value is gone when nodeterm quits; after a restart
you paste or fetch again.

**Do not point a command at a file that holds the secret** (for example a script that prints the
contents of `token.txt`). It works, but then the secret is on disk anyway, which is what this feature
exists to avoid. Keep the secret in a password manager and either paste it or fetch it from there.

## Step 1: declare the secrets

Create or edit `.nodeterm/settings.json` in the project folder (the folder nodeterm opened as the
project). The file is meant to be committed with the repository: it holds names and commands, never
values. Add an `agents.secrets` list:

```json
{
  "agents": {
    "secrets": [
      { "env": "API_TOKEN" },
      { "env": "SERVICE_KEY", "command": ["op", "read", "op://Dev/Service/key"] }
    ]
  }
}
```

- `API_TOKEN` has no `command`: you will **paste** it.
- `SERVICE_KEY` has a `command`: nodeterm will **fetch** it by running that command.
- If the file already exists, add `secrets` inside its existing `agents` object instead of replacing
  the file. Other keys in the file (such as `version`, `rev`, `savedAt`) can stay as they are.
- nodeterm reads the file when you open the Secrets dialog; no restart is needed after an edit.

Rules for each entry:

- `env` is the variable name your agents expect, for example `GH_TOKEN` or
  `OP_SERVICE_ACCOUNT_TOKEN`. Letters, digits and `_`, not starting with a digit. Names that would
  break a session are refused: `PATH`, `HOME`, `SHELL`, `TERM`, `USER`, `PWD`, `NODE_OPTIONS`,
  `LD_PRELOAD`, any `LC_*`, `XDG_*` or `NODETERM_*` name, and the names nodeterm uses to pick an
  agent's account. Each name may appear once.
- `command`, when present, is a **list of arguments**, not a shell line. It runs without a shell, in
  the project folder:
  - `["op", "read", "op://Dev/Service/key"]` is right; `"op read op://Dev/Service/key"` (one string)
    is refused, and so are an empty list and a list whose first element is blank.
  - Pipes, `&&`, `$VAR` and quotes have no special meaning: each element is passed as it is.
  - A program named with a path (`./scripts/print-key`) is found relative to the project folder; a
    bare name (`op`, `node`) is looked up on `PATH`.
  - On Windows, a `.bat` or `.ps1` file cannot be run without a shell: name its interpreter instead,
    for example `["powershell", "-NoProfile", "-File", "scripts/print-key.ps1"]`. Programs installed
    by npm (`.cmd` files) work as bare names.
- **The command line must not contain a secret.** It is stored in the file. A reference such as
  `op://Dev/Service/key` names a vault and an item but holds no secret; if even that must not be in
  the repository, use paste.
- An entry that is malformed (an invalid name, a `command` that is a string) is ignored. If a
  secret you declared does not show up in the dialog, check its entry against these rules.

## Step 2a: paste a value

1. In the tab bar, open the project's menu (⌄ next to its name) and choose **Secrets…**.
2. The row for the secret says *Pasted by you* and has a **Paste value…** button. Click it.
3. nodeterm opens a small separate window with one masked field. Paste the value and choose
   **Keep in memory**. The window closes and the row says *In memory*.

Good to know:

- Line breaks at the start or end of what you paste are removed (copying a token often brings one).
  A value with a line break in the middle, or an empty one, is refused and the window stays open so
  you can paste again.
- **Replace value…** pastes a new value over the held one. **Cancel** keeps nothing.
- That window has no developer tools, no spellcheck and an in-memory browser session, so nothing of
  it is written to disk. It closes as soon as the value is accepted.
- Your clipboard is yours: a copied value stays on it (and in Windows clipboard history, Win+V, when
  that is turned on) until you copy something else. nodeterm does not touch it.

## Step 2b: fetch values with commands

1. Make sure each command works on its own: run it in a terminal in the project folder. It must print
   the value **on one line** on standard output and exit with code 0. Sign in to the tool first if
   it needs it.
2. Open the project's menu (⌄) and choose **Secrets…**. Each fetched secret shows its exact command.
3. Click **Fetch secrets…**. Your operating system shows a confirmation listing every command that
   will run. Read it, then choose **Fetch secrets** (the default button is **Cancel**).
4. The commands run once each, one after another. If a tool asks you something itself (a password
   manager's approval prompt), answer it. Each row then says *In memory* or *Fetch failed* with the
   reason.

Good to know:

- One trailing newline in the output is removed. Anything the command writes to standard error is
  shown in the dialog if it fails, and never logged.
- **Fetch again…** runs every command again and replaces the fetched values. Pasted values are kept.
- Each fetch runs each command exactly once; every agent node started afterwards gets the values from
  memory, so the secret store is not asked again until you fetch again.

Examples of commands that print a value:

| Tool | Command |
|---|---|
| 1Password CLI | `["op", "read", "op://<vault>/<item>/<field>"]` |
| GitHub CLI (the token of your own `gh` login) | `["gh", "auth", "token"]` |
| A script of your own | `["node", "scripts/print-token.js"]` |

## Step 3: give the values to your agents

Agent nodes (Claude, Codex, Gemini, …) of the project receive the values **when they start**.

- Agent nodes opened after the paste or fetch have them.
- **An agent node that was already running keeps the environment it started with.** Restart it from
  its node menu (Restart) to give it the values.
- To check in an agent's shell without showing the value:
  `[ -n "$API_TOKEN" ] && echo present || echo absent` (PowerShell:
  `if ($env:API_TOKEN) { 'present' } else { 'absent' }`).

## Who receives the values

- **Agent nodes** of the declaring project, started after the paste or fetch.
- Not plain terminals, not other projects, not SSH projects (a value would have to be sent to the
  host), not sessions started for a relay peer, a phone or a hosted teammate, and not the browser
  Server Edition.
- **Nodes opened by an agent of another project.** Settings → Agents → *Project secrets for nodes
  opened by another project* decides: *Never give them* (the default), *Like any agent node of the
  project*, or *Ask me in the node*. With *Ask me*, such a node shows a question before its
  terminal starts; the agent that opened it is told to ask you.

Agents receive the values as environment variables, so every program an agent starts inherits
them, as with any `run`-style secret injection. Any process running as your user can read another
process's environment on most systems; nodeterm cannot change that.

## How long the values live

In nodeterm's memory until you quit the app, close or delete the project, move the project to
another folder, or press **Clear** in the dialog. **Fetch again…** replaces the fetched values;
**Replace value…** replaces a pasted one. After a restart nothing is held until you paste or fetch
again.

A changed declaration is not used until you paste or fetch again: you approved the old command (or
the paste), not the new one. The dialog then says *Declaration changed — paste or fetch again*.

## What nodeterm writes, and what it cannot control

nodeterm never writes a value to disk: not to settings, logs, the session host's files, crash
reports, temporary files, browser storage or an encrypted store. Terminal output that nodeterm saves
for scrollback replay after a reboot has every value it currently holds replaced with
`<concealed by nodeterm>`. That replacement cannot catch a value split across a line wrap, or one
printed after an app restart (nodeterm no longer holds it then).

What an agent does with a value is the agent's: if it prints it, the agent's own conversation
history (written by the agent's CLI) may contain it. Your operating system may page memory to disk
or write a crash dump.

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| No **Secrets…** item in the project menu | The project is an SSH project, has no folder, or you are in the browser Server Edition or a relay tab | Use the desktop app with a local folder project |
| *This project declares no secrets* | No valid entry under `agents.secrets` in `.nodeterm/settings.json` | Check the file is in the project folder's `.nodeterm/` and each entry follows the rules in Step 1 |
| A declared secret is missing from the dialog | Its entry is malformed, or its name is reserved or repeated | Fix the entry (Step 1) and reopen the dialog |
| Every secret from the shared file is ignored | Settings → Project → *Ignore shared agents settings* is on for this project | Turn it off |
| No **Paste value…** button for a secret | Its entry has a `command`, so it is fetched | Remove the `command` key to paste it instead |
| No **Fetch secrets…** button | Every secret is pasted | Nothing to fetch; use **Paste value…** |
| *program not found* | The program is not on the `PATH` nodeterm sees (an app started from the desktop may see a shorter one than your terminal) | Use the program's full path in `command` |
| *the command exited with code N* | The command itself failed; its error output is shown under the row | Run the command in a terminal in the project folder and fix it (often: not signed in) |
| *…printed more than one line* or *…printed nothing* | The output is not exactly one line | Make the command print only the value |
| *…cannot be run without a shell* (Windows) | The command names a `.bat` or `.ps1` file | Name the interpreter: `["powershell", "-NoProfile", "-File", "…"]` |
| *…did not finish within 120 s* | The command waited too long (often an unanswered prompt) | Answer the tool's prompt sooner, or sign in first |
| *Declaration changed — paste or fetch again* | The entry changed after the value was taken | Paste or fetch again |
| An agent does not see the variable | It was running before the paste or fetch, or it is a plain terminal | Restart the agent node; plain terminals never get values |

## Availability

Desktop app only (macOS, Windows, Linux). The Server Edition and relay tabs do not offer it, and
SSH projects are refused by name in the dialog. The phone app does not show it.
