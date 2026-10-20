import type {
  RunInput,
  RunResult,
  RuntimeAdmin,
  RuntimeManifest,
  ManagedAgentConfig,
  McpConfig,
} from "@roster/contracts";
import type { AgentContext, AgentImplementation } from "../domain/agent.js";
export type Receipt = {
  id: string;
  state: "running" | "completed" | "attention" | "suspended";
  suspension?: import('../domain/execution-suspension.js').SuspensionReceipt;
  result?: RunResult;
  observation?: string;
};
export type Registry = {
  mcp_identity?: import('./mcp-connections.js').McpIdentityState;
  agent_creations?: import('./agent-creation.js').AgentCreationState;
  agent_presets?: import("./agent-presets.js").AgentPresetConfig[];
  name: string;
  managed_agents: RuntimeAdmin["managed_agents"];
  mcp_connections: RuntimeAdmin["mcp_connections"];
};
export interface RegistryRepository {
  read(): Promise<Registry>;
  transact(action: (registry: Registry) => void): Promise<void>;
  publish(manifest: RuntimeManifest): Promise<void>;
}
export interface ExecutionRepository {
  readSuspensionCheckpoint?(id:string):Promise<import('../domain/execution-suspension.js').SuspensionCheckpoint>;
  saveSuspension?(receipt: Receipt, checkpoint: import('../domain/execution-suspension.js').SuspensionCheckpoint, journal?: import('../domain/suspension-journal.js').SuspensionJournalCommit): Promise<void>;
  suspensionJournals?(): AsyncIterable<import('../domain/suspension-journal.js').SuspensionJournalCommit>;
  reserve(id: string): Promise<boolean>;
  get(id: string): Promise<Receipt | undefined>;
  save(receipt: Receipt): Promise<void>;
  recover(): Promise<void>;
}
export interface WorkspaceProvider {
  create(agentId: string, executionId: string): Promise<string>;
}
export interface AgentEngine {
  execute(
    agent: AgentImplementation,
    input: RunInput,
    context: AgentContext,
  ): Promise<RunResult>;
}
export interface ManagedAgentFactory {
  validate?(config: ManagedAgentConfig): Promise<void>;
  create(
    config: ManagedAgentConfig,
    connections: McpConfig[],
  ): AgentImplementation;
}
export interface McpInspector {
  inspect(config: McpConfig): Promise<string[]>;
}

// Acquire before constructing mutable stores, loading user agents or recovery.
// Release only after admissions/executions and their journals are drained.
export interface RuntimeOwnership {
  acquire(): void;
  release(): void;
}
