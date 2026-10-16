import { useEffect, useLayoutEffect, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from './canvas/Canvas'
import { PromptDialogHost } from './components/promptDialog'
import { NodeIconDialogHost } from './components/NodeIconPicker'
import { SessionProvider } from './session/session'
import { localSession } from './session/localSession'
import { useSettings } from './state/settings'
import { useViewMode } from './state/viewMode'
import { setWebglEnabled } from './terminal/webgl-budget'
import { applyRendererMode } from './terminal/renderer-mode'
import { useSharedGlyph } from './canvas/SharedGlyphLayer'
// `resolveGpuRendering` is gone: 'shared' turned the setting into a renderer CHOICE rather than a
// webgl on/off, so `resolveTerminalRenderer` answers it and `applyRendererMode` owns the ordering
// between the two coordinators.
import { resolveTerminalRenderer } from '../shared/webgl'
import { resolveTerminalTheme } from './terminal/themes'
import { resolveUiScale } from '../shared/ui-scale'
import { resolveTabBarHeight } from '../shared/window-chrome-metrics'
import {
  resolveMarkdownCodeFontFamily,
  resolveMarkdownFontFamily,
  resolveMarkdownFontSize
} from '../shared/markdown-font'
import { useAppTheme } from './state/useAppTheme'
import { installWindowActivityOnDocument } from './lib/windowActivity'
import {
  glassChromeAlpha,
  glassChromeAlphas,
  glassChromeHighlights,
  glassControlClearAlpha,
  parseCssColor,
  resolveGlassSlider
} from './lib/glassContrast'
import { useGlassA11y } from './lib/useGlassA11y'
import { GlassRefraction } from './components/GlassRefraction'
import { isLiquidGlass } from './lib/appTheme'

export default function App() {
  // Apply the terminal-rendering setting to the two GPU coordinators, live. 'auto' is
  // per-terminal WebGL on every platform (see `resolveTerminalRenderer` for the history of the
  // macOS branch and the evidence that collapsed it). 'off' reclaims every context; 'shared'
  // takes the per-terminal budget down entirely and brings up the one canvas-wide glyph context
  // instead. `applyRendererMode` owns the ordering contract between the two (and its test).
  // Subscribed at the root so it holds whatever view is showing.
  const gpu = useSettings((s) => s.settings.terminalGpuRendering)
  useEffect(() => {
    applyRendererMode(resolveTerminalRenderer(gpu), {
      setWebglEnabled,
      setSharedEnabled: (on) => useSharedGlyph.getState().setEnabled(on)
    })
  }, [gpu])

  // Publish the active terminal theme's background as a CSS variable. xterm paints its own
  // background, but the chrome AROUND it does not: the canvas node's body shows through the few px
  // its xterm host is inset by (and through a co-attach letterbox), and the kanban card modal
  // frames its terminal in an 8px pad. Without this both keep the app's colour and every
  // non-default theme renders inside a mismatched frame.
  const terminalTheme = useSettings((s) => s.settings.terminalTheme)
  useEffect(() => {
    const { background } = resolveTerminalTheme(terminalTheme).theme
    if (background) document.documentElement.style.setProperty('--term-bg', background)
  }, [terminalTheme])

  // The tab bar's height is a setting (Settings → Appearance). Everything positioned against the
  // bar reads the `--tabbar-h` token, so publishing the resolved value on <html> is the whole
  // renderer side; main re-centres the macOS traffic lights from the same setting. The token's
  // stylesheet default (`TABBAR_HEIGHT_PX`) stands until this runs, so a not-yet-hydrated
  // settings store draws the default bar rather than none.
  const tabBarHeight = useSettings((s) => s.settings.tabBarHeight)
  useEffect(() => {
    document.documentElement.style.setProperty('--tabbar-h', `${resolveTabBarHeight(tabBarHeight)}px`)
  }, [tabBarHeight])

  // The rendered-Markdown views' font (Settings → Appearance; @shared/markdown-font). Published as
  // tokens like `--tabbar-h`: styles.css keeps the defaults on :root, so an un-hydrated store
  // draws the default font. Code inside Markdown takes the terminal's font family.
  const markdownFontFamily = useSettings((s) => s.settings.markdownFontFamily)
  const markdownFontSize = useSettings((s) => s.settings.markdownFontSize)
  const terminalFontFamily = useSettings((s) => s.settings.fontFamily)
  useEffect(() => {
    const style = document.documentElement.style
    style.setProperty('--md-font-family', resolveMarkdownFontFamily(markdownFontFamily))
    style.setProperty('--md-font-size', `${resolveMarkdownFontSize(markdownFontSize)}px`)
    style.setProperty('--md-code-font-family', resolveMarkdownCodeFontFamily(terminalFontFamily))
  }, [markdownFontFamily, markdownFontSize, terminalFontFamily])

  // Hold every infinite CSS animation still while nobody is looking at this window (the gate is
  // `--nt-anim-state` / `[data-nt-window]` in styles.css, where the measurements live). Installed
  // here rather than in Canvas because the surfaces that animate outside the canvas — the
  // onboarding scenes, the settings spinners, the sessions sidebar — are mounted here too, and a
  // gate that covers most of the animations buys nothing: one that keeps running keeps the
  // compositor producing frames, which is the entire cost.
  useEffect(() => installWindowActivityOnDocument(), [])

  // Publish the resolved appearance as `data-theme` on <html> — what the light palette in
  // styles.css keys off. Absent, or 'dark', leaves every token at its original value, so this one
  // attribute is all that stands between an existing install and the chrome it has always had.
  // Layout effects, like the two glass effects below: all three land before the browser paints, so
  // switching Liquid Glass on never shows one frame of `data-nt-glass` without its fill (transparent
  // chrome), and a theme switch never paints the old theme's fill. The setGlassChrome in the first
  // glass effect re-renders synchronously, still before paint.
  const appTheme = useAppTheme()
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = appTheme
  }, [appTheme])

  // Liquid Glass (Settings → Appearance). `data-nt-glass` switches the chrome rules in styles.css
  // on, and `--glass-chrome-bg` is the ONE fill every glass chrome surface uses: the resolved
  // `--panel` at the alpha that keeps the resolved `--text` at 4.5:1 over any backdrop
  // (`glassChromeAlpha`). Read from the computed tokens rather than re-typed here, so the palette
  // stays the one source of truth; declared after the data-theme effect, so it reads the tokens
  // of the theme that effect just applied. An unparseable token leaves the chrome opaque.
  const liquidGlass = isLiquidGlass(useSettings((s) => s.settings.appTheme))
  // The accent is one of the highlight washes the readable alpha is solved for.
  const accent = useSettings((s) => s.settings.accent)
  // The Glass slider moves every surface between Clear and Tinted through its own readable alpha
  // (glassSliderAlpha); `--glass-t` scales the blur in CSS.
  const glassSlider = resolveGlassSlider(useSettings((s) => s.settings.glassTint))
  // Reduce Transparency / Increase Contrast outrank the slider (opaque / Tinted), like iOS.
  const glassA11y = useGlassA11y()
  // Increase Contrast pins the WHOLE slider to Tinted — alpha, blur and refraction alike.
  const glassT = glassA11y.moreContrast ? 1 : glassSlider
  // The readable alpha depends only on the resolved theme, and computing it is ~16k contrast
  // evaluations plus a style recalc; it is measured once per theme, never per slider input.
  const [glassChrome, setGlassChrome] = useState<{
    panel: string
    rgb?: readonly number[]
    readable: number | null
    controlClear: number
  } | null>(null)
  useLayoutEffect(() => {
    const root = document.documentElement
    if (!liquidGlass) {
      delete root.dataset.ntGlass
      setGlassChrome(null)
      return
    }
    // Read the tokens with the glass overrides OFF: under them `--panel` IS the glass fill, and a
    // theme switch would otherwise compute the new alpha from the old theme's fill.
    delete root.dataset.ntGlass
    const css = getComputedStyle(root)
    const text = css.getPropertyValue('--text').trim()
    const panel = css.getPropertyValue('--panel').trim()
    // The fill must also carry the highlighted rows and the active tab (their washes stack on it).
    const highlights = glassChromeHighlights(
      css.getPropertyValue('--text-strong').trim(),
      css.getPropertyValue('--tint-rgb').trim(),
      // The setting, not the `--accent` property: Canvas writes that in a later effect.
      accent
    )
    root.dataset.ntGlass = 'on'
    // The controls' backdrop dimming (dark) / brightening (light) at Clear lives in styles.css.
    const dim = Number.parseFloat(getComputedStyle(root).getPropertyValue('--glass-control-dim'))
    setGlassChrome({
      panel,
      rgb: parseCssColor(panel)?.rgb,
      readable: glassChromeAlpha(text, panel, 4.5, highlights),
      controlClear: glassControlClearAlpha(text, panel, dim)
    })
  }, [liquidGlass, appTheme, accent])
  // The slider (and the accessibility overrides) only ever set custom properties. Two fills:
  // `--glass-chrome-bg` for text surfaces (never below the readable alpha) and `--glass-control-bg`
  // for the small floating controls (follow the slider to a 0.35 floor) — glassChromeAlphas.
  useLayoutEffect(() => {
    const root = document.documentElement
    if (!glassChrome) {
      root.style.removeProperty('--glass-chrome-bg')
      root.style.removeProperty('--glass-control-bg')
      root.style.removeProperty('--glass-t')
      return
    }
    const { panel, rgb, readable, controlClear } = glassChrome
    // An unparseable token leaves the chrome opaque (`panel` as is).
    const alphas = readable !== null && rgb ? glassChromeAlphas(glassSlider, readable, glassA11y, controlClear) : null
    const fill = (a: number | undefined): string => (a !== undefined && rgb ? `rgba(${rgb.join(', ')}, ${a.toFixed(3)})` : panel)
    root.style.setProperty('--glass-chrome-bg', fill(alphas?.text))
    root.style.setProperty('--glass-control-bg', fill(alphas?.control))
    root.style.setProperty('--glass-t', glassT.toFixed(3))
  }, [glassChrome, glassSlider, glassA11y, glassT])

  // Apply the UI scale as page zoom (issue #299 — 4K readability; the why-page-zoom write-up
  // lives in shared/ui-scale.ts). Gated on `hydrated` so boot doesn't flash-reset a scaled window
  // to the 100% default before settings.json has been read — Electron restores the zoom it
  // persisted per origin, and asserting the default over it would visibly bounce the whole UI.
  // On the Server Edition `setUiZoomFactor` is a documented no-op (the browser owns page zoom).
  const uiScale = useSettings((s) => s.settings.uiScale)
  const settingsHydrated = useSettings((s) => s.hydrated)
  useEffect(() => {
    if (settingsHydrated) window.nodeTerminal.setUiZoomFactor(resolveUiScale(uiScale))
  }, [uiScale, settingsHydrated])

  // Keep the view-mode store's default in sync with the Settings choice, so projects the user
  // hasn't explicitly toggled follow it (and flip live when the setting changes).
  const defaultView = useSettings((s) => s.settings.defaultProjectView)
  useEffect(() => {
    useViewMode.getState().setDefaultView(defaultView === 'kanban' ? 'kanban' : 'canvas')
  }, [defaultView])

  return (
    <SessionProvider session={localSession}>
      <ReactFlowProvider>
        <Canvas />
        {/* In-app window.prompt replacement (Electron has no prompt); driven by promptDialog(). */}
        <PromptDialogHost />
        {/* The node-icon picker, opened from the node menu, a node header and the kanban card
            modal — one dialog for all three, driven by nodeIconDialog(). */}
        <NodeIconDialogHost />
        {liquidGlass && !glassA11y.reduceTransparency && <GlassRefraction slider={glassT} />}
      </ReactFlowProvider>
    </SessionProvider>
  )
}
