import { createRoot } from 'react-dom/client'
import { CanvasPills } from '../../src/renderer/components/CanvasPills'
import { UsageIndicator } from '../../src/renderer/components/UsageIndicator'
import type { ClaudeUsage, UsageLimit } from '../../src/shared/types'
import { useSettings } from '../../src/renderer/state/settings'
import { Dock } from '../../src/renderer/components/Dock'

const limit = (kind: string, usedPercent: number, scopeLabel: string | null = null): UsageLimit => ({ kind, usedPercent, scopeLabel, severity: 'warning', resetsAt: null, group: null, windowMinutes: null, isActive: false })
const usage: ClaudeUsage = { session: null, weekly: null, email: null, status: 'ok', limits: [limit('session', 96), limit('weekly_all', 52), limit('weekly_scoped', 82, 'Fable')], updatedAt: Date.now() }
useSettings.setState(s => ({ settings: { ...s.settings, usagePercentMode: 'used' } }))
let refreshes = 0
window.nodeTerminal = { usage: {
  fetch: async () => usage,
  refresh: async () => { refreshes++; return usage },
  onUpdate: () => () => {},
  providers: async () => ['codex', 'grok'].map(provider => ({ provider, status: 'ok', account: null, updatedAt: Date.now(), limits: [limit('session', provider === 'codex' ? 42 : 84)] }))
} }
createRoot(document.getElementById('root')!).render(
  <div className="canvas-root" style={{ width: 1470, height: 862 }}>
    <div className="flow-wrap">
      <CanvasPills>
        <div className="sysres-indicator"><button className="sysres-pill">M</button></div>
        <UsageIndicator />
      </CanvasPills>
    </div>
    <Dock zoomPct={100} />
  </div>
)
const pause = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80))))
async function check() {
  await pause()
  const root = document.querySelector<HTMLElement>('.canvas-root')!
  const dock = document.querySelector<HTMLElement>('.dock')!
  const results = []
  for (const [width, zoom, expanded] of [[1470, 1, false], [1280, 1, true], [900, 1, false], [390, 1, false], [1470, 1.5, false], [1470, 0.8, false], [1470, 1, false]] as const) {
    root.style.width = `${width / zoom}px`
    root.style.height = `${862 / zoom}px`
    root.style.zoom = `${zoom}`
    document.querySelector<HTMLElement>('.sysres-pill')!.style.width = expanded ? '180px' : '26px'
    // Dock growth (e.g. zoom readout / font changes) must also remeasure without window resize.
    dock.style.paddingRight = expanded ? '70px' : ''
    await pause()
    const refresh = document.querySelector<HTMLButtonElement>('.usage-refresh')!
    const r = refresh.getBoundingClientRect()
    const d = dock.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    if (!refresh.contains(hit)) throw Error(`refresh covered at ${width}/${zoom}/${expanded}: ${hit?.className} row=${document.querySelector(".canvas-pills")?.getAttribute("style")} refresh=${JSON.stringify(r)} dock=${JSON.stringify(d)}`)
    if (r.right > width + 1 || r.width < 23 * zoom) throw Error('refresh clipped/shrunk')
    if (!(r.right <= d.left - 7 * zoom || r.bottom <= d.top - 7 * zoom)) throw Error('dock overlap')
    hit!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await pause()
    const pill = document.querySelector<HTMLButtonElement>('.usage-pill')!
    pill.focus()
    await pause()
    if (!document.querySelector('.usage-popover')?.textContent?.includes('Grok')) throw Error('full provider details inaccessible')
    pill.click()
    pill.blur()
    results.push({ width, zoom, expanded, right: r.right, dockLeft: d.left, above: r.bottom < d.top })
  }
  if (refreshes !== results.length) throw Error(`refresh calls: ${refreshes}`)
  document.getElementById('result')!.textContent = `PASS ${JSON.stringify(results)}`
}
check().catch(error => { document.getElementById('result')!.textContent = `FAIL ${error.stack}` })
