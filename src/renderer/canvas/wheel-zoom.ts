/**
 * Wheel-zoom step shaping for the canvas — the pure half of Canvas.tsx's capture-phase wheel
 * handler.
 *
 * The per-EVENT clamp that used to live inline there assumed a classic notched wheel: one
 * physical click, one wheel event, so capping the event capped the click. High-resolution
 * ratchet wheels (Logitech MX Master 3S and friends) break that assumption — Chromium delivers
 * one detent as several pixel-mode packets a few milliseconds apart, each of which passed the
 * old clamp independently. Two maxed packets compound to exp(1) ≈ 2.7×, which is the reported
 * "one click jumped 200% → 84%".
 *
 * `WheelZoomBurstLimiter` therefore budgets by TIME, not by packet: every packet inside one
 * short burst window spends from a single ±`WHEEL_ZOOM_MAX_STEP` budget, so a detent zooms the
 * same amount whether the OS delivers it as one packet or four. The window is deliberately
 * shorter than any human's click cadence (a fast scroller manages ~8 clicks/sec ≈ 125 ms apart)
 * and long enough to cover a detent's packet spread; successive deliberate clicks each get a
 * fresh budget. A trackpad pinch (ctrl+wheel) flows through the same limiter but never feels
 * it: its packets are small and the per-window budget allows exp(0.5) per 40 ms ≈ 25× per
 * second, far beyond any physical pinch.
 */

import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from './zoom-limits'

/** One burst's total influence on zoom, in deltaY pixels — the historical per-event cap. */
export const WHEEL_ZOOM_MAX_STEP = 50

/** Packets closer together than this share one budget; must stay well under ~125 ms so
 *  deliberate successive clicks are never merged. */
const BURST_WINDOW_MS = 40

const ZOOM_STEP_RATE = 0.01

export class WheelZoomBurstLimiter {
  private burstStart = Number.NEGATIVE_INFINITY
  private spent = 0

  /** Returns how much of `deltaY` may influence zoom right now; 0 when the burst is spent. */
  apply(deltaY: number, now: number): number {
    if (now - this.burstStart >= BURST_WINDOW_MS) {
      this.burstStart = now
      this.spent = 0
    }
    // The budget is on absolute influence: a reversal inside an exhausted burst is device
    // jitter, not intent, and must not get a free counter-step.
    const remaining = WHEEL_ZOOM_MAX_STEP - this.spent
    const step = Math.sign(deltaY) * Math.min(Math.abs(deltaY), remaining)
    this.spent += Math.abs(step)
    return step || 0 // canonicalize -0 (sign(-x) * exhausted budget)
  }
}

/** The zoom the canvas moves to for an (already limited) wheel step at a given speed. */
export const nextWheelZoom = (zoom: number, deltaY: number, speed: number): number =>
  Math.min(
    CANVAS_MAX_ZOOM,
    Math.max(CANVAS_MIN_ZOOM, zoom * Math.exp(-deltaY * ZOOM_STEP_RATE * speed))
  )

/** settings.json is hand-editable, so the multiplier is validated at point of use (same
 *  convention as tmux scrollback): non-numbers fall back to 1, numbers clamp to the slider's
 *  range. */
export const clampWheelZoomSpeed = (speed: number | undefined): number =>
  typeof speed === 'number' && Number.isFinite(speed) ? Math.min(2, Math.max(0.2, speed)) : 1
