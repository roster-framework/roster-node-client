// Runtime validates the author declaration and resolves the JSON parameters.
export function createAgentTemplates(options?: Record<string, unknown>): Array<{
  id: string; version: string; name: string; description: string;
  parameter_schema: Readonly<Record<string, unknown>>;
  credential_parameters: readonly string[];
  create(context: {id: string; name: string; parameters: Readonly<Record<string, unknown>>}): any;
}>;
export function createAgents(): [];
