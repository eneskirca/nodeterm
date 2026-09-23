# Mobile pane presence (#580)

The dormant host producer supports this additive `agent-status.json` v1 field `nodes[id].panePresence`:

```json
{"kind":"agent","checkedAt":1750000000000,"expiresAt":1750000030000}
```

`kind` is `agent`, `shell`, or `unknown`. Times are Unix milliseconds. This observation is
independent of the hook-driven `state` and `updatedAt`; neither clock substitutes for the other.
A node without any recent hook can have presence with `updatedAt: 0` and no `state`. A stale
`done` can coexist with a fresh `shell`. Old readers ignore the additive field.

Neither Desktop nor Server starts the sampler: the current mobile decoder has no consumer.
This PR therefore changes no production polling or session-row counts and does not resolve #580.
Before enabling local sampling, wire demand from a presence-capable consumer AND enabled phone
access. Pairing alone is insufficient. The core's explicit `enabled` predicate must cover both;
disabling it clears observations and discards pending results. Do not add SSH polling: remote
nodes remain unknown, with no local fallback. A future SSH consumer needs a separate on-demand
integration, outside this PR.

When explicitly enabled, the core samples local nodes every 15 seconds with one tmux listing
and one process-table read; overlapping sweeps coalesce. Missing panes, failed commands,
ambiguous multi-pane sessions and unrecognized programs yield unknown. Native Windows
session-host sessions have no POSIX foreground identity and deliberately yield unknown.
Only semantic changes (node membership or effective kind) schedule mirror writes. Fresh sample
clocks are cached for the existing heartbeat or other writes, without accelerating SSH pushes.
A reader may expire a sample between heartbeats; retain unknown until fresh evidence arrives,
never extend the 30-second TTL to hide that gap.

`agent` means a recognized agent executable was observed in the foreground process group. It
is not a proof of responsiveness, successful turn completion, or exclusive ownership of input.
`shell` means the pane's root shell alone owns that group; an agent's tool subshell is insufficient.
Unknown programs, custom aliases we cannot resolve, background agents and foreground tool jobs
remain unknown. The cached result must NEVER become a messaging, termination or authorization gate.
No argv, process IDs or tty paths are published.

Readers must display unknown when the field is absent, `checkedAt` is in the future, or
`expiresAt <= now` (including host shutdown or a stalled probe). Never replace an expired sample's
clock with the file's heartbeat or retain the last successful verdict. The host also downgrades
expired samples on each mirror flush; observations are not restored from disk at boot. Existing
phone/host clock synchronization is required for the absolute freshness window.

## iOS follow-up (separate repository, @eneskirca)

Read-only inspection of `nodeterm-ios/NodeTerm/Services/NodetermProjects.swift` found that
`StatusFile.Entry` and `parseStatusDoc` do not yet decode pane presence. Add tolerant decoding,
carry the independent timestamps through discovery merging and the session list, and expire the
view even if polling stops. Keep hook activity, sleeping state and this phone's transport separate.
No iOS files were changed here; the prior app-side status wording fix does not consume this field.

Device checks still owed: A–D from #580 over both LAN and Relay; idle overnight agent; CLI exit
without a hook; foreground tool subprocess; host shutdown; disconnected/reconnected SSH project;
custom agent; multi-pane session; native Windows unknown. macOS/BSD process-table formatting,
real SSH transport and iOS UI/device behavior are not verified by Linux fixture tests.
