// The issues node's cross-referenced PR opens as a pull node: Canvas listens for `PULL_OPEN_EVENT`
// and opens the PR of the project's approved repository, or frames the node it already has.
export const PULL_OPEN_EVENT = 'nodeterm:pull-open'

export interface PullOpenRequest { pullNumber: number }

// The pull node's Checks tab "Log": Canvas listens for `PULL_WEB_EVENT` and opens the run's page in
// a web node beside that pull node. Only a github.com page opens.
export const PULL_WEB_EVENT = 'nodeterm:pull-web'

export interface PullWebRequest { nodeId: string; url: string }

export const isGitHubPage = (url: unknown): url is string => typeof url === 'string' && url.startsWith('https://github.com/')
