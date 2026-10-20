import test from 'node:test';
import assert from 'node:assert/strict';
import {coreMcpConfiguration} from './codex/core-mcp.mjs';
import {runCodex} from './codex/process.mjs';

test('Core execution token is environment-only and excluded from shell tools',()=>{
 const token='test-capability-'.repeat(4);
 const config=coreMcpConfiguration({url:'http://localhost:7330/mcp',token});
 assert.ok(!config.args.join(' ').includes(token));
 assert.equal(config.env.ROSTER_CODEX_EXECUTION_MCP_TOKEN,token);
 assert.ok(config.args.includes('mcp_servers.roster.required=true'));
 assert.ok(config.args.some(v=>v.startsWith('shell_environment_policy.exclude=')));
 assert.ok(!config.args.join(' ').includes('roster_save_resource_subscription'));
 assert.deepEqual(coreMcpConfiguration(undefined),{args:[],env:{}});
 for(const url of ['http://remote.test/mcp','https://user:secret@host/mcp','https://host/mcp?token=secret'])assert.throws(()=>coreMcpConfiguration({url,token}));
});

test('only exposed Core tools bypass duplicate client approval',()=>{
 const capability={url:'http://localhost:7330/mcp',token:'fixture-token-'.repeat(4)};
 for(const agentCalls of [false,true]){
  const config=coreMcpConfiguration(capability,{agentCalls});
  const enabled=JSON.parse(config.args.find(v=>v.startsWith('mcp_servers.roster.enabled_tools=')).split('=')[1]);
  const approved=config.args.filter(v=>v.includes('.approval_mode=')).map(v=>v.match(/^mcp_servers\.roster\.tools\.([a-z_]+)\.approval_mode="approve"$/)?.[1]);
  assert.deepEqual(approved,enabled);
  assert.equal(approved.includes('roster_call_agent'),agentCalls);
  assert.ok(approved.includes('roster_publish_resource'));
  for (const tool of ['roster_create_discussion','roster_read_discussion','roster_append_discussion','roster_list_discussions']) assert.equal(approved.includes(tool),agentCalls);
  assert.ok(!config.args.some(v=>v.includes('default_tools_approval_mode')));
  assert.ok(!config.args.some(v=>v.includes('danger-full-access')));
 }
});

test('capability accidentally echoed by CLI is redacted before session logging',async()=>{
 const token='private-execution-fixture-'.repeat(3),logs=[];
 const script=`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.env.ROSTER_CODEX_EXECUTION_MCP_TOKEN}})));`;
 const result=await runCodex(process.execPath,['-e',script],'',{signal:new AbortController().signal,log:v=>logs.push(v)},10,{ROSTER_CODEX_EXECUTION_MCP_TOKEN:token});
 assert.deepEqual(logs,['[REDACTED]']);assert.equal(result.final,'[REDACTED]');
});
