import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Result,PROTOCOL} from '@roster/contracts';
import {RosterRuntime} from '../src/application/runtime.js';
import {FileRuntimeStorage} from '../src/infrastructure/filesystem.js';
import {SqliteSessionJournal} from '../src/infrastructure/sqlite-session-journal.js';
import {SUSPENSION_NOTE} from '../src/domain/suspension-journal.js';
import {journalRetentionPolicy} from '../src/domain/session-retention.js';
import {executeAgent} from '../src/infrastructure/langgraph-engine.js';
import type {RuntimeFrame} from '../src/domain/session.js';

const exec=promisify(execFile);
const fixture=fileURLToPath(new URL('./fixtures/suspension-crash.ts',import.meta.url));
const spec={id:'agent',name:'Agent',description:'test',statuses:['ok'],events:['complete'],skills:[],rules:[],capabilities:[]};
const input={protocol:PROTOCOL,execution_id:'run',work_id:'work',agent_id:'agent',input:{},context:{request:'Ask',culture:'',history:[],knowledge:[]}};
function cleanup(t:TestContext,directory:string) {
 const runtimes:RosterRuntime[]=[];
 t.after(async()=>{
  for(const runtime of runtimes.reverse())await runtime.close();
  if(dirname(resolve(directory))!==resolve(tmpdir()) || !basename(directory).startsWith('roster-suspend-'))throw Error('Unexpected fixture directory');
  await rm(directory,{recursive:true,force:true});
 });
 return (runtime:RosterRuntime)=>{runtimes.push(runtime);return runtime;};
}
async function crash(directory:string,mode:string) {
 await assert.rejects(exec(process.execPath,['--import','tsx',fixture,directory,mode],{timeout:30000}),error=>{assert.equal((error as {code:unknown}).code,73);return true;});
}
function runtimeFor(storage:FileRuntimeStorage,journal?:SqliteSessionJournal,id='runtime') {
 return new RosterRuntime(id,[{spec,async execute(){throw Error('Recovery must never execute an agent');}}],storage,storage,storage,{execute:executeAgent},{create:()=>{throw Error('unused');}},{inspect:async()=>[]},undefined,undefined,journal);
}

test('A process exit at each suspension commit boundary recovers once without executing or exposing checkpoints',async t=>{
 for(const mode of ['before-file','after-file','after-journal'])await t.test(mode,async t=>{
  const directory=await mkdtemp(join(tmpdir(),'roster-suspend-crash-'));
  const track=cleanup(t,directory);
  await crash(directory,mode);
  const storage=new FileRuntimeStorage(directory,'fixture');
  const journal=new SqliteSessionJournal(join(directory,'sessions.db'),'runtime');
  const runtime=track(runtimeFor(storage,journal));
  await runtime.initialize();
  const receipt=await storage.get('run');
  const page=journal.page('run','core',0,100);
  assert.equal(page.sealed,true);
  assert.equal(await storage.reserve('run'),false);
  assert.ok(!JSON.stringify({receipt,page}).includes('private-crash-checkpoint'));
  assert.ok(!page.entries.some(e=>e.entry.kind==='result'));
  if(mode==='before-file') {
   assert.equal(receipt?.state,'attention');
   assert.equal(page.entries.filter(e=>e.entry.text===SUSPENSION_NOTE).length,0);
   await assert.rejects(()=>storage.readSuspensionCheckpoint('run'));
  } else {
   assert.equal(receipt?.state,'suspended');
   assert.equal((await storage.readSuspensionCheckpoint('run')).state.draft,'private-crash-checkpoint');
   assert.equal(page.entries.filter(e=>e.entry.text===SUSPENSION_NOTE).length,1);
   await runtime.initialize();
   assert.deepEqual(journal.page('run','core',0,100),page);
  }
 });
});

test('Suspension journal replay remains idempotent after ACK and retention pruning',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'roster-suspend-prune-'));const track=cleanup(t,directory);
 await crash(directory,'after-file');
 let now=Date.now();const storage=new FileRuntimeStorage(directory,'fixture');
 const journal=new SqliteSessionJournal(join(directory,'sessions.db'),'runtime',()=>now);
 const runtime=track(runtimeFor(storage,journal));
 await runtime.initialize();const page=journal.page('run','core',0,100);
 journal.acknowledge('run','core',page.through);now+=86400000;
 assert.equal(journal.pruneAcknowledged(journalRetentionPolicy(24),now).records,page.through);
 await runtime.close();
 const reopened=new FileRuntimeStorage(directory,'fixture'),reopenedJournal=new SqliteSessionJournal(join(directory,'sessions.db'),'runtime',()=>now),next=track(runtimeFor(reopened,reopenedJournal));
 await next.initialize();const after=reopenedJournal.page('run','core',page.through,100);
 assert.equal(after.through,page.through);assert.equal(after.acknowledged,page.through);assert.equal(after.entries.length,0);
});

test('Foreign bindings, sealed conflicts, missing journals and SQL failures cannot fabricate suspension logs',async t=>{
 for(const mode of ['consumer','work','agent','runtime','sealed','missing','sql'])await t.test(mode,async t=>{
  const directory=await mkdtemp(join(tmpdir(),'roster-suspend-invalid-'));const track=cleanup(t,directory);
  await crash(directory,'after-file');
  const path=join(directory,'sessions.db'),db=new DatabaseSync(path);
  if(['consumer','work','agent'].includes(mode))db.prepare(`UPDATE streams SET ${mode}_id='foreign' WHERE execution_id='run'`).run();
  if(mode==='sealed')db.exec('UPDATE streams SET sealed=1');
  if(mode==='sql')db.exec("CREATE TRIGGER fail_note BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT,'fixture'); END");
  const before=db.prepare('SELECT * FROM streams').get(),records=db.prepare('SELECT * FROM records').all();db.close();
  const storage=new FileRuntimeStorage(directory,'fixture'),file=join(directory,'executions','run.json'),original=await readFile(file,'utf8');
  const journal=mode==='missing'?undefined:new SqliteSessionJournal(path,'runtime');
  const runtime=track(runtimeFor(storage,journal,mode==='runtime'?'foreign':'runtime'));
  await assert.rejects(()=>runtime.initialize());
  assert.equal(await readFile(file,'utf8'),original);assert.equal((await storage.get('run'))?.state,'suspended');
  const inspect=new DatabaseSync(path);try {
   assert.deepEqual(inspect.prepare('SELECT * FROM records').all(),records);
   const after=inspect.prepare('SELECT * FROM streams').get()!;
   assert.equal(after.through,before!.through);assert.equal(after.sealed,before!.sealed);assert.equal(after.suspension_fingerprint,null);
  }finally{inspect.close();}
  if(mode==='sql') {
   const repair=new DatabaseSync(path);try{repair.exec('DROP TRIGGER fail_note');}finally{repair.close();}
   await runtime.initialize();
   assert.equal(journal!.page('run','core',0,100).entries.filter(e=>e.entry.text===SUSPENSION_NOTE).length,1);
  }
 });
});

test('An ambiguous file or journal commit keeps its immutable receipt and recovers the exact original note',async t=>{
 for(const mode of ['file','journal'])await t.test(mode,async t=>{
  const directory=await mkdtemp(join(tmpdir(),'roster-suspend-ambiguous-'));const track=cleanup(t,directory);
  const storage=new FileRuntimeStorage(directory,'fixture'),path=join(directory,'sessions.db'),journal=new SqliteSessionJournal(path,'runtime');
  const runtime=new RosterRuntime('runtime',[{spec,async execute(_,ctx){ctx.suspendForReply!('wait',{draft:'private-ambiguous'});return Result.parse({status:'ok'});}}],storage,storage,storage,{execute:executeAgent},{create:()=>{throw Error('unused');}},{inspect:async()=>[]},undefined,undefined,journal);
  track(runtime);
  await runtime.initialize();
  if(mode==='file') {const save=storage.saveSuspension.bind(storage);storage.saveSuspension=async(...args)=>{await save(...args);throw Error('private filesystem error');};}
  else {const commit=journal.commitSuspension.bind(journal);journal.commitSuspension=value=>{commit(value);throw Error('private journal error');};}
  const frames:RuntimeFrame[]=[];await runtime.run(input,f=>frames.push(f),undefined,undefined,true,'core');
  assert.equal((await storage.get('run'))?.state,'suspended');assert.equal(frames.at(-1)?.type,'observation');
  assert.ok(!JSON.stringify(frames).includes('private'));assert.ok(!frames.some(f=>f.type==='suspended'||f.type==='result'));
  await runtime.close();
  const reopened=new FileRuntimeStorage(directory,'fixture'),reopenedJournal=new SqliteSessionJournal(path,'runtime'),next=track(runtimeFor(reopened,reopenedJournal));
  await next.initialize();assert.equal(reopenedJournal.page('run','core',0,100).entries.filter(e=>e.entry.text===SUSPENSION_NOTE).length,1);
  const record=JSON.parse(await readFile(join(directory,'executions','run.json'),'utf8'));
  record.private_journal.binding.consumer_id='foreign';await writeFile(join(directory,'executions','run.json'),JSON.stringify(record));
  await assert.rejects(()=>next.initialize());
 });
});
