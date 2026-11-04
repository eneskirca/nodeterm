import { createContext, useContext, useMemo, useState } from 'react'
import { AgentIcon } from '../../lib/agentIcons'
import { planSendTargets, sendToLabel, type SendToPayload, type SendToPr, type SendToStatus, type SendToTarget } from '../../lib/sendTo'

/** What the canvas frame (PullNode) gives the picker: the canvas at the click, and the sender. */
export interface SendToHost {
  /** Why sending is off on this surface (a relay tab). */
  unavailable?: string
  pullId: string
  nodes(): Parameters<typeof planSendTargets>[0]['nodes']
  edges(): Parameters<typeof planSendTargets>[0]['edges']
  status: Parameters<typeof planSendTargets>[0]['status']
  /** Links the agent to the pull node when missing, then sends one prompt. Null = sent. */
  send(targetId: string, pr: SendToPr, payload: SendToPayload): Promise<string | null>
}

export interface SendToApi {
  /** Opens the picker for this payload; `onSent` runs once the prompt landed. Undefined = unavailable. */
  sendTo: ((payload: SendToPayload, onSent?: () => void) => void) | undefined
  why: string | undefined
}

const SendToContext = createContext<SendToApi>({ sendTo: undefined, why: undefined })

/** Any button in the pull node: `const { sendTo } = useSendTo(); sendTo?.({ kind: 'check', name })`. */
export function useSendTo(): SendToApi {
  return useContext(SendToContext)
}

type Open = { payload: SendToPayload; onSent?: () => void }

/** Holds the one open picker of a pull node and draws it over the node. */
export function SendToProvider({ host, pr, children }: { host?: SendToHost; pr: SendToPr; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState<Open | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const api = useMemo<SendToApi>(() => !host || host.unavailable
    ? { sendTo: undefined, why: host?.unavailable }
    : { sendTo: (payload, onSent) => { setSent(null); setOpen({ payload, onSent }) }, why: undefined }, [host])
  return (
    <SendToContext.Provider value={api}>
      {children}
      {sent && (
        <p role="status" className="absolute left-1/2 top-12 z-30 m-0 flex -translate-x-1/2 items-center gap-2 rounded-[6px] border border-[#3d444d] bg-[#212830] px-3 py-1.5 text-[12px] text-[#f0f6fc] shadow-lg">
          {sent}
          <button aria-label="Dismiss" className="border-0 bg-transparent p-0 text-[#9198a1] hover:text-[#f0f6fc]" onClick={() => setSent(null)}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </p>
      )}
      {open && host && (
        <SendToPicker host={host} pr={pr} payload={open.payload} onClose={() => setOpen(null)}
          onSent={(title) => { setOpen(null); setSent(`Sent to ${title}.`); open.onSent?.() }} />
      )}
    </SendToContext.Provider>
  )
}

const DOT: Record<SendToStatus, { color: string; text: string }> = {
  idle: { color: 'bg-[#3fb950]', text: 'idle' },
  working: { color: 'bg-[#d29922]', text: 'working' },
  'needs-you': { color: 'bg-[#f85149]', text: 'needs you' },
  off: { color: 'bg-[#656c76]', text: 'not running' },
  unknown: { color: 'bg-[#656c76]', text: 'status unknown' }
}

/** The F4 picker: search, a list of the project's agent nodes, up/down/enter, Escape closes. */
export function SendToPicker({ host, pr, payload, onClose, onSent }: {
  host: SendToHost; pr: SendToPr; payload: SendToPayload; onClose: () => void; onSent: (title: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  // ponytail: the canvas and the statuses are read at render (open, each keystroke), not subscribed.
  const targets = planSendTargets({ pullId: host.pullId, nodes: host.nodes(), edges: host.edges(), status: host.status, query })
  const at = Math.min(active, Math.max(targets.length - 1, 0))
  const send = async (target: SendToTarget | undefined) => {
    if (!target || busy) return
    setBusy(true)
    setRefused(null)
    const why = await host.send(target.id, pr, payload).catch(() => 'The message could not be sent.')
    setBusy(false)
    if (why) setRefused(why)
    else onSent(target.title)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = targets.length
      if (n) setActive((at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void send(targets[at])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }
  const listId = `send-to-${host.pullId}`
  return (
    <>
      <div className="absolute inset-0 z-20" onMouseDown={onClose} />
      <div role="dialog" aria-label={`${sendToLabel(payload)} to`} onKeyDown={onKey}
        className="absolute left-1/2 top-12 z-30 w-[min(340px,calc(100%-24px))] -translate-x-1/2 overflow-hidden rounded-[12px] border border-[#3d444d] bg-[#151b23] text-[13px] text-[#f0f6fc] shadow-[0_16px_40px_rgba(0,0,0,.55)] [font-variant-numeric:tabular-nums]">
        <p className="m-0 px-3 pt-2.5 text-[12px] font-semibold text-[#9198a1]">{sendToLabel(payload)} to…</p>
        <label className="m-2.5 flex h-[30px] items-center gap-1.5 rounded-[6px] border border-[#3d444d] bg-[#010409] px-2 text-[#9198a1] focus-within:outline focus-within:outline-2 focus-within:outline-[#4493f8]">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
          <input autoFocus value={query} placeholder="Filter agents" aria-label="Filter agents" role="combobox"
            aria-controls={listId} aria-expanded aria-activedescendant={targets[at] ? `${listId}-${targets[at].id}` : undefined}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-[#f0f6fc] outline-none" />
        </label>
        {targets.length === 0
          ? <p className="m-0 px-3 pb-3 text-[12px] text-[#9198a1]">{query ? 'No agent matches.' : 'No agent nodes in this project.'}</p>
          : (
            <ul id={listId} role="listbox" aria-label="Agents" className="m-0 max-h-[240px] list-none overflow-y-auto p-0 pb-1.5">
              {targets.map((t, i) => (
                <li key={t.id} id={`${listId}-${t.id}`} role="option" aria-selected={i === at}
                  onMouseEnter={() => setActive(i)} onClick={() => void send(t)}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${i === at ? 'bg-[#212830]' : ''}`}>
                  <span className={`h-2 w-2 flex-none rounded-full ${DOT[t.status].color}`} title={DOT[t.status].text} />
                  <span className="flex-none"><AgentIcon agentId={t.agentId} size={16} /></span>
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="sr-only">{DOT[t.status].text}</span>
                  {t.linked && (
                    <span className="flex flex-none items-center gap-1 text-[12px] text-[#9198a1]">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><path d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 014 4l-1 1M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1" /></svg>
                      linked
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        {busy && <p role="status" className="m-0 border-t border-[#3d444d99] px-3 py-2 text-[12px] text-[#9198a1]">Sending…</p>}
        {refused && <p role="alert" className="m-0 border-t border-[#3d444d99] px-3 py-2 text-[12px] text-[#f85149]">{refused}</p>}
      </div>
    </>
  )
}
