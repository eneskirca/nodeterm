/** An additive, versioned receipt for a terminal actually created by its owning host.
 * It grants attach-only viewing, never permission to restore privileged pane ownership. */
export interface ManagedPaneReceipt {
  version: 1
  creationId: string
  nodeId: string
  projectId: string
  socket: 'node-terminal'
  session: string
  paneId: string
  panePid: number
  paneBirth: string
  sessionCreated: string
}

export interface ManagedTerminalReceipt extends ManagedPaneReceipt {
  hostInstance: string
}

export const MANAGED_CREATION_ENV = 'NODETERM_MANAGED_CREATION_ID'
export const MANAGED_CREATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
