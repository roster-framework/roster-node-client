export type ManagedReply = {
  status: string;
  summary: string;
  output: string;
  event: string;
};
export type ModelTool = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
};
export type ModelExecution = {
  config: {
    engine?: string;
    provider: string;
    model: string;
    base_url: string;
    credential_env: string;
    model_parameters?: Record<string, unknown>;
    statuses: string[];
    events: string[];
  };
  prompt: string;
  request: Record<string, unknown>;
  workspace?: string;
  tools: ModelTool[];
};
export interface PythonAgentWorker {
  validate(config: ModelExecution["config"]): Promise<void>;
  execute(
    input: ModelExecution,
    signal: AbortSignal,
    log: (text: string) => void,
    invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    suspendForReply?: (waitId: string, checkpoint: Record<string, unknown>) => never,
    recordModelUsage?: (usage: import("./model-usage.js").ModelUsage) => void,
  ): Promise<ManagedReply>;
}
