import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ManagedAgent,PROTOCOL} from '@roster/contracts';
import {RosterRuntime} from '../src/application/runtime.js';
import {McpConnections} from '../src/application/mcp-connections.js';
import {FileRuntimeStorage} from '../src/infrastructure/filesystem.js';
import {FileMcpIdentityFingerprint} from '../src/infrastructure/mcp-identity-fingerprint.js';
import {managedImplementation} from '../src/infrastructure/langchain-managed.js';
import {SqliteSessionJournal} from '../src/infrastructure/sqlite-session-journal.js';
import {JsonSchemaAgentParameters} from '../src/infrastructure/agent-parameters.js';

async function json(req:IncomingMessage){const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const raw=Buffer.concat(parts);return raw.length?JSON.parse(raw.toString()):undefined;}
async function mcpResponse(req:IncomingMessage,res:ServerResponse,external:boolean,onCall:()=>void){
  const server=new McpServer({name:external?'external':'core',version:'1'});
  if(external)for(const name of ['read','password','local_secret'])server.registerTool(name,{description:name==='read'?'Read allowed code':'private-'+name+'-description',inputSchema:{}},async()=>{onCall();return {content:[{type:'text',text:'Allowed code result'}]};});
  else server.registerTool('core_ping',{description:'Core connection check',inputSchema:{}},async()=>({content:[{type:'text',text:'ok'}]}));
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});await server.connect(transport);
  res.on('close',()=>{void transport.close();void server.close();});
  await transport.handleRequest(req,res,await json(req));
}

test('actual Runtime binds MCP credentials, filters model discovery by Core and owner, and rechecks calls and returned results',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'roster-mcp-scoped-client-'));
  const modelRequests:any[]=[],selections:any[]=[],authorizations:any[]=[];
  let toolCalls=0,rotateOnCall=false;
  const environment={MCP_CLIENT_FIXTURE_TOKEN:'private-connection-credential'};
  const expected={status:'success',summary:'Done',output:'Done',event:'complete'};
  const model=createServer(async(req,res)=>{
    const body=await json(req);modelRequests.push(body);
    const structured=(body.tools??[]).map((v:any)=>v.function).find((v:any)=>v.parameters?.properties?.status);
    const calls=structured?[{id:'final',type:'function',function:{name:structured.name,arguments:JSON.stringify(expected)}}]:
      (body.messages.some((m:any)=>m.role==='tool')?undefined:[{id:'read-call',type:'function',function:{name:body.tools.find((v:any)=>v.function.name==='private__read').function.name,arguments:'{}'}}]);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:body.model,
      choices:[{index:0,message:{role:'assistant',content:calls?null:JSON.stringify(expected),...(calls?{tool_calls:calls}:{})},finish_reason:calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}}));
  });
  const external=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer private-connection-credential');
    await mcpResponse(req,res,true,()=>{toolCalls++;if(rotateOnCall)environment.MCP_CLIENT_FIXTURE_TOKEN='rotated-private-credential';});
  });
  const core=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer execution-credential');
    if(req.url==='/api/core/mcp-tool-selection'){
      const query=await json(req);selections.push(query);
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...query,tools:query.tools.filter((name:string)=>name==='read')}));return;
    }
    if(req.url==='/api/core/mcp-authorizations'){
      const use=await json(req);authorizations.push(use);
      res.writeHead(use.tool_name==='read'?200:403,{'Content-Type':'application/json'});res.end('{}');return;
    }
    await mcpResponse(req,res,false,()=>{});
  });
  for(const server of [model,external,core]){server.listen(0,'127.0.0.1');await once(server,'listening');}
  const url=(server:typeof core)=>`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const storage=new FileRuntimeStorage(directory,'runtime');
  const configuration={id:'private',name:'Private',url:url(external)+'/mcp',token_env:'MCP_CLIENT_FIXTURE_TOKEN'};
  const connections=new McpConnections('runtime',storage,{inspect:async()=>['read','password','local_secret']},new FileMcpIdentityFingerprint(directory,environment));
  const initial=await connections.change({protocol:'roster-mcp-change/1',request_id:'create',connection_id:'private',expected_revision:null,action:'upsert',configuration});
  const config=ManagedAgent.parse({id:'reviewer',name:'Reviewer',kind:'llm',model:'fixture',credential_env:'',base_url:url(model)+'/v1',instructions:'Review',mcp_ids:['private'],events:['complete'],model_parameters:{maxRetries:0}});
  const agent=managedImplementation(config,[configuration]);
  const journal=new SqliteSessionJournal(join(directory,'journal.db'),'runtime');
  const runtime=new RosterRuntime('runtime',[agent],storage,storage,storage,{execute:(a,i,c)=>a.execute(i,c)},{create:()=>{throw Error('unused');}},{inspect:async()=>[]},undefined,undefined,journal,undefined,new JsonSchemaAgentParameters(),undefined,
    {current:async()=>({version:1,revision:'owner',grants:['read','password'].map(operation=>({agentId:'reviewer',kind:'mcp',target:'private',operation}))})},undefined,undefined,connections);
  t.after(async()=>{await runtime.close();for(const server of [model,external,core]){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await rm(directory,{recursive:true,force:true});});
  await runtime.initialize();
  const run=(id:string)=>runtime.run({protocol:PROTOCOL,execution_id:id,work_id:'original-work',agent_id:'reviewer',input:{},context:{request:'Review',culture:'',history:[],knowledge:[]}},()=>{},()=>{},{url:url(core)+'/mcp',token:'execution-credential'},true,'core');
  await run('allowed');
  assert.equal((await storage.get('allowed'))?.state,'completed',(await storage.get('allowed'))?.observation);assert.equal(toolCalls,1);assert.equal(modelRequests.length,3);
  assert.deepEqual(selections[0].tools,['read','password']);assert.equal(selections[0].revision,initial.revision);
  assert.equal(authorizations.length,2);assert.ok(authorizations.every(use=>use.revision===initial.revision&&use.tool_name==='read'));
  for(const privateValue of ['password','local_secret','private-connection-credential','execution-credential'])assert.ok(!JSON.stringify(modelRequests).includes(privateValue));
  modelRequests.length=0;rotateOnCall=true;
  await run('rotated-during-call');
  assert.equal((await storage.get('rotated-during-call'))?.state,'attention');
  assert.equal((await storage.get('rotated-during-call'))?.observation,'execution_scope_denied');
  assert.equal(modelRequests.length,1,'revoked result must not return to the model');
  const entries=journal.page('rotated-during-call','core',0,100).entries;
  assert.ok(entries.some(e=>e.entry.kind==='decision'&&e.entry.text.includes('execution_scope_denied')));
  assert.ok(!JSON.stringify(entries).includes('rotated-private-credential'));
});
