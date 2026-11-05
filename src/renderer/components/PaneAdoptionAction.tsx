import { useEffect, useRef, useState } from 'react'
import type { PaneAdoptionReply, PaneAdoptionRequest } from '@shared/agents/pane-adoption'

/** This button requests main's native confirmation. It cannot send approval or process evidence. */
export function PaneAdoptionAction({ api, nodeId, projectId, onAdopted }: { api: object; nodeId: string; projectId?: string; onAdopted(): void }) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string>()
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const epoch = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { epoch.current += 1; setMessage(undefined); setPending(false) }, [api, nodeId, projectId])
  let adopt: ((request: PaneAdoptionRequest) => Promise<PaneAdoptionReply>) | undefined
  if ('paneOwnership' in api && api.paneOwnership && typeof api.paneOwnership === 'object' && 'adopt' in api.paneOwnership && typeof api.paneOwnership.adopt === 'function') adopt = api.paneOwnership.adopt.bind(api.paneOwnership) as typeof adopt
  if (!adopt || !projectId) return null
  return <div className="agent-mailbox__legacy-entry">
    <p className="agent-mailbox__hint">Ownership recovery requires native human confirmation of one supported verified session. Unobserved SSH and unknown identities remain unavailable; historical held mail is unchanged.</p>
    <button type="button" disabled={pending} onClick={async () => {
      if (inFlight.current) return
      inFlight.current = true
      const requestedEpoch = epoch.current
      setPending(true)
      setMessage(undefined)
      try {
        const result = await adopt!({ nodeId, projectId })
        if (!mounted.current || epoch.current !== requestedEpoch) return
        if (!result.ok) setMessage(result.error)
        else {
          if (result.result.nodeId !== nodeId || result.result.projectId !== projectId || result.result.provenance !== 'local-human-adoption') {
            setMessage('The returned ownership identity could not be confirmed.')
            return
          }
          setMessage(result.result.status === 'adopted' ? 'Session authorized by explicit local human confirmation.' : 'This session already has a local human approval.')
          onAdopted()
        }
      } catch { if (mounted.current && epoch.current === requestedEpoch) setMessage('The local ownership request could not be confirmed.') }
      finally { inFlight.current = false; if (mounted.current && epoch.current === requestedEpoch) setPending(false) }
    }}>{pending ? 'Awaiting native confirmation…' : 'Authorize this running session…'}</button>
    {message && <p role="status" className="agent-mailbox__hint">{message}</p>}
  </div>
}
