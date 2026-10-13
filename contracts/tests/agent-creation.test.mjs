import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAgentCreationCatalogue, AgentCreationRequest, validateAgentCreationReceipt} from '../dist/index.js';

const source = {kind: 'template', id: 'developer', revision: 'a'.repeat(64)};
const agent = {id:'created', name:'Developer', description:'Build', statuses:['ok'], events:['complete'], skills:[], rules:[], capabilities:[]};
const entry = {...source, name:'Developer template', description:'Build', parameter_schema:{type:'object',additionalProperties:false,properties:{project:{type:'string',minLength:1},depth:{type:'string',default:'standard'},credential_env:{type:'string'}},required:['project']},credential_parameters:['credential_env']};
const catalogue = {protocol:'roster-agent-catalogue/1',runtime_id:'runtime',existing:[agent],creatable:[entry]};
const command = {protocol:'roster-agent-creation/1',id:'request:original',source,name:'Developer',parameters:{project:'roster'}};
test('author catalogue distinguishes instances and creation declarations without parameter values or authority',()=>{
 assert.deepEqual(validateAgentCreationCatalogue(catalogue,'runtime'),catalogue);
 assert.deepEqual(AgentCreationRequest.parse(command),command);
 for(const change of [v=>v.runtime_id='other',v=>v.existing.push(agent),v=>v.creatable.push(entry),v=>v.creatable[0].parameters={private:true},v=>v.creatable[0].parameter_schema.additionalProperties=true,v=>v.creatable[0].parameter_schema.required=['undeclared'],v=>v.creatable[0].credential_parameters=['undeclared'],v=>v.creatable[0].source_url='private',v=>v.team='organization']){const v=structuredClone(catalogue);change(v);assert.throws(()=>validateAgentCreationCatalogue(v,'runtime'));}
 for(const change of [{protocol:'roster/0.1'},{source:{...source,kind:'existing'}},{id:''},{team:'organization'},{credentials:{SECRET_API_KEY:'private'}},{parameters:[]}])assert.throws(()=>AgentCreationRequest.parse({...command,...change}));
});
test('creation receipt remains bound to original request/source and contains declaration only',()=>{
 const receipt={protocol:'roster-agent-creation/1',request_id:command.id,source,agent,accepted_at:'2026-10-08T00:00:00.123456789Z'};
 assert.deepEqual(validateAgentCreationReceipt(receipt,command),receipt);
 assert.equal(validateAgentCreationReceipt({...receipt,replayed:true},command).replayed,true);
 for(const change of [{request_id:'other'},{source:{...source,revision:'b'.repeat(64)}},{accepted_at:'now'},{parameters:{private:true}},{api_key:'private'},{replayed:'yes'}])assert.throws(()=>validateAgentCreationReceipt({...receipt,...change},command));
 const duplicate={...receipt,agent:{...agent,events:['complete','complete']}};assert.throws(()=>validateAgentCreationReceipt(duplicate,command));
});
