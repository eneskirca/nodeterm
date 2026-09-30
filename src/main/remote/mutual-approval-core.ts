// Moved to src/core/relay/mutual-approval-core.ts so the Server Edition can host relay sessions
// (docs/hosted-team-relay.md). This shim keeps every desktop
// import path — and every vi.mock('./mutual-approval-core') in the existing tests — working unchanged.
export * from '../../core/relay/mutual-approval-core'
