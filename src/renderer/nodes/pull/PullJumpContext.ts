import { createContext, useContext } from 'react'
import type { PullJump } from './readiness'

/** The shell's jump (switch tab, then scroll to a marked section), for parts deep in a tab such as
 *  the merge box's status rows. Undefined = no shell around (a test): the links are left out. */
export const PullJumpContext = createContext<((jump: PullJump) => void) | undefined>(undefined)

export const usePullJump = (): ((jump: PullJump) => void) | undefined => useContext(PullJumpContext)
