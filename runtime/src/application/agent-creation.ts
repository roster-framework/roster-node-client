import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AgentCreationRequest,AgentCreationDeclaration,AgentCreationReceipt,validateAgentCreationCatalogue,validateAgentCreationReceipt,type AgentSpec,type ManagedAgentConfig,type AgentCreationDeclarationSpec,type AgentCreationReceiptSpec} from '@roster/contracts';
import type {Registry,RegistryRepository} from './ports.js';
import type {AgentImplementation} from '../domain/agent.js';
import {snapshotAgentParameters,type AgentParameterValidator,type AgentParameterValues} from '../domain/agent-parameters.js';

export type PreparedCreationSource={declaration:AgentCreationDeclarationSpec;
  validate?(parameters:AgentParameterValues):Promise<void>;
  build(id:string,name:string,parameters:AgentParameterValues):{agent:AgentImplementation;managed?:ManagedAgentConfig};
};
export type CreationSourceProvider=(registry:Registry)=>PreparedCreationSource[];
const StoredInstance=z.object({declaration:AgentCreationDeclaration,agent:AgentCreationReceipt.shape.agent,
  parameters:z.record(z.string(),z.json()),parameters_digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const StoredRequest=z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),receipt:AgentCreationReceipt}).strict();
const CreationState=z.object({version:z.literal(1),instances:z.array(StoredInstance).max(1000),requests:z.array(StoredRequest).max(10000)}).strict();
export type AgentCreationState=z.infer<typeof CreationState>;
export function readAgentCreationState(value:unknown):AgentCreationState {
  if(value===undefined)return {version:1,instances:[],requests:[]};
  const state=CreationState.parse(value);
  if(new Set(state.instances.map(a=>a.agent.id)).size!==state.instances.length || new Set(state.requests.map(r=>r.receipt.request_id)).size!==state.requests.length || new Set(state.requests.map(r=>r.receipt.agent.id)).size!==state.requests.length)
    throw Error('Invalid agent creation registry');
  for(const request of state.requests)if(request.receipt.replayed!==undefined)throw Error('Invalid persisted creation replay');
  for(const instance of state.instances){
    const receipt=state.requests.find(r=>r.receipt.agent.id===instance.agent.id)?.receipt;
    if(!receipt || creationFingerprint(receipt.agent)!==creationFingerprint(instance.agent) ||
      receipt.source.kind!==instance.declaration.kind || receipt.source.id!==instance.declaration.id || receipt.source.revision!==instance.declaration.revision ||
      instance.parameters_digest!==creationFingerprint(instance.parameters))throw Error('Invalid persisted creation binding');
  }
  return state;
}
export function creationFingerprint(value:unknown):string {
  const canonical=(item:any):any=>Array.isArray(item)?item.map(canonical):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(key=>[key,canonical(item[key])])):item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export class AgentCreationConflict extends Error {constructor(){super('Agent creation request conflict');}}
export class AgentCreationUnavailable extends Error {constructor(){super('Agent creation outcome unavailable; preserve original request');}}
export class RuntimeAgentCreation {
  constructor(readonly runtimeId:string,private readonly registry:RegistryRepository,private readonly parameters:AgentParameterValidator,private readonly sources:CreationSourceProvider) {}
  private available(registry:Registry) {
    const sources=this.sources(registry);
    validateAgentCreationCatalogue({protocol:'roster-agent-catalogue/1',runtime_id:this.runtimeId,existing:[],creatable:sources.map(s=>s.declaration)},this.runtimeId);
    sources.forEach(s=>this.parameters.declaration?.(s.declaration.parameter_schema));
    return sources;
  }
  async catalogue(existing:AgentSpec[]) {
    const registry=await this.registry.read();
    readAgentCreationState(registry.agent_creations);
    return validateAgentCreationCatalogue({protocol:'roster-agent-catalogue/1',runtime_id:this.runtimeId,existing,creatable:this.available(registry).map(s=>s.declaration)},this.runtimeId);
  }
  async agents(registry:Registry):Promise<AgentImplementation[]> {
    const sources=this.available(registry);
    return readAgentCreationState(registry.agent_creations).instances.map(instance=>{
      const source=sources.find(s=>s.declaration.kind===instance.declaration.kind&&s.declaration.id===instance.declaration.id&&s.declaration.revision===instance.declaration.revision);
      if(!source || creationFingerprint(source.declaration)!==creationFingerprint(instance.declaration))throw Error('Original agent creation source unavailable');
      const parameters=snapshotAgentParameters(instance.parameters);
      if(creationFingerprint(this.parameters.resolve(instance.declaration.parameter_schema,parameters))!==creationFingerprint(parameters))throw Error('Stored agent parameters require migration');
      const built=source.build(instance.agent.id,instance.agent.name,parameters);
      if(built.managed || creationFingerprint(built.agent.spec)!==creationFingerprint(instance.agent))throw Error('Original agent declaration changed');
      return {...built.agent,parameter_schema:snapshotAgentParameters(instance.declaration.parameter_schema),parameters};
    });
  }
  async create(value:unknown,registeredIds:string[]):Promise<AgentCreationReceiptSpec> {
    const command=AgentCreationRequest.parse(value),digest=creationFingerprint(command);
    const registry=await this.registry.read();
    const replay=readAgentCreationState(registry.agent_creations).requests.find(r=>r.receipt.request_id===command.id);
    if(replay){if(replay.digest!==digest)throw new AgentCreationConflict();return validateAgentCreationReceipt({...replay.receipt,replayed:true},command);}
    const source=this.available(registry).find(s=>s.declaration.kind===command.source.kind&&s.declaration.id===command.source.id&&s.declaration.revision===command.source.revision);
    if(!source)throw Error('Selected agent creation source unavailable');
    const parameters=this.parameters.resolve(source.declaration.parameter_schema,command.parameters);
    for(const key of source.declaration.credential_parameters){const reference=parameters[key];if(reference!==undefined&&reference!==''&&(typeof reference!=='string'||!/^[A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN|_SECRET)$/.test(reference)))throw Error('Credential reference rejected');}
    await source.validate?.(parameters);
    let receipt:AgentCreationReceiptSpec|undefined;
    await this.registry.transact(r=>{
      const state=readAgentCreationState(r.agent_creations),previous=state.requests.find(entry=>entry.receipt.request_id===command.id);
      if(previous){if(previous.digest!==digest)throw new AgentCreationConflict();receipt=validateAgentCreationReceipt({...previous.receipt,replayed:true},command);return;}
      const current=this.available(r).find(s=>creationFingerprint(s.declaration)===creationFingerprint(source.declaration));
      if(!current)throw Error('Selected agent creation source changed');
      if(state.requests.length>=10000 || registeredIds.length+r.managed_agents.length+state.instances.length>=1000)throw Error('Agent creation capacity reached');
      const id='agent-'+randomUUID();
      if(registeredIds.includes(id)||r.managed_agents.some(a=>a.id===id)||state.instances.some(a=>a.agent.id===id))throw new AgentCreationConflict();
      const built=current.build(id,command.name,parameters);
      receipt=validateAgentCreationReceipt({protocol:command.protocol,request_id:command.id,source:command.source,agent:built.agent.spec,accepted_at:new Date().toISOString()},command);
      if(receipt.agent.id!==id)throw Error('Author instance identity rejected');
      if(built.managed){if(built.managed.id!==id||built.managed.name!==command.name)throw Error('Managed instance identity rejected');r.managed_agents.push(built.managed);}
      else state.instances.push({declaration:structuredClone(current.declaration),agent:receipt.agent,parameters:structuredClone(parameters) as any,parameters_digest:creationFingerprint(parameters)});
      state.requests.push({digest,receipt});r.agent_creations=state;
    });
    return receipt!;
  }
}
