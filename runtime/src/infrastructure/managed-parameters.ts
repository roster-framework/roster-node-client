import { ManagedAgent, type ManagedAgentConfig } from '@roster/contracts';
import { z } from 'zod';

// This declaration is part of the built-in agent implementation, not an HTTP/UI form.
const declaration = ManagedAgent.pick({engine:true,provider:true,model:true,base_url:true,
  credential_env:true,model_parameters:true,instructions:true,skills:true,rules:true,tool_approval:true})
  .extend({engine: ManagedAgent.shape.engine.unwrap().default('langgraph-node')});

export const managedParameterSchema = z.toJSONSchema(declaration, {target:'draft-7'});
export function managedParameters(config: ManagedAgentConfig) {
  return declaration.parse(Object.fromEntries(Object.keys(declaration.shape)
    .filter(key => key in config).map(key => [key,config[key as keyof ManagedAgentConfig]])));
}
