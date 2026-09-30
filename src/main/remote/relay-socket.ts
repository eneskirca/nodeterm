// Moved to src/core/relay/relay-socket.ts so the Server Edition can host relay sessions
// (docs/hosted-team-relay.md). This shim keeps every desktop
// import path — and every vi.mock('./relay-socket') in the existing tests — working unchanged.
export * from '../../core/relay/relay-socket'
