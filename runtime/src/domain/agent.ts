import type { AgentSpec, RunInput, RunResult, McpConfig } from "@roster/contracts";
import type { SessionNote } from "./session.js";
import type { ResourceAccessSpec, ResourceOperation } from "./resource.js";
import type { AgentParameterSchema, AgentParameterValues } from './agent-parameters.js';
export type AgentContext = {
  continuation?: import('./execution-continuation.js').AgentContinuation;
  // Register the wait in Core first. This ends the current invocation;
  // checkpoint data stays private to Runtime and never grants resume authority.
  suspendForReply?: (waitId: string, checkpoint: Record<string, unknown>) => never;
  suspendForCompletion?: (waitId: string, checkpoint: Record<string, unknown>) => never;
  // Runtime-owned creation values; never merged into Core invocation context/input.
  parameters?: AgentParameterValues;
	resources?: ResourceAccessSpec[];
	invokeResource?: (operation: ResourceOperation) => Promise<unknown>;
	coreMcp?: { url: string; token: string };
  // Runtime host-owner trust, rechecked before managed Core discovery/calls.
  authorizeCoreConnection?: () => Promise<void>;
  refuseCoreAccess?: (reason: import("./tool-access-refusal.js").ToolAccessRefusalReason) => never;
  bindMcpConnection?: (configuration:McpConfig) => Promise<import('./mcp-identity.js').McpClientBinding>;
  authorizeMcpTool?: (connectionId: string, toolName: string, revision?:string) => Promise<void>;
  // Discovery filtering is separate from the current authorization at invocation.
  visibleMcpTools?: (connectionId: string, toolNames: string[], revision?:string) => Promise<string[]>;
  // Sticky for one execution: a model response cannot turn a denied tool call
  // into a successful work result after the agent loop receives the error.
  toolAccessFailure?: Error;
  approveTool?: (tool: string, args: Record<string, unknown>) => Promise<void>;
  workspace: string;
  signal: AbortSignal;
  log: (text: string) => void;
  // Publish explicit work records. Do not include hidden model reasoning.
  recordSession?: (entry: SessionNote) => void;
  // Producer-reported usage, with Runtime-assigned time and original invocation ID.
  recordModelUsage?: (usage: import("./model-usage.js").ModelUsage) => void;
};
export type AgentImplementation = {
  parameter_schema?: AgentParameterSchema;
  parameters?: AgentParameterValues;
  spec: AgentSpec;
  execute: (input: RunInput, context: AgentContext) => Promise<RunResult>;
};
export type AgentModule = {
  createAgentTemplates?: (options: Record<string, unknown>) => import('./agent-template.js').AgentTemplate[] | Promise<import('./agent-template.js').AgentTemplate[]>;
  createAgents: (
    options: Record<string, unknown>,
  ) => Promise<AgentImplementation[]> | AgentImplementation[];
};
