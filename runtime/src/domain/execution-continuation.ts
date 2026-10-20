import type {ExecutionContinuationSpec} from '@roster/contracts';

// Runtime-local author context. Never serialize this into input, logs or MCP.
export type AgentContinuation=Readonly<{
 reference:ExecutionContinuationSpec;
 checkpoint:Readonly<Record<string,unknown>>;
}>;
