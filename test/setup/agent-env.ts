// TEST-ONLY — issue #744. A developer running the suite from INSIDE a nodeterm agent session (the
// normal way this repo is worked on) inherits that session's agent-config relocation variables —
// a managed Claude account's `CLAUDE_CONFIG_DIR` above all. Code under test resolves the agent's
// LIVE config dir from them (`claudeSystemConfigDir`, `systemCodexHome`, …), so a test that boots
// the real integration lifecycle with a scratch `HOME` still wrote into the developer's own
// account dir (measured: a server boot test overwrote the session's `get-linked-context` skill).
// CI never sets these; stripping them here makes every machine behave like CI. A test that needs
// one sets it itself.
for (const k of [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GROK_HOME',
  'COPILOT_HOME',
  'GEMINI_CLI_HOME',
  'XDG_CONFIG_HOME',
  'NODETERM_NODE_ID',
  'NODETERM_HOOK_ENDPOINT',
  'NODETERM_CANVAS_CONTROL'
]) {
  delete process.env[k]
}
