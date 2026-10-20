import type {AgentImplementation} from './agent.js';
import type {AgentParameterSchema, AgentParameterValues} from './agent-parameters.js';

export type AgentTemplateContext = {
  id:string; name:string; parameters:AgentParameterValues;
  // Resolves only references declared for this instance. Never modifies global env.
  credentials:{get(reference:string):string|undefined};
};
export type AgentTemplate = {
  id:string; version:string; name:string; description:string;
  parameter_schema:AgentParameterSchema; credential_parameters?:readonly string[];
  // Constructor only: no model calls, invocation or external side effects.
  create(context:AgentTemplateContext):AgentImplementation;
};
