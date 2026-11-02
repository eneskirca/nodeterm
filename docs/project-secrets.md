# Project secrets

A project can declare the secrets its agents need: environment variables such as an API token. You
either paste a value into the desktop app yourself, or authorize a fetch and nodeterm runs the
command a secret declares **once**. Either way nodeterm keeps the values in memory only and gives
them to the agent nodes it opens for that project. nodeterm knows nothing about any secret manager:
a declaration names a command, and the command can be a password manager's CLI, a script, or
anything else that prints the value.

## Declaring secrets

In the project's `.nodeterm/settings.json` (shared with the repository), or in this computer's
local project settings:

```json
{
  "agents": {
    "secrets": [
      { "env": "API_TOKEN" },
      { "env": "SERVICE_KEY", "command": ["some-cli", "read", "service/key"] }
    ]
  }
}
```

- `env` is the variable name your agents expect. Names that would break a session are refused:
  `PATH`, `HOME`, `SHELL`, `TERM`, `USER`, `PWD`, `NODE_OPTIONS`, `LD_PRELOAD`, any `LC_*`, `XDG_*`
  or `NODETERM_*` name, and the names nodeterm uses to pick an agent's account.
- Leave out `command` and you paste the value yourself (see *Pasting a value*). A `command` that is
  present but malformed (a string, an empty list) drops the entry rather than turning it into a
  pasted one.
- `command` is a list of arguments, not a shell line. It runs **without a shell**, in the project
  folder. A program named with a path (`./scripts/…`) is found relative to the project folder; a
  bare name is looked up on `PATH`. On Windows a `.bat` or `.ps1` file cannot be run without a
  shell: name its interpreter instead (`["powershell", "-NoProfile", "-File", "print-key.ps1"]`).
- The command must print the value on standard output, as one line. One trailing newline is
  removed. Anything it writes to standard error is shown to you if it fails, and never logged.
- **The command line itself must not contain a secret**: it is stored in the settings file.

A declaration is only a reference. The value is never written to that file or anywhere else.

## Pasting a value

For a secret declared without a command, the **Secrets…** dialog shows *Pasted by you* and a
**Paste value…** button. It opens a small window of nodeterm's own, separate from the canvas window,
with one masked field: paste the value and choose **Keep in memory**. Line breaks at either end are
removed; a value with a line break inside, or an empty one, is refused and the window stays open.
**Replace value…** pastes a new one over it.

That window has no developer tools, no spellcheck and an in-memory browser session, so nothing of it
is written to disk, and it closes as soon as the value is accepted. Your clipboard is yours: a copied
value stays there (and in Windows clipboard history, Win+V, when that is on) until you copy
something else.

## Fetching

Open the project tab's menu (⌄) and choose **Secrets…**. The dialog lists each variable, the exact
command, where it was declared and its state. **Fetch secrets…** then asks the operating system's
own confirmation, which lists the same commands; only **Fetch secrets** there runs them, one after
another. If a command asks you something itself (a password manager's approval prompt), that
happens in addition to nodeterm's confirmation.

Pasted secrets are not part of a fetch: **Fetch secrets…** runs only the commands, and keeps every
pasted value.

Each authorization runs each command once. Every agent node of the project that starts afterwards
receives the values from memory, so the secret store is not asked again until you fetch again.

## Who receives the values

- **Agent nodes** (Claude, Codex, Gemini, …) of the declaring project, started after the fetch or
  paste.
- Not plain terminals, not other projects, not SSH projects (a value would have to be sent to the
  host), not sessions started for a relay peer, a phone or a hosted teammate, and not the browser
  Server Edition.
- An agent that is already running keeps the environment it was started with. Restart it
  (node menu → Restart) to give it the values.
- **Nodes opened by an agent of another project.** Settings → Agents → *Project secrets for nodes
  opened by another project* decides: *Never give them* (the default), *Like any agent node of the
  project*, or *Ask me in the node*. With *Ask me*, such a node shows a question before its
  terminal starts; the agent that opened it is told to ask you.

Agents receive the values as environment variables, so every program an agent starts inherits
them, as with any `run`-style secret injection. Any process running as your user can read another
process's environment on most systems; nodeterm cannot change that.

## How long the values live

In nodeterm's memory until you quit the app, close or delete the project, move the project to
another folder, press **Clear** in the dialog, or fetch again (which replaces the fetched ones). After
a restart nothing is held until you paste or fetch again. A changed declaration is not used until you
fetch or paste again: you approved the old command (or input), not the new one.

## What nodeterm writes, and what it cannot control

nodeterm never writes a value to disk: not to settings, logs, the session host's files, crash
reports, temporary files, the browser storage or an encrypted store. Terminal output that nodeterm
saves for scrollback replay after a reboot has every value it currently holds replaced with
`<concealed by nodeterm>`. That replacement cannot catch a value split across a line wrap, or one
printed after an app restart (nodeterm no longer holds it then).

What an agent does with a value is the agent's: if it prints it, the agent's own conversation
history (written by the agent's CLI) may contain it. Your operating system may page memory to disk
or write a crash dump.

## Availability

Desktop app only. The Server Edition and relay tabs do not offer it, and SSH projects are refused
by name in the dialog. The phone app does not show it.
