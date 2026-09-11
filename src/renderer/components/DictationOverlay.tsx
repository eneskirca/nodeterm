// Desktop press-to-talk: shortcut/Dock-mic press starts recording IMMEDIATELY into a compact
// bottom-center pill (stop icon + live equalizer + elapsed mm:ss); pressing again (or the pill's
// own stop icon) stops → transcribes → inserts the text directly into the target terminal
// (`pty.sendText(id, text, { enter: false })`, no Enter — nothing here ever auto-submits) and the
// pill closes.
//
// Two different ways to dismiss, not interchangeable:
//  - STOP (shortcut second-press / the pill's stop icon) — ends the recording and PROCESSES it
//    (transcribe → insert).
//  - CANCEL (Esc, or the ×/close affordances) — DISCARDS whatever was being recorded and closes
//    the whole overlay. Esc mid-recording is cancel, not stop, even though both are triggered by
//    a "press" — see handleClose vs the stopSignal branch below.
//
// No target selected at press time never records at all — see the warning-pill render branch.
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconClose } from './icons'
import { createPortal } from 'react-dom'
import { equalizerBars } from '../lib/dictation-equalizer'
import { PcmCapture } from '../lib/pcm-capture'
import { useSession } from '../session/session'
import { useSettings } from '../state/settings'
import { hasSpeechModel } from '@shared/speech'

export interface DictationTarget {
  kind: 'terminal'
  nodeId: string
  title: string
}

export interface DictationOverlayProps {
  target: DictationTarget | null
  /** Bumped by Canvas's toggleDictation on a second shortcut/Dock-mic press while the overlay is
   *  already open. A no-op prop change is the signal (any new value ≠ close-then-reopen — the
   *  overlay itself decides what a "press again" means from its own current phase: STOP while
   *  recording, CANCEL/close otherwise). */
  stopSignal: number
  onClose: () => void
  /** Routes to Settings → License (same section SpeechSection's own Pro upsells use) — invoked
   *  from the "See nodeterm Pro" action shown beside a Pro-model transcribe error. */
  onOpenLicense: () => void
}

/** A Pro-gated model was picked but the account isn't premium — see SpeechService.transcribeNow,
 *  which throws exactly this shape. Matched by substring since the model id is interpolated in. */
export function isProGateError(message: string): boolean {
  return message.includes('requires nodeterm Pro')
}

type Phase = 'idle' | 'recording' | 'transcribing'
/** 'no-model' = dictation is off (Whisper engine with the explicit None selection, issue #143) —
 *  never records, explains where to turn it on. 'warning' = no target at press time (never
 *  records). 'pill' = the compact recording/transcribing/error capsule — the whole surface for a
 *  terminal target, start to finish (the transcript is inserted straight into the terminal, so
 *  there is no editable card). */
export type DictationMode = 'no-model' | 'warning' | 'pill'

/** Pure — no side effects. Exported for its own unit coverage.
 *
 *  'no-model' wins over everything, target included: with a model missing the failure would
 *  otherwise surface only AFTER the user spoke a whole take (transcribe throws), which reads as
 *  a broken feature rather than an off one. */
export function dictationMode(target: DictationTarget | null, hasModel: boolean): DictationMode {
  if (!hasModel) return 'no-model'
  return target ? 'pill' : 'warning'
}

/** mm:ss, floored to whole seconds. Pure — no side effects. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Faster than the visual 12-bar window needs on its own — the point is to feed more DISTINCT
// samples into that scrolling window (see dictation-equalizer.ts) so the equalizer reads as live
// motion instead of a slow crawl. PcmCapture.level() (RMS of the last chunk) is cheap enough that
// polling twice as often here has no measurable cost.
const LEVEL_POLL_MS = 50 // ~20Hz

// Base64-encoded int16 PCM runs ~2.6 MB/min. The ws bridge caps a single frame at
// WS_MAX_PAYLOAD (8 MiB, see src/server/ws.ts) — a take left running past ~3 minutes would
// produce a transcribe payload big enough to blow that budget, and `ws` drops the WHOLE
// connection on an oversized frame, not just the one message. Auto-stop well under that line.
const MAX_RECORDING_MS = 150_000 // 2:30

/** Whether elapsed recording time has crossed the hard cap (see MAX_RECORDING_MS above). Pure. */
export function isAtRecordingCap(elapsedMs: number): boolean {
  return elapsedMs >= MAX_RECORDING_MS
}

/** How long the "no target selected" / "no model" warning pill stays up before it auto-dismisses. */
const NO_TARGET_DISMISS_MS = 2500

export function DictationOverlay({ target, stopSignal, onClose, onOpenLicense }: DictationOverlayProps) {
  const { api } = useSession()
  // The off state only exists for the local Whisper engine — cloud brings its own model. Read once
  // per mount (the overlay is a fresh mount per shortcut press, like `target`).
  const speech = useSettings((s) => s.settings.speech)
  const modelReady = speech.engine !== 'whisper' || hasSpeechModel(speech.model)

  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [levelHistory, setLevelHistory] = useState<number[]>([])
  const [capped, setCapped] = useState(false)

  const captureRef = useRef<PcmCapture | null>(null)
  const consentAskedRef = useRef(false)
  const startedAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const discardedRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Set false only in the unmount cleanup below. `dictationOpen`/`onClose` are shared with
  // Canvas across the whole overlay, not scoped to this mounted instance (only the React key/
  // nonce is) — so a stale instance (remounted-over by a fresh press while its own transcribe
  // was still in flight) must still deliver its transcript, but must NOT call onClose(): a
  // newer instance may be live and recording, and onClose() would unmount it out from under
  // itself. See the async-continuation sites in stopRecording below.
  const mountedRef = useRef(true)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Belt-and-braces: if this component unmounts mid-recording (parent flips `open` without going
  // through handleClose — e.g. a project switch), the mic must not stay live.
  useEffect(() => {
    return () => {
      mountedRef.current = false
      clearTimer()
      captureRef.current?.cancel()
      captureRef.current = null
    }
  }, [clearTimer])

  const stopRecording = useCallback(async () => {
    clearTimer()
    const capture = captureRef.current
    captureRef.current = null
    if (!capture) return
    const pcm = capture.stop()
    setPhase('transcribing')
    try {
      const { text: transcribed } = await window.nodeTerminal.speech.transcribe(pcm)
      if (!target) {
        // Defensive only — recording never starts without a target (see the mount effect below).
        // Guarded like the terminal-insert path below: a superseded (remounted-over) instance
        // must not close an overlay a newer instance may now own.
        if (mountedRef.current) onClose()
        return
      }
      // An in-flight transcription can't be aborted — dropping the result honors the user's
      // dismissal (nothing may land after a cancel).
      if (discardedRef.current) return
      const ok = await api.pty.sendText(target.nodeId, transcribed, { enter: false })
      if (!ok) {
        setError('Could not insert — the terminal session is not available.')
        setPhase('idle')
        return
      }
      // A stale (remounted-over) instance still delivers its own transcript into the
      // terminal — the target closure is per-instance and correct — but must not close the
      // parent overlay state: a newer instance (a fresh hold-to-talk press that arrived while
      // this one was still transcribing) may be live and recording in it right now.
      if (mountedRef.current) onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcription failed.')
      setPhase('idle')
    }
  }, [clearTimer, target, api, onClose])

  const startRecording = useCallback(async () => {
    if (!target) return
    setError(null)
    setCapped(false)
    if (!consentAskedRef.current) {
      consentAskedRef.current = true
      try {
        const ok = await window.nodeTerminal.speech.micConsent()
        if (!ok) {
          setError(
            'Microphone access was not granted — allow it in System Settings (or your browser site settings) and try again.'
          )
          return
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not request microphone access.')
        return
      }
    }

    const capture = new PcmCapture()
    try {
      await capture.start()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start recording.')
      return
    }
    captureRef.current = capture

    startedAtRef.current = Date.now()
    setElapsedMs(0)
    setLevelHistory([])
    setPhase('recording')
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current
      setElapsedMs(elapsed)
      const level = captureRef.current?.level() ?? 0
      setLevelHistory((prev) => [...prev, level])
      if (isAtRecordingCap(elapsed)) {
        // clearTimer() inside stopRecording fires synchronously before any await, so this can't
        // re-enter on the next tick.
        setCapped(true)
        void stopRecording()
      }
    }, LEVEL_POLL_MS)
  }, [target, stopRecording])

  // Press-to-talk: a target means "start recording now" (this instance is a fresh mount each
  // time Canvas opens the overlay, and the target is frozen for its lifetime — see
  // DictationOverlayProps — so this is correctly mount-only). No target means the warning pill;
  // it never records, and auto-dismisses on its own.
  useEffect(() => {
    // Both warning shapes never record and auto-dismiss: no target, and dictation-off (no model —
    // recording a take that transcribe is guaranteed to refuse would waste the user's speech).
    if (!target || !modelReady) {
      const t = setTimeout(() => onCloseRef.current(), NO_TARGET_DISMISS_MS)
      return () => clearTimeout(t)
    }
    void startRecording()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleClose = useCallback(() => {
    discardedRef.current = true
    if (phase === 'recording') {
      clearTimer()
      captureRef.current?.cancel()
      captureRef.current = null
    }
    onClose()
  }, [phase, clearTimer, onClose])

  // Esc closes (own listener, same pattern as ShortcutsPanel — only active while mounted, so it
  // never competes with Canvas's own Esc handling elsewhere). This is CANCEL, not stop — see the
  // file header.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleClose])

  // A second shortcut/Dock-mic press while this overlay is already open (Canvas bumps
  // `stopSignal` rather than unmounting us — see DictationOverlayProps). While actively
  // recording that means STOP (transcribe → insert); in every other phase (warning,
  // transcribing, an error pill) it means dismiss, same as Esc/×.
  const prevStopSignalRef = useRef(stopSignal)
  useEffect(() => {
    if (stopSignal === prevStopSignalRef.current) return
    prevStopSignalRef.current = stopSignal
    if (phase === 'recording') {
      void stopRecording()
    } else {
      handleClose()
    }
  }, [stopSignal, phase, stopRecording, handleClose])

  const mode = dictationMode(target, modelReady)

  const errorBlock = error && (
    <div className="dictation__error">
      <span>{error}</span>
      {isProGateError(error) && (
        <button type="button" className="dictation__error-action" onClick={onOpenLicense}>
          See nodeterm Pro
        </button>
      )}
      <button type="button" className="dictation__close" title="Dismiss" aria-label="Dismiss" onClick={handleClose}>
        <IconClose />
      </button>
    </div>
  )

  if (mode === 'warning' || mode === 'no-model') {
    return createPortal(
      <div className="dictation dictation--warning nodrag nowheel" onMouseDown={(e) => e.stopPropagation()}>
        <span className="dictation__warning-text">
          {mode === 'no-model'
            ? 'Dictation is off — choose a Whisper model in Settings → Speech.'
            : 'Select a terminal node first.'}
        </span>
        <button type="button" className="dictation__close" title="Dismiss" aria-label="Dismiss" onClick={handleClose}>
          <IconClose />
        </button>
      </div>,
      document.body
    )
  }

  // mode === 'pill' — the whole surface for a terminal target (a transcribed take is inserted
  // straight into the terminal, so there is no editable card).
  return createPortal(
      <div className="dictation dictation--pill nodrag nowheel" onMouseDown={(e) => e.stopPropagation()}>
        {phase === 'recording' && (
          <div className="dictation__pill">
            {/* Live equalizer bars, centered so they grow up AND down from
                the middle — a scrolling window of real mic levels (newest at
                the right); silence keeps a visible baseline row. */}
            <div className="dictation__bars" aria-hidden="true">
              {equalizerBars(levelHistory, 7).map((h, i) => (
                <span key={i} className="dictation__bar" style={{ height: `${Math.round(h * 100)}%` }} />
              ))}
            </div>
            <span className="dictation__label">Dictating...</span>
            <span className="dictation__elapsed">{formatElapsed(elapsedMs)}</span>
            <span className="dictation__spacer" />
            <button
              type="button"
              className="dictation__pause"
              onClick={() => void stopRecording()}
              title="Stop recording — transcribes & inserts"
            >
              <PauseIcon />
            </button>
          </div>
        )}

        {phase === 'transcribing' && (
          <div className="dictation__transcribing">
            <span className="dictation__spinner" />
            <span>{capped ? 'Recording capped at 2:30 — transcribing…' : 'Transcribing…'}</span>
          </div>
        )}

        {phase === 'idle' && !error && (
          <div className="dictation__transcribing">
            <span className="dictation__spinner" />
            <span>Starting…</span>
          </div>
        )}

        {errorBlock}
      </div>,
      document.body
    )
}

function PauseIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1.5" />
      <rect x="14" y="4" width="4" height="16" rx="1.5" />
    </svg>
  )
}
