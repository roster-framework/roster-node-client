import {AgentCreationDeclaration,ManagedAgent,type ManagedAgentConfig} from '@roster/contracts';
import {creationFingerprint,type CreationSourceProvider} from '../application/agent-creation.js';
import type {ManagedAgentFactory} from '../application/ports.js';
import {managedParameterSchema,managedParameters} from './managed-parameters.js';
import {validateManagedAgentSkills} from './managed-skills.js';

// Built-in author declarations and saved author presets; Runtime does not guess inputs.
export function managedCreationSources(factory:ManagedAgentFactory):CreationSourceProvider {
 return registry=>[
  {kind:'template' as const,id:'model-agent',name:'Model agent',agent:ManagedAgent.parse({id:'template',name:'Model agent',kind:'llm'})},
  {kind:'template' as const,id:'echo-agent',name:'Echo agent',agent:ManagedAgent.parse({id:'template',name:'Echo agent',kind:'echo',credential_env:''})},
  ...(registry.agent_presets??[]).map(p=>({kind:'preset' as const,...p})),
 ].map(template=>{
  const schema=structuredClone(managedParameterSchema) as Record<string,any>;
  for(const [key,value] of Object.entries(managedParameters(template.agent)))schema.properties[key].default=structuredClone(value);
  if(template.agent.kind==='llm'){
    schema.properties.model.minLength=1;
    if(!template.agent.model)delete schema.properties.model.default;
    schema.required=[...new Set([...(schema.required??[]),'model'])];
  }
  const descriptor={kind:template.kind,id:template.id,name:template.name,description:template.agent.description,parameter_schema:schema,credential_parameters:['credential_env']};
  const declaration=AgentCreationDeclaration.parse({...descriptor,revision:creationFingerprint({implementation:'managed-agent/1',agent:template.agent,...descriptor})});
  const config=(id:string,name:string,parameters:Readonly<Record<string,unknown>>):ManagedAgentConfig=>ManagedAgent.parse({...structuredClone(template.agent),...parameters,id,name,version:1});
  return {declaration,validate:async parameters=>{
    const agent=config('validation',template.name,parameters);
    await validateManagedAgentSkills(agent,template.agent);
    await factory.validate?.(agent);
  },build:(id:string,name:string,parameters:Readonly<Record<string,unknown>>)=>{
    const agent=config(id,name,parameters);
    if(agent.mcp_ids.some(key=>!registry.mcp_connections.some(c=>c.config.id===key)))throw Error('Preset MCP connection unavailable');
    if(agent.tool_approval?.mode==='selected'){
      const tools=new Set(registry.mcp_connections.filter(c=>agent.mcp_ids.includes(c.config.id)).flatMap(c=>c.tools.map(tool=>c.config.id+'/'+tool)));
      if(agent.tool_approval.tools.some(key=>!tools.has(key)))throw Error('Preset approval tool unavailable');
    }
    return {agent:factory.create(agent,registry.mcp_connections.map(c=>c.config)),managed:agent};
  }};
 });
}
