# SSH Server Picker Overflow and Filtering Design

## Problem

Issue 141 reports that the Connect over SSH picker becomes unusable when dozens of servers have been imported. The dialog shell is a capped flex column, but the server list is an unconstrained flex child with no scroll behaviour. Rows beyond the viewport remain rendered but unreachable, and the Cancel and Add server actions can be pushed below the visible dialog.

The same saved-server collection is rendered in Settings. That surface is not affected because `SettingsPage` already makes its entire main content column vertically scrollable.

## Approved scope

- Give the Connect over SSH server rows a dedicated vertical scroll region.
- Keep the picker title, explanatory copy, filter, Cancel action, and Add server action visible.
- Add type-to-filter behaviour for large imported server collections.
- Leave Settings unchanged because its page-level scroll region already handles long server lists.

## Layout

The pick step becomes one bounded flex column inside the existing `.confirm` shell. Its title, explanatory copy, filter, and action row do not shrink. The server list receives `flex: 1 1 auto`, `min-height: 0`, and `overflow-y: auto`, with contained overscroll. Each server row has `flex-shrink: 0`, ensuring the constrained list overflows and scrolls instead of compressing its rows.

Only the server list scrolls. The dialog shell and actions retain the existing styling and interaction model.

## Filtering

The filter is transient React state local to `SshProjectDialog`. Matching is case-insensitive after trimming the query. A server remains visible when the query occurs in any of these values.

- Label
- Hostname
- Username
- Combined `user@host`

An empty query shows every saved server. When saved servers exist but none match, the list shows a clear no-results message. The existing no-saved-servers message remains unchanged when the collection itself is empty.

The filter state does not persist and does not modify saved-server data.

## Accessibility and keyboard behaviour

The filter uses the shared `Input` component, receives focus when the pick step opens, and has an explicit accessible label. Existing Escape handling continues to close the topmost dialog. Server rows remain native buttons and retain their current click behaviour.

## Testing

Renderer tests will exercise the real `SshProjectDialog` and Zustand server store.

- A large server collection renders inside a dedicated list whose inline layout contract includes flexible shrinking, zero minimum height, vertical scrolling, and non-shrinking rows. The action row must remain a sibling outside that list.
- Filtering matches labels, hosts, usernames, and `user@host` case-insensitively.
- A non-matching query replaces server rows with the no-results message.
- Clearing the query restores all server rows.
- Existing connection and browse-master teardown tests remain green.

The focused renderer test is followed by `npm run typecheck`, the full `npm test` suite, `npm run build`, and `git diff --check` before publication.

## Surfaces

- Desktop is covered because the picker is renderer UI.
- Server Edition is covered because it uses the same renderer component.
- Mobile is not applicable because the native companion does not render this project-creation dialog.

## Out of scope

- Changes to saved-server persistence or SSH connection behaviour.
- Sorting, grouping, fuzzy scoring, or keyboard arrow navigation.
- A generic quick-pick abstraction.
- A second filter in Settings.
