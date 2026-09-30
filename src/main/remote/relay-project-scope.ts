// Moved to src/core/relay/relay-project-scope.ts so the Server Edition can host relay sessions
// (docs/hosted-team-relay.md). This shim keeps every desktop
// import path — and every vi.mock('./relay-project-scope') in the existing tests — working unchanged.
export * from '../../core/relay/relay-project-scope'
