// The issues node's cross-referenced PR opens as a pull node: Canvas listens for `PULL_OPEN_EVENT`
// and opens the PR of the project's approved repository, or frames the node it already has.
export const PULL_OPEN_EVENT = 'nodeterm:pull-open'

export interface PullOpenRequest { pullNumber: number }
