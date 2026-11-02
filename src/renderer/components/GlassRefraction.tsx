import { glassRefraction } from '../lib/glassContrast'

/**
 * The ONE refraction filter every Liquid Glass surface references (`backdrop-filter:
 * url(#nt-refract) …`, styles.css `--glass-refract`). An edge lens: a displacement map that is
 * neutral in the middle and pushes the backdrop outward near the edges, so the picture bends at a
 * surface's rim the way it does under Apple's glass. `primitiveUnits="objectBoundingBox"` scales it
 * to whatever element uses it, so one filter serves nodes, menus and the tab bar alike.
 *
 * It runs LAST in the backdrop chain (styles.css `--glass-blur`), so it bends pixels that are
 * already blurred, and its output is opaque everywhere: where the lens samples outside the element
 * (transparent), the undisplaced pixel fills in (`feComposite … over SourceGraphic`). Any
 * transparency here, or a reference filter ahead of blur(), lets Chromium show the SHARP backdrop
 * through a band at the rim — the old in-filter soft blur (default edgeMode) plus first-in-chain
 * order leaked terminal text through every menu edge. The soft blur is gone: the CSS blur before
 * it already does that job.
 */
let mapUrl: string | null = null

/** The displacement map, generated once per renderer (R = x push, G = y push, 128 = none).
 *  32px, not 256: the filter scales it to each surface (`preserveAspectRatio="none"`) and the lens
 *  is a smooth ramp, so 32 samples draw the same picture (MEASURED at Clear over the Sonoma still:
 *  mean difference 0.02/255, max 7). The bitmap's size was what the renderer paid for every frame
 *  a refracting surface was drawn: 256px cost a 6-terminal canvas 10% renderer CPU per streaming
 *  terminal, a 16px map nothing measurable. */
function displacementMap(): string {
  if (mapUrl) return mapUrl
  const size = 32
  const edge = 0.12
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return (mapUrl = '')
  const img = ctx.createImageData(size, size)
  const push = (u: number): number => (u < edge ? -(1 - u / edge) : u > 1 - edge ? 1 - (1 - u) / edge : 0)
  for (let y = 0; y < size; y++) {
    const dy = push(y / (size - 1))
    for (let x = 0; x < size; x++) {
      const dx = push(x / (size - 1))
      const i = (y * size + x) * 4
      img.data[i] = 128 + 127 * Math.sign(dx) * dx * dx
      img.data[i + 1] = 128 + 127 * Math.sign(dy) * dy * dy
      img.data[i + 2] = 128
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return (mapUrl = canvas.toDataURL())
}

export function GlassRefraction({ slider }: { slider: number }) {
  const map = displacementMap()
  if (!map) return null
  return (
    <svg width="0" height="0" aria-hidden style={{ position: 'absolute' }}>
      <filter
        id="nt-refract"
        x="0"
        y="0"
        width="100%"
        height="100%"
        colorInterpolationFilters="sRGB"
        primitiveUnits="objectBoundingBox"
      >
        <feImage href={map} x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="map" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="map"
          scale={glassRefraction(slider)}
          xChannelSelector="R"
          yChannelSelector="G"
          result="bent"
        />
        <feComposite in="bent" in2="SourceGraphic" operator="over" />
      </filter>
    </svg>
  )
}
