import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {McpConnection, McpCatalogue, McpDescriptor, McpConnectionChange, McpChangeReceipt,
  type McpConfig, type McpConnectionChangeSpec, type McpChangeReceiptSpec} from '@roster/contracts';
import type {McpIdentityFingerprint,McpClientBinding} from '../domain/mcp-identity.js';
import type {Registry, RegistryRepository, McpInspector} from './ports.js';

const fingerprint=z.string().regex(/^[a-f0-9]{64}$/);
const binding=z.object({descriptor:McpDescriptor, fingerprint:fingerprint.optional()}).strict();
const stateSchema=z.object({version:z.literal(1),runtime_id:z.string().min(1),
  connections:z.array(binding).max(1024),
  commands:z.array(z.object({fingerprint,receipt:McpChangeReceipt}).strict()).max(10000),
}).strict().superRefine((state,ctx)=>{
  if(new Set(state.connections.map(c=>c.descriptor.connection_id)).size!==state.connections.length||
     new Set(state.commands.map(c=>c.receipt.request_id)).size!==state.commands.length||
     state.connections.some(c=>(c.descriptor.state==='active')!==!!c.fingerprint)||
     state.commands.some(c=>c.receipt.replayed))ctx.addIssue({code:'custom',message:'Invalid MCP identity ledger'});
});
export type McpIdentityState=z.infer<typeof stateSchema>;
export class McpChangeConflict extends Error {constructor(){super('MCP connection revision or request identity conflict');}}
export class McpIdentityUnavailable extends Error {constructor(){super('MCP identity storage unavailable');}}
export class McpClientBindingDenied extends Error {constructor(){super('MCP client binding unavailable');}}
export function readMcpIdentity(value:unknown):McpIdentityState {
  const result=stateSchema.safeParse(value);
  if(!result.success)throw new McpIdentityUnavailable();
  return result.data;
}

export class McpConnections {
  constructor(private runtimeId:string,private repository:RegistryRepository,
    private inspector:McpInspector,private fingerprints:McpIdentityFingerprint){}

  private reconcile(registry:Registry):McpIdentityState {
    const state:McpIdentityState=registry.mcp_identity===undefined?{version:1,runtime_id:this.runtimeId,connections:[],commands:[]}:readMcpIdentity(registry.mcp_identity);
    if(state.runtime_id!==this.runtimeId)throw new McpIdentityUnavailable();
    const ids=new Set<string>();
    for(const connection of registry.mcp_connections){
      if(ids.has(connection.config.id))throw new McpIdentityUnavailable();
      ids.add(connection.config.id);
      const hash=this.fingerprints.configuration(connection.config);
      const previous=state.connections.find(c=>c.descriptor.connection_id===connection.config.id);
      const tools=[...connection.tools];
      if(!previous||previous.descriptor.state!=='active'||previous.fingerprint!==hash||JSON.stringify(previous.descriptor.tools)!==JSON.stringify(tools)){
        const next={descriptor:McpDescriptor.parse({connection_id:connection.config.id,revision:randomUUID(),state:'active',tools}),fingerprint:hash};
        if(previous)Object.assign(previous,next);else state.connections.push(next);
      }
    }
    for(const connection of state.connections)if(connection.descriptor.state==='active'&&!ids.has(connection.descriptor.connection_id)){
      connection.descriptor={connection_id:connection.descriptor.connection_id,revision:randomUUID(),state:'removed',tools:[]};
      delete connection.fingerprint;
    }
    registry.mcp_identity=readMcpIdentity(state);
    return registry.mcp_identity;
  }
  async catalogue(){
    let result!:z.infer<typeof McpCatalogue>;
    await this.repository.transact(registry=>{
      const state=this.reconcile(registry);
      result=McpCatalogue.parse({protocol:'roster-mcp-catalogue/1',runtime_id:this.runtimeId,connections:state.connections.map(c=>c.descriptor)});
    });
    return result;
  }
  async initialize(){await this.catalogue();}

  // The exact implementation configuration and resolved credential must belong
  // to the same current opaque revision. Old implementations cannot borrow a
  // replacement connection's identity merely by reusing its ID.
  async bindClient(input:McpConfig):Promise<McpClientBinding>{
    const configuration=McpConnection.parse(input);
    let result!:McpClientBinding;
    await this.repository.transact(registry=>{
      const state=this.reconcile(registry);
      const current=state.connections.find(c=>c.descriptor.connection_id===configuration.id);
      const resolved=this.fingerprints.client(configuration);
      if(!current||current.descriptor.state!=='active'||current.fingerprint!==resolved.fingerprint||configuration.token_env&&!resolved.credential)throw new McpClientBindingDenied();
      result={configuration,revision:current.descriptor.revision,credential:resolved.credential};
    });
    return result;
  }

  async assertClient(connectionId:string,revision:string,toolName:string){
    if(!(await this.selectClient(connectionId,revision,[toolName])).includes(toolName))throw new McpClientBindingDenied();
  }
  async selectClient(connectionId:string,revision:string,toolNames:string[]){
    const descriptor=(await this.catalogue()).connections.find(c=>c.connection_id===connectionId);
    if(!descriptor||descriptor.state!=='active'||descriptor.revision!==revision)throw new McpClientBindingDenied();
    return toolNames.filter(name=>descriptor.tools.includes(name));
  }

  private check(state:McpIdentityState,command:McpConnectionChangeSpec,hash:string):McpChangeReceiptSpec|undefined {
    const saved=state.commands.find(c=>c.receipt.request_id===command.request_id);
    if(saved){if(saved.fingerprint!==hash)throw new McpChangeConflict();return {...saved.receipt,replayed:true};}
    const current=state.connections.find(c=>c.descriptor.connection_id===command.connection_id)?.descriptor;
    if((current?.revision??null)!==command.expected_revision||command.action==='remove'&&current?.state!=='active')throw new McpChangeConflict();
    if(state.commands.length>=10000||!current&&state.connections.length>=1024)throw new McpIdentityUnavailable();
  }
  async change(input:unknown):Promise<McpChangeReceiptSpec>{
    const command=McpConnectionChange.parse(input),hash=this.fingerprints.command(command);
    // Reconcile and persist credential rotations before evaluating a caller's revision.
    await this.catalogue();
    const initial=readMcpIdentity((await this.repository.read()).mcp_identity);
    const replay=this.check(initial,command,hash);if(replay)return replay;
    const configHash=command.action==='upsert'?this.fingerprints.configuration(command.configuration):undefined;
    const tools=command.action==='upsert'?await this.inspector.inspect(command.configuration):[];
    let receipt!:McpChangeReceiptSpec;
    await this.repository.transact(registry=>{
      const state=this.reconcile(registry);
      const replay=this.check(state,command,hash);if(replay){receipt=replay;return;}
      if(command.action==='upsert'&&configHash!==this.fingerprints.configuration(command.configuration))throw new McpChangeConflict();
      if(command.action==='remove'&&registry.managed_agents.some(a=>a.mcp_ids.includes(command.connection_id)))throw new McpChangeConflict();
      const descriptor=McpDescriptor.parse({connection_id:command.connection_id,revision:randomUUID(),state:command.action==='upsert'?'active':'removed',tools});
      registry.mcp_connections=registry.mcp_connections.filter(c=>c.config.id!==command.connection_id);
      if(command.action==='upsert')registry.mcp_connections.push({config:command.configuration,tools,checked:new Date().toISOString()});
      state.connections=state.connections.filter(c=>c.descriptor.connection_id!==command.connection_id);
      state.connections.push({descriptor,...(configHash?{fingerprint:configHash}:{})});
      receipt=McpChangeReceipt.parse({protocol:'roster-mcp-change-receipt/1',request_id:command.request_id,connection_id:command.connection_id,action:command.action,revision:descriptor.revision,state:descriptor.state});
      state.commands.push({fingerprint:hash,receipt});
      registry.mcp_identity=readMcpIdentity(state);
    });
    return receipt;
  }
  async legacyUpsert(configuration:McpConfig){
    const current=(await this.catalogue()).connections.find(c=>c.connection_id===configuration.id);
    await this.change({protocol:'roster-mcp-change/1',request_id:randomUUID(),connection_id:configuration.id,expected_revision:current?.revision??null,action:'upsert',configuration});
    return (await this.catalogue()).connections.find(c=>c.connection_id===configuration.id)!.tools;
  }
  async legacyRemove(id:string){
    const current=(await this.catalogue()).connections.find(c=>c.connection_id===id);
    if(!current||current.state==='removed')return;
    await this.change({protocol:'roster-mcp-change/1',request_id:randomUUID(),connection_id:id,expected_revision:current.revision,action:'remove'});
  }
}
