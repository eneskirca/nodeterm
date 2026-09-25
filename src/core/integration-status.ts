// Runtime diagnostics include remote hosts without persisting a claim that cleanup succeeded.
const retained = new Set<string>()
export function reportIntegrationRetained(file: string): void { retained.add(file) }
export function integrationRetainedFiles(): string[] { return [...retained] }
