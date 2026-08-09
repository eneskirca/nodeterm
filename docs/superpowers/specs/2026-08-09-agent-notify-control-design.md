# Agent Notify Canvas Control

## Goal

Let a canvas-control-capable agent wake a context-linked agent after updating an external coordination channel, without approving arbitrary terminal input.

## Command

`nodeterm notify --node <id>` sends a fixed Nodeterm-authored prompt to the target. The command accepts no message text.

## Trust boundary

- Disabled by default and enabled in Settings > Notifications.
- Source must pass the existing canvas-control authorization check.
- Target must be a context-link-capable agent in the active project.
- Source and target must have a persisted context link.
- Each source-target pair is limited to one notification every 10 seconds.
- `write` and `close` retain their confirmation dialogs.

## Prompt

The target receives: `[nodeterm] A linked agent updated shared coordination context. Check your configured inbox before continuing.`

The app owns the entire prompt so the source cannot inject instructions through command arguments.
