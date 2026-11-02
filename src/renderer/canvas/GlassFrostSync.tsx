import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore, useStoreApi } from '@xyflow/react'
import { useSettings } from '../state/settings'
import { useWallpaperBackground } from '../state/wallpaper'
import { useIsAerialWallpaper } from '../components/AerialWallpaper'
import { isLiquidGlass } from '../lib/appTheme'
import { useGlassA11y } from '../lib/useGlassA11y'
import { frostBox, frostImageSize, frostVars, wallpaperImageUrl } from '../lib/glassFrost'

/**
 * Static frost for Liquid Glass terminal nodes (lib/glassFrost.ts has the why and the numbers).
 *
 * This component decides whether the frost is on (`data-nt-frost` on <html>, which switches the
 * nodes' live backdrop-filter off in styles.css), prepares the wallpaper copy the frost paints, and
 * keeps every frost layer aligned with the real wallpaper as the camera moves.
 *
 * The alignment custom properties are written onto each registered frost layer, NEVER onto React
 * Flow's root: a custom property change restyles every element under the element it is set on
 * (lib/canvasZoomVar.ts), and a pan is a change per frame. A frost layer has no children, so the
 * per-frame write restyles a few dozen pseudo-elements, nothing else.
 */

const layers = new Set<HTMLElement>()
let current: Record<string, string> | null = null

function paint(el: HTMLElement): void {
  if (!current) return
  for (const [k, v] of Object.entries(current)) el.style.setProperty(k, v)
}

function publish(vars: Record<string, string> | null): void {
  current = vars
  for (const el of layers) {
    if (vars) paint(el)
    else for (const k of ['--frost-x', '--frost-y', '--frost-w', '--frost-h']) el.style.removeProperty(k)
  }
}

/** Ref callback for a node's `.term-node__frost` layer: registers it for alignment updates. */
export function useFrostLayer(): (el: HTMLDivElement | null) => void {
  const prev = useRef<HTMLDivElement | null>(null)
  return useCallback((el: HTMLDivElement | null) => {
    if (prev.current) layers.delete(prev.current)
    prev.current = el
    if (el) {
      layers.add(el)
      paint(el)
    }
  }, [])
}

interface FrostImage {
  /** The `background-image` value the frost paints. */
  css: string
  /** Natural size of the original image (cover placement); 0 for a gradient. */
  w: number
  h: number
}

const imageCache = new Map<string, Promise<FrostImage | null>>()

/** A downsized copy of a wallpaper image (lib/glassFrost.ts FROST_IMAGE_EDGE), as a data: URL —
 *  the renderer's CSP allows data: images and not blob:. Keeps the two most recent. */
function frostImage(url: string): Promise<FrostImage | null> {
  let p = imageCache.get(url)
  if (p) return p
  if (imageCache.size >= 2) imageCache.delete(imageCache.keys().next().value as string)
  p = (async (): Promise<FrostImage | null> => {
    const img = new Image()
    img.src = url
    await img.decode()
    const size = frostImageSize(img.naturalWidth, img.naturalHeight)
    if (!size) return null
    const canvas = document.createElement('canvas')
    canvas.width = size.w
    canvas.height = size.h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, size.w, size.h)
    // WebP keeps an imported PNG's transparency; a browser that cannot encode it returns PNG.
    return { css: `url("${canvas.toDataURL('image/webp', 0.9)}")`, w: img.naturalWidth, h: img.naturalHeight }
  })().catch(() => null)
  imageCache.set(url, p)
  void p.then((v) => {
    if (v === null && imageCache.get(url) === p) imageCache.delete(url)
  })
  return p
}

/**
 * The frost's picture for the current wallpaper: `null` = no wallpaper (the frost is the canvas
 * colour), `undefined` = not ready (the live backdrop stays on meanwhile).
 */
function useFrostImage(bg: string | null, enabled: boolean): FrostImage | null | undefined {
  const url = enabled && bg ? wallpaperImageUrl(bg) : null
  const [loaded, setLoaded] = useState<{ url: string; img: FrostImage | null } | null>(null)
  useEffect(() => {
    if (!url) return
    let live = true
    void frostImage(url).then((img) => {
      if (live) setLoaded({ url, img })
    })
    return () => {
      live = false
    }
  }, [url])
  if (!enabled) return undefined
  if (!bg) return null
  if (!url) return { css: bg, w: 0, h: 0 }
  // A copy that could not be made keeps the live backdrop (undefined), never a black frost.
  return loaded?.url === url ? (loaded.img ?? undefined) : undefined
}

function GlassFrostSyncImpl(): JSX.Element | null {
  const liquidGlass = isLiquidGlass(useSettings((s) => s.settings.appTheme))
  const a11y = useGlassA11y()
  const aerial = useIsAerialWallpaper()
  const bg = useWallpaperBackground()
  const enabled = liquidGlass && !a11y.reduceTransparency && !aerial
  const image = useFrostImage(bg, enabled)
  const active = image !== undefined
  const store = useStoreApi()
  const domNode = useStore((s) => s.domNode)

  useLayoutEffect(() => {
    if (!active || !domNode) return
    const root = domNode.closest('.canvas-root') as HTMLElement | null
    if (!root) return
    let geo = { rootW: 0, rootH: 0, offX: 0, offY: 0 }
    const measure = (): void => {
      const r = root.getBoundingClientRect()
      const f = domNode.getBoundingClientRect()
      geo = { rootW: r.width, rootH: r.height, offX: f.left - r.left, offY: f.top - r.top }
    }
    const apply = (): void => {
      const [tx, ty, zoom] = store.getState().transform
      const box = frostBox({ ...geo, tx, ty, zoom, imgW: image?.w, imgH: image?.h })
      if (box) publish(frostVars(box))
    }
    measure()
    apply()
    const unsubscribe = store.subscribe((s, prev) => {
      if (s.transform !== prev.transform) apply()
    })
    const ro = new ResizeObserver(() => {
      measure()
      apply()
    })
    ro.observe(root)
    ro.observe(domNode)
    document.documentElement.dataset.ntFrost = 'on'
    return () => {
      unsubscribe()
      ro.disconnect()
      delete document.documentElement.dataset.ntFrost
      publish(null)
    }
  }, [active, domNode, store, image?.w, image?.h])

  // The picture rides ONE stylesheet rule, never a custom property: Chromium drops a var() value
  // past ~2 MB (state/wallpaper.ts), and a rule is parsed once however many nodes paint it.
  if (!active || !image) return null
  return <style>{`.term-node__frost::before{background-image:${image.css}}`}</style>
}

export const GlassFrostSync = memo(GlassFrostSyncImpl)
