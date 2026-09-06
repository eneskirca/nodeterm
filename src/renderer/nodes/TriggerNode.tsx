import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import {
  canonicalTriggerSpec,
  describeTriggerSchedule,
  sanitizeTriggerSpec,
  type TriggerNodeStatus,
  type TriggerSchedule,
  type TriggerSpec
} from '@shared/trigger'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import {
  RUN_OUTCOME_LABEL,
  TRIGGER_STATE_LINES,
  armConfirmMessage,
  formatCountdown,
  runNowConfirmMessage,
  triggerCardState
} from '../lib/triggerCard'
import { useProjects } from '../state/projects'
import { type CanvasNode } from '../state/workspace'
import { ConfirmDialog } from '../components/ConfirmDialog'

/** Poll cadence for `triggers.status` while the node is mounted — the read is in-memory core
 *  state, and a canvas holds few trigger nodes, so this stays cheap. */
const STATUS_POLL_MS = 5_000

/** How many history rows the card shows (the core ring holds 20). */
const RUNS_SHOWN = 5

interface DraftSpec {
  kind: TriggerSchedule['kind']
  expr: string
  everyMinutes: string
  at: string
  payload: string
  target: string
  note: string
}

const draftFrom = (spec: TriggerSpec | undefined): DraftSpec => ({
  kind: spec?.schedule.kind ?? 'interval',
  expr: spec?.schedule.kind === 'cron' ? spec.schedule.expr : '0 9 * * 1-5',
  everyMinutes: spec?.schedule.kind === 'interval' ? String(spec.schedule.everyMinutes) : '30',
  at: spec?.schedule.kind === 'once' ? spec.schedule.at : '',
  payload: spec?.payload ?? '',
  target: spec?.target ?? '',
  note: spec?.note ?? ''
})

function specFromDraft(d: DraftSpec): TriggerSpec | undefined {
  const schedule: unknown =
    d.kind === 'cron'
      ? { kind: 'cron', expr: d.expr }
      : d.kind === 'interval'
        ? { kind: 'interval', everyMinutes: Number(d.everyMinutes) }
        : // datetime-local yields a LOCAL wall time with no zone; Date.parse reads it as local,
          // and the ISO form keeps the schema's "parseable" rule happy on every machine.
          { kind: 'once', at: d.at ? new Date(d.at).toISOString() : '' }
  return sanitizeTriggerSpec({
    schedule,
    payload: d.payload,
    target: d.target,
    ...(d.note ? { note: d.note } : {})
  })
}

/**
 * The trigger node's card (issue #493, phase 4). All decisions the card renders are the pure
 * `lib/triggerCard.ts`; everything scheduled/armed/fired lives host-side — this component only
 * shows status and forwards explicit clicks over `window.nodeTerminal.triggers`.
 *
 * The honest-state rules the JSX must keep: DISARMED is a first-class visible state with the
 * "definitions travel, consent doesn't" narrative (never a bare grey nothing); CHANGED (armed for
 * other content) is distinct from disarmed; arming always passes a ConfirmDialog whose body shows
 * the exact schedule + payload + target being consented to; Run-now on a disarmed trigger
 * confirms the same way. On a relay tab the API stub refuses — the card says triggers are managed
 * on the host machine instead of showing dead buttons.
 */
export function TriggerNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements, getNodes } = useReactFlow()
  const projectId = useProjects((s) => s.activeProjectId)

  const spec = useMemo(() => sanitizeTriggerSpec(data.trigger), [data.trigger])
  const specCanon = spec ? canonicalTriggerSpec(spec) : ''

  const [status, setStatus] = useState<TriggerNodeStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [editing, setEditing] = useState(!spec)
  const [draft, setDraft] = useState<DraftSpec>(() => draftFrom(spec))
  const [draftError, setDraftError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<null | 'arm' | 'run'>(null)
  const [busy, setBusy] = useState(false)
  const [runNote, setRunNote] = useState<string | null>(null)
  const aliveRef = useRef(true)

  const refreshStatus = useCallback(async () => {
    try {
      const s = await window.nodeTerminal.triggers.status(projectId, id)
      if (!aliveRef.current) return
      setStatus(s)
      setUnavailable(false)
    } catch {
      if (aliveRef.current) setUnavailable(true) // the relay stub's refusal, or a dead bridge
    }
  }, [projectId, id])

  useEffect(() => {
    aliveRef.current = true
    void refreshStatus()
    const t = setInterval(() => void refreshStatus(), STATUS_POLL_MS)
    return () => {
      aliveRef.current = false
      clearInterval(t)
    }
    // specCanon: an edit re-reads immediately so the armed chip flips without waiting a poll.
  }, [refreshStatus, specCanon])

  // Local countdown tick — cheap, and only while there is something to count down to.
  useEffect(() => {
    if (status?.nextFireAt === null || status === null) return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [status])

  const state = triggerCardState(spec, status ?? undefined)
  const nodes = getNodes()
  const targetNode = spec ? nodes.find((n) => n.id === spec.target) : undefined
  const targetTitle = targetNode ? String(targetNode.data.title || spec?.target) : spec?.target ?? ''
  const countdown =
    state === 'armed' ? formatCountdown(status?.nextFireAt ?? null, now) : null

  const doArm = useCallback(async () => {
    if (!spec) return
    setBusy(true)
    try {
      const ok = await window.nodeTerminal.triggers.arm(projectId, id, spec)
      if (!ok) setRunNote('Arming was refused (invalid definition).')
      await refreshStatus()
    } catch {
      setUnavailable(true)
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }, [projectId, id, spec, refreshStatus])

  const doDisarm = useCallback(async () => {
    setBusy(true)
    try {
      await window.nodeTerminal.triggers.disarm(projectId, id)
      await refreshStatus()
    } catch {
      setUnavailable(true)
    } finally {
      setBusy(false)
    }
  }, [projectId, id, refreshStatus])

  const doRunNow = useCallback(async () => {
    setBusy(true)
    setConfirm(null)
    try {
      const r = await window.nodeTerminal.triggers.runNow(projectId, id)
      const chip = RUN_OUTCOME_LABEL[r.outcome]?.label ?? r.outcome
      setRunNote(r.detail ? `${chip} — ${r.detail}` : chip)
      await refreshStatus()
    } catch {
      setUnavailable(true)
    } finally {
      setBusy(false)
    }
  }, [projectId, id, refreshStatus])

  const saveDraft = useCallback(() => {
    const next = specFromDraft(draft)
    if (!next) {
      setDraftError(
        'Not a valid trigger yet — check the schedule, a non-empty payload, and pick a target node.'
      )
      return
    }
    setDraftError(null)
    // Persisted as git-shared content; an armed trigger is disarmed by this edit by construction
    // (the arm binds to the previous content), which the CHANGED state then explains.
    updateNodeData(id, { trigger: next })
    setEditing(false)
  }, [draft, id, updateNodeData])

  const targetOptions = nodes.filter((n) => n.type === 'terminal' && n.id !== id)
  const runs = (status?.runs ?? []).slice(-RUNS_SHOWN).reverse()

  const confirmBody = spec ? (
    <div className="trigger-node__confirm">
      <div><b>Schedule:</b> {describeTriggerSchedule(spec.schedule)}</div>
      <div><b>Target:</b> {targetTitle}</div>
      <pre className="trigger-node__payload">{spec.payload}</pre>
    </div>
  ) : null

  return (
    <div className={`trigger-node${selected ? ' selected' : ''}`} style={{ borderColor: data.color }}>
      <NodeResizer
        minWidth={NODE_MIN_SIZES.trigger.width}
        minHeight={NODE_MIN_SIZES.trigger.height}
        isVisible={selected}
        color={data.color}
      />
      <div className="trigger-node__header" style={{ background: `${data.color}33` }}>
        <span className="term-node__color" style={{ background: data.color }} />
        <input
          className="term-node__title nodrag"
          value={data.title}
          spellCheck={false}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
        <span className={`trigger-node__chip trigger-node__chip--${state}`}>
          {state === 'armed' ? 'ARMED' : state === 'changed' ? 'CHANGED' : state === 'invalid' ? 'SET UP' : 'DISARMED'}
        </span>
        <button className="term-node__close" title="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
          ×
        </button>
      </div>

      <div className="trigger-node__body nodrag">
        {unavailable ? (
          <div className="trigger-node__note">
            Triggers are managed on the machine that runs the sessions — not available from this
            view.
          </div>
        ) : editing ? (
          <div className="trigger-node__form">
            <label>
              Schedule
              <select
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as DraftSpec['kind'] })}
              >
                <option value="interval">every N minutes</option>
                <option value="cron">cron expression</option>
                <option value="once">once, at a time</option>
              </select>
            </label>
            {draft.kind === 'interval' && (
              <input
                type="number"
                min={1}
                value={draft.everyMinutes}
                onChange={(e) => setDraft({ ...draft, everyMinutes: e.target.value })}
              />
            )}
            {draft.kind === 'cron' && (
              <input
                placeholder="0 9 * * 1-5"
                value={draft.expr}
                onChange={(e) => setDraft({ ...draft, expr: e.target.value })}
              />
            )}
            {draft.kind === 'once' && (
              <input
                type="datetime-local"
                value={draft.at.includes('T') && !draft.at.endsWith('Z') ? draft.at : ''}
                onChange={(e) => setDraft({ ...draft, at: e.target.value })}
              />
            )}
            <label>
              Target
              <select value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })}>
                <option value="">— pick a terminal / agent node —</option>
                {targetOptions.map((n) => (
                  <option key={n.id} value={n.id}>
                    {String(n.data.title || n.id)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Payload (delivered into the target when the trigger fires)
              <textarea
                rows={3}
                value={draft.payload}
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, payload: e.target.value })}
              />
            </label>
            <input
              placeholder="Note (optional)"
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
            {draftError && <div className="trigger-node__error">{draftError}</div>}
            <div className="trigger-node__row">
              <button onClick={saveDraft}>Save</button>
              {spec && (
                <button
                  onClick={() => {
                    setDraft(draftFrom(spec))
                    setDraftError(null)
                    setEditing(false)
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        ) : spec ? (
          <>
            <div className="trigger-node__schedule">
              {describeTriggerSchedule(spec.schedule)}
              {countdown && <span className="trigger-node__countdown"> · {countdown}</span>}
            </div>
            <div className="trigger-node__target">
              → {targetTitle}
              {spec && !targetNode && <span className="trigger-node__error"> (missing)</span>}
            </div>
            <pre className="trigger-node__payload">{spec.payload}</pre>
            {spec.note && <div className="trigger-node__note">{spec.note}</div>}
            <div className="trigger-node__state-line">{TRIGGER_STATE_LINES[state]}</div>
            <div className="trigger-node__row">
              {state === 'armed' ? (
                <button disabled={busy} onClick={() => void doDisarm()}>
                  Disarm
                </button>
              ) : (
                <button disabled={busy || state === 'invalid'} onClick={() => setConfirm('arm')}>
                  Arm…
                </button>
              )}
              <button
                disabled={busy || state === 'invalid'}
                onClick={() => (state === 'armed' ? void doRunNow() : setConfirm('run'))}
              >
                Run now
              </button>
              <button disabled={busy} onClick={() => { setDraft(draftFrom(spec)); setEditing(true) }}>
                Edit
              </button>
            </div>
            {runNote && <div className="trigger-node__note">Last run: {runNote}</div>}
            {runs.length > 0 && (
              <div className="trigger-node__runs">
                {runs.map((r, i) => {
                  const meta = RUN_OUTCOME_LABEL[r.outcome] ?? { label: r.outcome, tone: 'muted' as const }
                  return (
                    <div key={`${r.at}-${i}`} className="trigger-node__run" title={r.detail}>
                      <span className={`trigger-node__run-chip trigger-node__run-chip--${meta.tone}`}>
                        {meta.label}
                      </span>
                      <span className="trigger-node__run-time">{new Date(r.at).toLocaleTimeString()}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        ) : (
          <div className="trigger-node__note">{TRIGGER_STATE_LINES.invalid}</div>
        )}
      </div>

      {confirm === 'arm' && spec && (
        <ConfirmDialog
          message={armConfirmMessage(spec, targetTitle)}
          body={confirmBody}
          confirmLabel="Arm on this machine"
          danger={false}
          onConfirm={() => void doArm()}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'run' && spec && (
        <ConfirmDialog
          message={runNowConfirmMessage(targetTitle)}
          body={confirmBody}
          confirmLabel="Run once now"
          danger={false}
          onConfirm={() => void doRunNow()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
