// Moved to src/core/relay/e2ee.ts so the Server Edition can host relay sessions
// (docs/hosted-team-relay.md). This shim keeps every desktop
// import path — and every vi.mock('./e2ee') in the existing tests — working unchanged.
export * from '../../core/relay/e2ee'
