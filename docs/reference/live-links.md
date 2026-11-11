# Live links (Pro browser link to one terminal: watch, chat, or type) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## Live links (Pro browser link to one terminal: watch, chat, or type)

A live link shows ONE node in a plain browser — read-only, or typeable on a Control link by a viewer
who also has its password — until it expires (≤ 24 h, or never for Unlimited) or is stopped; creating
one is Pro and the backend is the gate. Reference: **`docs/live-links.md`**. Invariants:
- `watchLink:*` (owner IPC) is host-only: no relay peer, hosted editors included, may create, list (a
  view carries the secret URL), stop, kick, chat, or change a link's control (typing, password, lock).
  The viewer protocol is `watch:*` and must never start with `watchLink:` — relay-host refuses
  host-only channels before any policy, so it could never arrive (`src/shared/host-control.test.ts`,
  `src/core/relay/scoped-guest-policy.test.ts`).
- A watcher never goes through `decideAccess` (it would get the VIEW table): `watcher-policy.ts` refuses
  every request and every cast but `watch:history` (every link), `watch:chat` (Commenter and Control
  links) and, on a Control link only, the three controller casts `watch:unlock` / `watch:input` /
  `watch:release`; it passes out only
  `watch:*`, its own pty frames and `pty:size`, and takes no `interceptReq` (`watcher-policy.test.ts`,
  `chat-cast.guard.test.ts`). The policy knows only the ROLE: "controlling" is the link host's state
  per CONNECTION (a right password; a reconnect unlocks again, a session restart keeps it). Input from
  a viewer that is not controlling is a breach, except within 5 s of losing control (dropped silently);
  every loss of control goes through `loseControl`, and every chunk is re-checked (control period,
  the record read live, the same session) before it goes.
- A controller's input reaches the node's PANE, never a tmux CLIENT: keys as `send-keys -H` lines read
  by `tmux source-file -` from stdin, after a mode cancel, on the exact `=nt-<id>:`; pastes as
  `load-buffer -` + `paste-buffer -d -p -r`, so tmux frames them by the pane's real state. A byte
  written into a client is its keyboard, and the prefix is the security boundary (`C-b s` = every
  session on the socket, `C-b :` = tmux's command prompt). Keys never ride a paste buffer (tmux 3.7
  vis-encodes control bytes there), and no payload ever rides argv, local or SSH. The viewer frames
  every paste itself and sends each emulator answer as its own cast, which the host drops whole
  (`isTerminalReport`); the contract is in `protocol.ts`. Zellij is refused (`watcherInputRoute` →
  `none`, `nodeControlSupport` → `unsupported`). Routing: `pty-manager.control-input.test.ts`; meaning
  on a real tmux: `pane-input.realtmux.test.ts`.
- The Control password is a scrypt hash only (no plaintext kept or logged anywhere; every scrypt run in
  one FIFO gate of 2; `timingSafeEqual`). Host throttles: 1 attempt per 2 s per viewer, 3 wrong end the
  connection, 10 wrong across the link lock it (lock AND count persisted in the record, so a restart
  resets neither; it and a new password reset the count). The lock LIFTS BY ITSELF (L2: any link
  holder could otherwise lock control for everyone for good): 15 min for the first since the owner last
  allowed control, doubling per lock, capped at 24 h; `lockedUntil` and `lockStep` are persisted (a
  restart neither lifts it early nor makes it permanent; a lapsed one is lifted at launch BEFORE the host
  is built; a lock written without `lockedUntil` still waits for the owner). Allow control again lifts
  it at once and resets the count AND the backoff. Viewers are told `lockedForMs`; the owner's notice
  names who tipped it (a claim). The unlock is SEALED to a per-connection X25519 key pair offered in that
  connection's meta (`unlockKey`, `shared/watch-link/unlock-seal.ts`, L3), because every link holder can
  derive the tunnel's keys; the client seals by itself and never sends the password in the clear on a
  connection that offered a key; a plain unlock (an older page) is still accepted, except on a
  connection that already sealed one. Typed input is NOT sealed (residual, docs).
  Owner changes go by direction: narrowing (typing off, a new password) applies at once and is NEVER
  undone by a failed or hung write — the brake must not fail open; the owner is told `'unsaved'` (holds
  until a restart unless a later write lands; Stop ends it for good) — widening (typing on, allow again)
  only after the write. A chunk handed to `PtyManager.controlInput` carries `isCurrent`, asked right
  before it spawns, so it never lands after control ended; a batch holds at most 64 chunks.
- Unlimited = `ttlSeconds: 0` → `expiresAt: null`: no expiry timer, never pruned for time. The backend
  grants it only with no TTL cap and asks the license's liveness at host-token at most once per 24 h per
  license (dead → 402 → the host stops minting, the view reads `refused`; keygen unreachable fails
  open).
  A build older than this one drops Control and unlimited records on load and its next write removes
  them (their server rows live on with no host until they expire or Stop all).
- Watchers are QUIET (no broadcast, not in `clientIds()`) and SELF-PACED (never paused, dropped or
  resynced by the registry); the reaper reads `quietClientIds()` too, or it releases a session only a
  viewer holds (`ui-sink-registry.watcher.test.ts`, `pty-reap.test.ts`).
- Read-back (`watch:history`, `core/watch-link/history.ts`) is the agent's CONVERSATION, never the
  terminal's history: a viewer's stream is a tmux client on the alternate screen and has nothing to
  scroll, and copy-mode would scroll the owner's pane. The host cuts every page at `record.createdAt`
  (a message with no time is never sent) and `readHistoryPage` cuts again on both ends; tool results and
  thinking never travel. The read is host-chat's `page`, bound to the link's node (a viewer sends only a
  cursor), one at a time per viewer, ≥ 500 ms apart.
- The stream filter sees every byte, has NO length cap (a cap leaked a measured clipboard), and every
  join resets it `midStream`, never to text mode and never on a keyframe. `captureVisible` never returns
  history (exact `=nt-<id>:`, no `-S`; the session host answers its negotiated `captureVisible`, the
  only route that sets `altScreen` itself; plain shell and a Zellij node get no keyframe). A
  viewer sizes nothing: `joinOnly` + `sizeVote: false`; its own tmux client is `-E -f ignore-size,read-only`,
  and a Zellij node never gets one (refused, never a Zellij attach — that client could type).
- Node gone is tri-state (only ABSENT ends a link; a lost or corrupt index is never a complete read —
  `knownNodeIdsStrict()`, which only live links call; the agent-status mirror keeps `knownNodeIds()`,
  which ignores that flag, because a whole-process pause of its pruning was R54's mistake).
  Link state is never canvas content, no canvas-control verb touches links, the chip is not hideable
  (`src/renderer/lib/live-link.guard.test.ts`); both shells wire one core service, the Server Edition as
  `unsupported` until it has a license layer (`src/main/watch-link-wiring.test.ts`).
- `src/shared/watch-link/` is vendored byte for byte into nodeterm-web: siblings and `tweetnacl` only,
  no Node API, type imports spelled `import type` (`isomorphism.guard.test.ts`); a change there owes the
  web repo a re-vendor. Chat text is stripped of controls AND bidi controls there, capped by code point;
  a NAME also loses every format character (`\p{Cf}`) and the blank letters, so look-alike names are
  equal (L4); chat TEXT keeps only ZWJ and ZWNJ of the format characters (emoji, Persian/Indic).
- The viewer page strips the secret fragment from the address bar after reading it (L1): kept in the
  tab's `sessionStorage` (`nodeterm.watchLink.<linkId>`) for a reload, a Copy link button rebuilds it;
  where storage cannot be written the fragment stays. A full link's status poll is 60 s (L6).
- Never silent about what a viewer gets. The session host's read-only client is a negotiated
  `watch-attach` attachment (no claim, no pause ticket, host refuses its writes, never spawns, never
  indexed as the node's session; an older host means refused, never an ordinary attach). Where local
  terminals are neither (tmux off or missing, Zellij, an older host) a viewer can watch only a terminal
  the app has OPEN (there is no read-only client to spawn): the create dialog says so, and a refused join turns the chip amber `LIVE · 1
  waiting` ("Viewers are waiting — open this terminal in nodeterm…"). The stream is the owner's tmux
  CLIENT's output, so its session chooser or a session switch reaches viewers; the warning names it.
  A controller's input that does not reach the pane is reported (`watch:control {controlling,
  dropped}`, cause-neutral: the rate limit or a failed delivery, e.g. an SSH host without tmux).
- The Live chat drawer has ONE `nodeterm:live-chat` listener (Canvas); no OS notification per chat
  message (`control-taken` is the only link notice that raises one); a message counts as read only
  while the window is visible and focused.
- Stop all is the only control that reaches other machines' links: it is offered to a Pro owner even
  with no link listed here, awaits the server and reports what it reached (`RevokeAllOutcome`) — a
  failed or skipped server call must never look like a stop.
