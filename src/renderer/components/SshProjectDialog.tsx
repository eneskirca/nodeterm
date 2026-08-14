import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import { useSshServers } from '../state/sshServers'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import type { SshServer } from '@shared/ssh'

interface SshProjectDialogProps {
  /** Create the SSH project (Canvas commits the active canvas, adds + switches to it). */
  onCreate: (input: { server: SshServer; remoteCwd: string; label: string }) => void
  /** Open Settings → SSH so the user can add/manage saved servers. */
  onManage: () => void
  onClose: () => void
}

type Step = 'pick' | 'connecting' | 'browse' | 'error'

/** Shared style for a clickable row (server / remote folder). Hover/focus left to defaults. */
const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  width: '100%',
  textAlign: 'left',
  padding: '8px 11px',
  background: 'var(--panel-header)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--text)',
  fontSize: 13,
  cursor: 'pointer',
  flexShrink: 0
}

/** Basename of an absolute remote path (for the project label). */
function baseName(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const seg = trimmed.split('/').filter(Boolean).pop()
  return seg || trimmed || '~'
}

/** Parent directory of an absolute remote path; stops at '/'. */
function parentDir(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

/**
 * "Connect over SSH…" project creation flow: pick a saved server, open its ControlMaster,
 * browse the remote filesystem, and create an SSH project rooted at the chosen folder.
 *
 * The browse uses a throwaway connection (a temporary project id) so the dialog never needs a
 * project id before one exists; Canvas establishes the project's real master on switch. The
 * temporary master is torn down on create/cancel.
 */
export function SshProjectDialog({ onCreate, onManage, onClose }: SshProjectDialogProps) {
  const servers = useSshServers((s) => s.servers)
  const [serverFilter, setServerFilter] = useState('')
  const [step, setStep] = useState<Step>('pick')
  const [server, setServer] = useState<SshServer | null>(null)
  const [path, setPath] = useState('~')
  const [dirs, setDirs] = useState<string[]>([])
  const [error, setError] = useState('')
  // Inline "new folder" creation in the browse step.
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [mkdirErr, setMkdirErr] = useState('')
  // Stable id for the temporary browse master, generated once.
  const browseIdRef = useRef(`ssh-browse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  const connectBegunRef = useRef(false)
  const visibleServers = useMemo(() => {
    const query = serverFilter.trim().toLowerCase()
    if (!query) return servers
    return servers.filter((saved) =>
      [saved.label, saved.host, saved.user, `${saved.user}@${saved.host}`].some((value) =>
        value.toLowerCase().includes(query)
      )
    )
  }, [servers, serverFilter])

  // Tear down the temporary browse master (best-effort) once it's no longer needed.
  const disconnectBrowse = useCallback(() => {
    if (connectBegunRef.current) {
      connectBegunRef.current = false
      void window.nodeTerminal.sshProject.disconnect(browseIdRef.current)
    }
  }, [])

  const close = useCallback(() => {
    disconnectBrowse()
    onClose()
  }, [disconnectBrowse, onClose])

  // Only the topmost modal answers a key (./dialog-stack).
  const isTop = useDialogStack()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, close])

  // Disconnect the browse master if the dialog unmounts without an explicit close.
  useEffect(() => () => disconnectBrowse(), [disconnectBrowse])

  /** Does `dir` exist on the remote? Asked of its PARENT's listing, because a `listDir` of a
   *  missing directory succeeds and answers `{ path: dir, dirs: [] }`. `~` is taken on faith. */
  const dirExists = useCallback(async (dir: string): Promise<boolean> => {
    if (dir === '~') return true
    try {
      const parent = await window.nodeTerminal.sshProject.listDir(
        browseIdRef.current,
        parentDir(dir)
      )
      return parent.dirs.includes(baseName(dir))
    } catch {
      return false
    }
  }, [])

  const list = useCallback(async (dir: string) => {
    const res = await window.nodeTerminal.sshProject.listDir(browseIdRef.current, dir)
    setPath(res.path)
    setDirs(res.dirs)
  }, [])

  // Create a folder under the current path on the remote, then navigate into it.
  const createFolder = useCallback(async () => {
    const name = newName.trim()
    if (!name) return
    setMkdirErr('')
    const full = `${path.replace(/\/+$/, '')}/${name}`
    const ok = await window.nodeTerminal.sshProject.mkdir(browseIdRef.current, full)
    if (!ok) {
      setMkdirErr('Could not create the folder.')
      return
    }
    setCreating(false)
    setNewName('')
    await list(full)
  }, [newName, path, list])

  const connect = useCallback(
    async (srv: SshServer) => {
      setServer(srv)
      setError('')
      setStep('connecting')
      try {
        // Mark BEFORE the await: from the moment connect() is issued there is a master (or an
        // in-flight attempt) that close/unmount must tear down. Marking only on success meant
        // cancelling during 'connecting' skipped disconnectBrowse entirely, and once the attempt
        // later landed (a slow host, or parked on the passphrase prompt) the browse master
        // outlived the dialog for the rest of the app run.
        connectBegunRef.current = true
        await window.nodeTerminal.sshProject.connect(browseIdRef.current, srv)
        // Land in the machine's DEFAULT folder when it has one (Settings → Remote (SSH)); the
        // point of configuring it is not to browse from `~` to the same place every time.
        //
        // A stale default must not dead-end the dialog, and `listDir` cannot say so on its own:
        // it echoes the path back and returns `dirs: []` whether the folder is missing or merely
        // empty (`ls` failing is not an error it surfaces). So EXISTENCE is checked against the
        // parent's listing before landing there — which also keeps a real, empty default working,
        // unlike treating an empty listing as the failure signal.
        const start = srv.remoteCwd?.trim() || '~'
        await list((await dirExists(start)) ? start : '~')
        setStep('browse')
      } catch (err) {
        setError((err as Error)?.message || 'Could not connect to the server.')
        setStep('error')
      }
    },
    [list]
  )

  const useThisFolder = useCallback(() => {
    if (!server) return
    disconnectBrowse()
    onCreate({ server, remoteCwd: path, label: `${baseName(path)} · ${server.label}` })
    onClose()
  }, [server, path, disconnectBrowse, onCreate, onClose])

  const body = (() => {
    if (step === 'pick') {
      return (
        <div
          style={{
            display: 'flex',
            flex: '1 1 auto',
            flexDirection: 'column',
            minHeight: 0
          }}
        >
          <p className="confirm__msg" style={{ flex: '0 0 auto', overflow: 'visible', fontWeight: 600 }}>
            Connect over SSH
          </p>
          <p className="confirm__msg" style={{ flex: '0 0 auto', overflow: 'visible' }}>
            Pick a saved server to host this project's terminals.
          </p>
          {servers.length > 0 && (
            <Input
              autoFocus
              aria-label="Filter saved SSH servers"
              placeholder="Filter by label, host, or user"
              value={serverFilter}
              onChange={(event) => setServerFilter(event.target.value)}
              className="mb-2"
              style={{ flexShrink: 0 }}
            />
          )}
          <div
            role="group"
            aria-label="Saved SSH servers"
            style={{
              display: 'flex',
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              flexDirection: 'column',
              gap: 6,
              margin: '6px 0 14px'
            }}
          >
            {servers.length === 0 ? (
              <p className="confirm__msg" style={{ flex: '0 0 auto', margin: 0, opacity: 0.7 }}>
                No saved servers yet.
              </p>
            ) : visibleServers.length === 0 ? (
              <p className="confirm__msg" style={{ flex: '0 0 auto', margin: 0, opacity: 0.7 }}>
                No saved servers match “{serverFilter.trim()}”.
              </p>
            ) : (
              visibleServers.map((s) => (
                <button
                  key={s.id}
                  style={ROW_STYLE}
                  title={`${s.user}@${s.host}`}
                  onClick={() => void connect(s)}
                >
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      width: '100%'
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{s.label}</span>
                  </span>
                  <span style={{ opacity: 0.6, fontSize: 12 }}>
                    {s.user}@{s.host}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="confirm__actions" style={{ flexShrink: 0 }}>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                onManage()
                close()
              }}
            >
              Add server…
            </Button>
          </div>
        </div>
      )
    }
    if (step === 'connecting') {
      return (
        <>
          {/* The spinner is the app's shared `.ui-spinner`, the same one the Accounts section
              uses for a mid-setup button, so a connecting SSH project reads like every other
              "working" state rather than a one-off. This step can sit here for a while: if the
              key needs a passphrase the prompt arrives as a separate dialog on top, and a human
              can take a minute to answer, so a static line looked hung. */}
          <p className="confirm__msg" style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ui-spinner" aria-hidden />
            Connecting to {server?.label}…
          </p>
          <p className="confirm__msg" style={{ opacity: 0.7 }}>
            {server ? `Establishing the SSH connection to ${server.user}@${server.host}.` : 'Establishing the SSH connection.'}
          </p>
          <div className="confirm__actions">
            <Button onClick={close}>Cancel</Button>
          </div>
        </>
      )
    }
    if (step === 'error') {
      return (
        <>
          <p className="confirm__msg" style={{ fontWeight: 600 }}>
            Connection failed
          </p>
          <p className="confirm__msg" style={{ opacity: 0.8 }}>
            {error}
          </p>
          <div className="confirm__actions">
            <Button onClick={close}>Close</Button>
            <Button variant="primary" onClick={() => server && void connect(server)}>
              Retry
            </Button>
          </div>
        </>
      )
    }
    // browse
    const atRoot = path === '/'
    return (
      <>
        <p className="confirm__msg" style={{ fontWeight: 600 }}>
          Choose a folder on {server?.label}
        </p>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            margin: '4px 0 8px',
            fontSize: 12,
            color: 'var(--muted)'
          }}
        >
          <Button className="px-2.5 py-0.5" disabled={atRoot} onClick={() => void list(parentDir(path))}>
            ↑ Up
          </Button>
          <Button
            className="px-2.5 py-0.5"
            onClick={() => {
              setMkdirErr('')
              setNewName('')
              setCreating(true)
            }}
          >
            ＋ New folder
          </Button>
          <span
            title={path}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {path}
          </span>
        </div>
        {creating && (
          <div style={{ display: 'flex', gap: 8, margin: '0 0 8px' }}>
            <Input
              autoFocus
              value={newName}
              placeholder="Folder name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFolder()
                else if (e.key === 'Escape') {
                  setCreating(false)
                  setNewName('')
                  setMkdirErr('')
                }
              }}
              className="min-w-0 flex-1"
            />
            <Button variant="primary" className="px-2.5 py-0.5" onClick={() => void createFolder()}>
              Create
            </Button>
            <Button
              className="px-2.5 py-0.5"
              onClick={() => {
                setCreating(false)
                setNewName('')
                setMkdirErr('')
              }}
            >
              Cancel
            </Button>
          </div>
        )}
        {mkdirErr && (
          <p className="confirm__msg" style={{ color: 'var(--danger, #e5534b)', margin: '0 0 8px', fontSize: 12 }}>
            {mkdirErr}
          </p>
        )}
        <div
          style={{
            maxHeight: 240,
            overflowY: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 8,
            margin: '0 0 14px'
          }}
        >
          {dirs.length === 0 ? (
            <p className="confirm__msg" style={{ opacity: 0.6, padding: '10px 12px' }}>
              No sub-folders here.
            </p>
          ) : (
            dirs.map((d) => (
              <button
                key={d}
                style={{ ...ROW_STYLE, border: 'none', borderRadius: 0, background: 'transparent' }}
                onClick={() => void list(`${path.replace(/\/+$/, '')}/${d}`)}
              >
                <span>📁 {d}</span>
              </button>
            ))
          )}
        </div>
        <div className="confirm__actions">
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={useThisFolder}>
            Use this folder
          </Button>
        </div>
      </>
    )
  })()

  return createPortal(
    <div className="confirm-overlay" onClick={close}>
      <div className="confirm" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>,
    document.body
  )
}
