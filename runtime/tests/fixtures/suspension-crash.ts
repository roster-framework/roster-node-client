import {join} from 'node:path';
import {PROTOCOL,Result} from '@roster/contracts';
import {RosterRuntime} from '../../src/application/runtime.js';
import {FileRuntimeStorage} from '../../src/infrastructure/filesystem.js';
import {SqliteSessionJournal} from '../../src/infrastructure/sqlite-session-journal.js';
import {executeAgent} from '../../src/infrastructure/langgraph-engine.js';

const [directory,mode]=process.argv.slice(2);
if(!directory || !mode)throw Error('Fixture arguments required');
const storage=new FileRuntimeStorage(directory,'fixture');
const journal=new SqliteSessionJournal(join(directory,'sessions.db'),'runtime');
const runtime=new RosterRuntime('runtime',[{spec:{id:'agent',name:'Agent',description:'test',statuses:['ok'],events:['complete'],skills:[],rules:[],capabilities:[]},async execute(_,ctx){ctx.log('Before the registered wait');ctx.suspendForReply!('wait',{draft:'private-crash-checkpoint'});return Result.parse({status:'ok'});}}],storage,storage,storage,{execute:executeAgent},{create:()=>{throw Error('unused');}},{inspect:async()=>[]},undefined,undefined,journal);
await runtime.initialize();
if(mode==='before-file')storage.saveSuspension=async()=>{process.exit(73);};
else {
 const commit=journal.commitSuspension.bind(journal);
 journal.commitSuspension=value=>{if(mode==='after-journal')commit(value);process.exit(73);};
}
await runtime.run({protocol:PROTOCOL,execution_id:'run',work_id:'work',agent_id:'agent',input:{},context:{request:'Ask',culture:'',history:[],knowledge:[]}},()=>{},undefined,undefined,true,'core');
throw Error('Crash failpoint was not reached');
