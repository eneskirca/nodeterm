// The image-paste receipt shown on a terminal (see image-paste-confirm.ts). One small piece of
// state + its dwell timer, shared by the canvas node and the kanban card modal so the two surfaces
// of one session speak in one voice.
import { useCallback, useEffect, useRef, useState } from 'react'
import { IMAGE_PASTE_NOTICE_MS } from './image-paste-confirm'

export function usePasteReceipt(): {
  receipt: { text: string; ok: boolean } | null
  report: (r: { text: string; ok: boolean }) => void
} {
  const [receipt, setReceipt] = useState<{ text: string; ok: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const report = useCallback((r: { text: string; ok: boolean }) => {
    if (!alive.current) return
    if (timer.current) clearTimeout(timer.current)
    setReceipt(r)
    timer.current = setTimeout(() => setReceipt(null), r.ok ? IMAGE_PASTE_NOTICE_MS.ok : IMAGE_PASTE_NOTICE_MS.warn)
  }, [])
  return { receipt, report }
}
