import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROTOCOL,Result,type RunInput} from '@roster/contracts';
import {LocalPythonAgentWorker} from '../src/infrastructure/python-agent-worker.js';
import {RosterRuntime} from '../src/application/runtime.js';
import {FileRuntimeStorage} from '../src/infrastructure/filesystem.js';
import {executeAgent} from '../src/infrastructure/langgraph-engine.js';
import type {RuntimeFrame} from '../src/domain/session.js';

const python=process.env.ROSTER_TEST_PYTHON;
const config={engine:'langgraph-python',provider:'openai-compatible',model:'fixture',base_url:'http://127.0.0.1:1',credential_env:'',statuses:['ok'],events:[]};
const script=fileURLToPath(new URL('./fixtures/python-suspension-worker.py',import.meta.url));
const invocation:RunInput={protocol:PROTOCOL,execution_id:'run',work_id:'work',agent_id:'agent',input:{},context:{request:'Ask designer',culture:'',history:[],knowledge:[]}};

test('shipped Python bridge waits for clean author exit before Runtime stores private suspension', {skip:!python},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roster-python-suspension-'));
  const storage=new FileRuntimeStorage(dir,'test');
  const worker=new LocalPythonAgentWorker(python,script);
  const runtime=new RosterRuntime('runtime',[{
    spec:{id:'agent',name:'Agent',description:'test',statuses:['ok'],events:[],skills:[],rules:[],capabilities:[]},
    async execute(_,ctx){
      const suspend=ctx.suspendForReply!;
      const reply=await worker.execute({config,prompt:'',request:{mode:'valid'},tools:[],workspace:ctx.workspace},ctx.signal,ctx.log,async()=>({}), (waitId,state)=>{
        // The author finally has run before the Runtime request is invoked.
        // Process closure is additionally required by LocalPythonAgentWorker.
        assert.equal(readFileSync(join(ctx.workspace,'worker-stopped'),'utf8'),'stopped');
        return suspend(waitId,state);
      });
      return Result.parse(reply);
    },
  }],storage,storage,storage,{execute:executeAgent},{create:()=>{throw Error('unused');}},{inspect:async()=>[]});
  await runtime.initialize();
  t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
  const frames:RuntimeFrame[]=[];
  await runtime.run(invocation,f=>frames.push(f));
  assert.equal((await storage.get('run'))?.state,'suspended');
  assert.equal((await storage.readSuspensionCheckpoint('run')).state.draft,'private-python-checkpoint');
  assert.ok(!JSON.stringify(frames).includes('private-python-checkpoint'));
  assert.ok(!frames.some(f=>f.type==='result'));
  assert.equal(runtime.capacity().active,0);
});

test('Python mixed/invalid/failed/cancelled requests never call the Runtime suspension port',{skip:!python},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roster-python-suspension-deny-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const worker=new LocalPythonAgentWorker(python,script);
  for(const mode of ['mixed','double','private','failed','invalid','oversized','abort','unsupported']) {
    let called=0;
    const controller=new AbortController();
    const timer=mode==='abort'?setTimeout(()=>controller.abort(),150):undefined;
    try {
      await assert.rejects(()=>worker.execute({config,prompt:'',request:{mode:mode==='unsupported'?'valid':mode},tools:[],workspace:dir},controller.signal,()=>{},async()=>({}),mode==='unsupported'?undefined:()=>{called++;throw Error('must not suspend');}));
      assert.equal(called,0,mode);
    } finally {clearTimeout(timer);}
  }
});
