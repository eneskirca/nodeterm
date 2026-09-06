# Trigger nodes (issue #493)

A **trigger** is a first-class canvas node that fires a payload into a connected terminal/agent
node on a schedule — the *canvas* owns the schedule, unlike the ephemeral `/loop` `/schedule`
`/cron` cards, which visualize recurrence an *agent* set up inside its own process. Landed in four
phases: schema + arm store (#502), scheduler (#523), delivery (#595), UI (this one).

## Trust model (the part everything else follows from)

The trigger's **definition** (schedule `cron | interval | once`, payload, target node id, note)
lives on the node in `.nodeterm/project.json` — git-shared on purpose, and therefore HOSTILE
input: sanitized on every load path (`sanitizeNodeTriggers`, `@shared/trigger`), rebuilt
known-fields-only, malformed ⇒ an inert node.

The **consent** to fire is machine-local and content-bound: `core/trigger-arm-store.ts` records
`canonicalTriggerSpec` of the exact content the user armed, and `isArmed` answers true only while
the node's current spec canonicalizes to the same string. Consequences, all test-pinned:

- a trigger arriving via `git clone`/`pull` is **disarmed** until someone on this machine arms it;
- editing the schedule/payload/target — locally or via a pull — lands an armed trigger back in
  disarmed (`CHANGED` on the card), never runs the new content under the old consent;
- disarming (or editing) while a payload waits in the deliver-on-idle queue drops it at flush.

## The machine (all core, both shells)

`startTriggerService` (`core/trigger-service.ts`) composes everything once; desktop main and the
Server Edition boot the identical call — a headless SE fires with no browser tab open.

- **Scheduler** (`core/trigger-scheduler.ts`): 30 s sweep, fire-time `isArmed` re-ask, **no
  catch-up** (a host that slept through three slots fires once, from *now*; a spent `once` logs a
  single honest `missed`), exactly-once per slot. Cron is the dependency-free `@shared/cron`
  (five fields, names, steps, vixie dom/dow OR rule, local wall-clock; parse failure schedules
  nothing).
- **Delivery** (`core/trigger-delivery.ts`): the `sendText` paste path (`paste-buffer -p`,
  payload by stdin). An agent target delivers only on the mirror's idle `done`;
  working/blocked/unknown queue in a trigger-local `DeliveryQueue` instance (TTL 5 min) flushed
  by the mirror's `done` edge, with full flush-time re-validation. A plain-terminal target
  delivers only into a shell-owned pane and never queues. A dead target is a `missed`, never a
  cold start.
- **IPC** (`triggers:arm/disarm/status/run-now`, registered inside the service): `arm` binds the
  spec the renderer displayed (consent = what was seen); `run-now` takes **no** spec — the payload
  is resolved core-side from the node's persisted content, so a caller chooses *when*, never
  *what*. All inputs re-validated at the boundary.

## The card (`renderer/nodes/TriggerNode.tsx`, decisions in `renderer/lib/triggerCard.ts`)

Schedule line + live next-run countdown, target (plus a derived, never-persisted edge), payload
preview, note, and an honest state chip: `ARMED` / `DISARMED` (with the "definitions travel with
the project; arming is always a local decision" narrative) / `CHANGED` (armed for other content)
/ `SET UP` (no valid spec — the editor opens). Arming passes a ConfirmDialog whose body shows the
exact schedule + payload + target being consented to; Run-now on a disarmed trigger confirms the
same way. The last runs render from the core's ring: `fired`, `delivered-late`, `queued`,
`missed`, `failed`, `expired`.

## Surfaces

- **Desktop + Server Edition**: identical (core service + real ws-bridge namespace).
- **Relay tabs**: the stub refuses — the arm store and sessions live on the host, and arming from
  a guest would write another machine's execution consent. The card says so.
- **Mobile**: N/A (no canvas). The kanban board deliberately shows no trigger cards in v1: a
  trigger is configuration, not work-in-flight, and its *target* session already has a card —
  made as a conscious three-surfaces call, revisit if boards grow a configuration lane.
- **Host-alive v1** (the #493 design decision): nothing fires while the app is closed, and missed
  fires are logged, never retroactively run. The durable answer is a Server Edition host;
  OS-level scheduling (crontab/launchd/Task Scheduler) is a possible v2 as an explicit,
  reversible per-trigger opt-in — the #490 consent invariant applies in full.

## Device checklist (owed — written where it could not be run)

1. macOS: create → edit → arm → scheduled fire into an idle claude node; verify the payload
   arrives framed (no submit-per-line) and the run ring shows `fired`.
2. macOS: fire while the target is mid-turn → `queued`, then `delivered-late` on turn end;
   disarm while queued → dropped.
3. Server Edition (browser): same arm/fire round trip; then close the tab and verify a scheduled
   fire still lands (headless firing).
4. Relay tab: the card shows the managed-on-host notice, no dead buttons.
5. Fall-back DST hour + spring-forward hour behavior of a cron trigger (documented edges).
