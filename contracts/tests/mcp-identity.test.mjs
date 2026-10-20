import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {McpCatalogue,McpDescriptor,McpConnectionChange,McpChangeReceipt,McpToolUse,McpToolSelection} from '../dist/index.js';

test('MCP call and selection require concrete revision, bounded unique tool names and no private configuration',()=>{
 const use={runtime_id:'runtime',connection_id:'files',revision:randomUUID(),tool_name:'read'};
 assert.deepEqual(McpToolUse.parse(use),use);
 for(const v of [{...use,revision:undefined},{...use,revision:'old'},{...use,token:'private'},{...use,tool_name:'*'}])assert.equal(McpToolUse.safeParse(v).success,false);
 const q={protocol:'roster-mcp-tool-selection/1',runtime_id:use.runtime_id,connection_id:use.connection_id,revision:use.revision,tools:['read','write']};
 assert.deepEqual(McpToolSelection.parse(q),q);
 for(const v of [{...q,tools:['read','read']},{...q,tools:Array.from({length:257},(_,i)=>'t'+i)},{...q,tools:['private tool']},{...q,url:'https://private'}])assert.equal(McpToolSelection.safeParse(v).success,false);
});
test('MCP descriptors are revision-bound metadata without connection secrets',()=>{
 const d={connection_id:'files',revision:randomUUID(),state:'active',tools:['read','write']};
 assert.deepEqual(McpDescriptor.parse(d),d);
 for(const v of [{...d,url:'https://private'},{...d,token:'private'},{...d,revision:'1'},{...d,tools:['read','read']},{...d,state:'removed'},{...d,tools:['*']}])assert.equal(McpDescriptor.safeParse(v).success,false);
 assert.equal(McpCatalogue.safeParse({protocol:'roster-mcp-catalogue/1',runtime_id:'runtime',connections:[d,d]}).success,false);
});
test('MCP change and receipt contracts require exact IDs, CAS and action state',()=>{
 const c={protocol:'roster-mcp-change/1',request_id:'change',connection_id:'files',expected_revision:null,action:'upsert',configuration:{id:'files',name:'Files',url:'https://files.example'}};
 assert.deepEqual(McpConnectionChange.parse(c),c);
 for(const v of [{...c,expected_revision:undefined},{...c,scope:'all'},{...c,configuration:{...c.configuration,id:'other'}},{...c,action:'remove'}])assert.equal(McpConnectionChange.safeParse(v).success,false);
 assert.ok(McpConnectionChange.safeParse({protocol:c.protocol,request_id:c.request_id,connection_id:c.connection_id,expected_revision:randomUUID(),action:'remove'}).success);
 assert.equal(McpChangeReceipt.safeParse({protocol:'roster-mcp-change-receipt/1',request_id:'change',connection_id:'files',action:'remove',revision:randomUUID(),state:'active'}).success,false);
});
