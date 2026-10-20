import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ManagedAgent, PROTOCOL } from "@roster/contracts";
import { LocalPythonAgentWorker } from "../src/infrastructure/python-agent-worker.js";
import { managedImplementation } from "../src/infrastructure/langchain-managed.js";
import { approvalTools } from "../src/infrastructure/approval-tools.js";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RosterRuntime } from "../src/application/runtime.js";
import { FileRuntimeStorage } from "../src/infrastructure/filesystem.js";
import { SqliteSessionJournal } from "../src/infrastructure/sqlite-session-journal.js";
import { executeAgent } from "../src/infrastructure/langgraph-engine.js";
import { createManagedModel } from "../src/infrastructure/model-factory.js";
import { createRuntimeApi } from "../src/interfaces/http.js";
import type { ModelUsage } from "../src/domain/model-usage.js";
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const python = process.env.ROSTER_TEST_PYTHON_SDK;
test('CrewAI event usage keeps call identity, unknown counts, handler cleanup and sticky publication failure', {skip:!python,timeout:30000}, async()=>{
  const {stdout}=await promisify(execFile)(python!,['-c',`
import json, os, sys
protocol=sys.stdout
sys.stdout=sys.stderr
os.environ['OTEL_SDK_DISABLED']='true'
os.environ['CREWAI_TELEMETRY_ENABLED']='false'
from crewai.events import crewai_event_bus as bus
from crewai.events.types.llm_events import LLMCallCompletedEvent as Done, LLMCallFailedEvent as Failed, LLMCallType
from roster_agents.engines import crewai_usage
records=[]; external=[]; config={'provider':'fixture','model':'small'}
def observer(source,event): external.append(event.call_id)
bus.on(Done)(observer)
def done(key,usage):
    return Done(call_id=key,response='private-response',messages='private-input',call_type=LLMCallType.LLM_CALL,usage=usage)
with crewai_usage(config,records.append):
    bus.emit(None,done('known',{'prompt_tokens':12,'completion_tokens':0,'cached_prompt_tokens':7,'credential':'private-key'}))
    bus.emit(None,done('known',{'prompt_tokens':12,'completion_tokens':0,'cached_prompt_tokens':7}))
    bus.emit(None,done('absent',{'total_tokens':0}))
    bus.emit(None,Failed(call_id='failed',error='private-error'))
bus.emit(None,done('after',{'prompt_tokens':9})); bus.flush()
assert len(records)==3 and len(external)==4
try:
    with crewai_usage(config,lambda usage: (_ for _ in ()).throw(RuntimeError('private-journal'))):
        bus.emit(None,done('reject',{'prompt_tokens':5}))
except RuntimeError as error:
    assert str(error)=='CrewAI usage delivery failed'
else: raise AssertionError('publication failure became success')
with crewai_usage(config,records.append):
    bus.emit(None,done('known',{'prompt_tokens':0,'completion_tokens':0,'cached_prompt_tokens':0}))
flush=bus.flush
bus.flush=lambda timeout=30: False
try:
    try:
        with crewai_usage(config,records.append): pass
    except RuntimeError as error:
        assert str(error)=='CrewAI usage delivery failed'
    else: raise AssertionError('flush timeout became success')
finally: bus.flush=flush
bus.off(Done,observer)
protocol.write(json.dumps(sorted(records[:3],key=lambda r:r['invocation_id'])+records[3:]))
`],{cwd:fileURLToPath(new URL('../python',import.meta.url)),timeout:25000});
  const reports=JSON.parse(stdout) as ModelUsage[];
  assert.deepEqual(reports.map(r=>[r.invocation_id,r.state,r.input_tokens,r.output_tokens,r.cached_input_tokens]),[
    ['absent','completed',null,null,null],['failed','failed',null,null,null],['known','completed',12,0,7],['known','completed',0,0,0],
  ]);
  assert.ok(reports.every(r=>r.phase==='unknown'));
  assert.ok(!stdout.includes('private-'));
});
test('Python SDK callback preserves unknown versus zero, ignores repeated terminals and excludes error bodies', {skip:!python}, async()=>{
  const {stdout}=await promisify(execFile)(python!,['-c',`
import json
from types import SimpleNamespace as S
from roster_agents.engines import model_usage_callbacks
records=[]
c=model_usage_callbacks({'provider':'fixture','model':'small'},records.append)
c.on_chat_model_start({},[],run_id='zero',metadata={'langgraph_node':'agent'})
c.on_llm_end(S(generations=[[S(message=S(usage_metadata={'input_tokens':0,'output_tokens':0,'input_token_details':{'cache_read':0}}))]]),run_id='zero')
c.on_llm_error(RuntimeError('private-error'),run_id='zero')
c.on_llm_end(S(generations=[]),run_id='zero')
c.on_chat_model_start({},[],run_id='invalid',metadata={'langgraph_node':'generate_structured_response'})
c.on_llm_end(S(generations=[[S(message=S(usage_metadata={'input_tokens':True,'output_tokens':9007199254740992,'input_token_details':{'cache_read':-1}}))]]),run_id='invalid')
c.on_llm_error(RuntimeError('private-error'),run_id='failed')
c.on_llm_end(S(generations=[[S(message=S(usage_metadata={'input_tokens':2,'input_token_details':{'cache_read':3}}))]]),run_id='cache')
print(json.dumps(records))
`],{cwd:fileURLToPath(new URL('../python',import.meta.url)),timeout:15000});
  const reports=JSON.parse(stdout) as ModelUsage[];
  assert.equal(reports.length,4);
  assert.deepEqual(reports.map(r=>[r.phase,r.state,r.input_tokens,r.output_tokens,r.cached_input_tokens]),[
    ['loop','completed',0,0,0],['final','completed',null,null,null],['unknown','failed',null,null,null],['unknown','completed',2,null,null],
  ]);
  assert.ok(!stdout.includes('private-error'));
});
test('Python SDK failure reports unknown usage once without retrying or retaining provider errors', {skip:!python,timeout:60000}, async t=>{
  let calls=0;
  const server=createServer(async(req,res)=>{
    for await(const _ of req) { /* Never archive model input. */ }
    calls++;
    res.writeHead(400,{'Content-Type':'application/json'});
    res.end(JSON.stringify({error:{message:'private-provider-error',type:'invalid_request_error'}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const reports:ModelUsage[]=[];
  const worker=new LocalPythonAgentWorker(python,process.env.ROSTER_TEST_PYTHON_WORKER);
  await assert.rejects(worker.execute({
    config:{engine:'langgraph-python',provider:'openai-compatible',model:'failure-fixture',base_url:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,credential_env:'',model_parameters:{max_retries:0},statuses:['success'],events:[]},
    prompt:'private-instruction',request:{request:'private-request'},tools:[],
  },new AbortController().signal,()=>{},async()=>assert.fail('no tools'),undefined,u=>reports.push(u)),/Python model execution failed/);
  assert.equal(calls,1);assert.equal(reports.length,1);
  assert.equal(reports[0]!.state,'failed');assert.equal(reports[0]!.phase,'loop');
  assert.equal(reports[0]!.input_tokens,null);assert.equal(reports[0]!.output_tokens,null);assert.equal(reports[0]!.cached_input_tokens,null);
  assert.ok(!JSON.stringify(reports).includes('private-'));
});
test(
  "official Node LangGraph, Python LangGraph and CrewAI loops use the chosen model and local tools",
  { skip: !python, timeout: 180000 },
  async (t) => {
    const seen: Record<string, any>[] = [];
    const value = {
      status: "success",
      summary: "Local model complete",
      output: "Verified local API",
      event: "complete",
    };
    const server = createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const chunk of req) parts.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(parts).toString());
      seen.push(body);
      const definitions = (body.tools ?? []).map((tool: any) => tool.function);
      const structured = definitions.find(
        (tool: any) => tool.parameters?.properties?.status,
      );
      const available = definitions.find((tool: any) => tool.name === "safe");
      const called = (body.messages ?? []).some(
        (message: any) => message.role === "tool",
      );
      const call = structured
        ? { name: structured.name, arguments: JSON.stringify(value) }
        : available && !called
          ? { name: "safe", arguments: '{"text":"hello"}' }
          : undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "local",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: call ? null : JSON.stringify(value),
                ...(call
                  ? {
                      tool_calls: [
                        { id: "call-1", type: "function", function: call },
                      ],
                    }
                  : {}),
              },
              finish_reason: call ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const base_url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const controller = new AbortController();
    const logs: string[] = [];
    const context = {
      signal: controller.signal,
      workspace: "",
      log: (text: string) => logs.push(text),
      authorizeMcpTool: async () => {},
      approveTool: async () => {},
    };
    const input = {
      protocol: PROTOCOL,
      execution_id: "local-execution",
      work_id: "local-work",
      agent_id: "writer",
      input: {},
      context: {
        request: "Complete",
        culture: "Company rules",
        history: [],
        knowledge: [],
      },
    };
    const config = ManagedAgent.parse({
      id: "writer",
      name: "Writer",
      kind: "llm",
      model: "arbitrary-new-model",
      provider: "openai-compatible",
      base_url,
      credential_env: "",
      events: ["complete"],
    });
    const node = await managedImplementation(
      { ...config, model_parameters: { temperature: 0.25 } },
      [],
    ).execute(input, context);
    assert.equal(node.summary, value.summary);
    assert.equal(node.events[0].type, "complete");
    assert.equal(seen.length,2);
    assert.ok(seen.every(body=>body.messages.some((m:any)=>m.role==='system' && m.content.includes('Company rules'))),
      'Node loop and structured result require the organization prompt');
    const worker = new LocalPythonAgentWorker(
      python,
      process.env.ROSTER_TEST_PYTHON_WORKER,
    );
    let approved = 0,
      invoked = 0;
    const tool = approvalTools(
      [
        new DynamicStructuredTool({
          name: "safe",
          description: "Read authorized data",
          schema: z.object({ text: z.string() }),
          func: async () => {
            invoked++;
            return "Allowed";
          },
        }),
      ],
      { mode: "all", tools: [] },
      {
        ...context,
        approveTool: async () => {
          approved++;
        },
      },
    )[0];
    for (const engine of ["langgraph-python", "crewai-python"] as const) {
      const binding = {
        ...config,
        engine,
        model_parameters: { temperature: 0.25 },
      };
      const beforeCalls=seen.length;
      const reports:ModelUsage[]=[];
      await worker.validate(binding).catch((error) => {
        throw new Error(engine + " validation: " + error.message);
      });
      const result = await worker
        .execute(
          {
            config: binding,
            prompt: "Company rules",
            request: { request: "Use safe, then return the declared result." },
            tools: [
              {
                name: "safe",
                description: "Read authorized data",
                schema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
            ],
          },
          controller.signal,
          context.log,
          async (name, args) => {
            assert.equal(name, "safe");
            return tool.invoke(args);
          },
          undefined,
          usage=>reports.push(usage),
        )
        .catch((error) => {
          throw new Error(engine + ": " + error.message);
        });
      assert.deepEqual(result, value);
      if(engine==='langgraph-python') {
        const phase=seen.slice(beforeCalls);
        assert.ok(phase.length>=3);
        assert.equal(reports.length,phase.length);
        assert.equal(new Set(reports.map(r=>r.invocation_id)).size,reports.length);
        assert.ok(reports.some(r=>r.phase==='loop') && reports.some(r=>r.phase==='final'));
        assert.ok(reports.every(r=>r.input_tokens===10 && r.output_tokens===10 && r.cached_input_tokens===null));
        assert.ok(!JSON.stringify(reports).includes('Company rules'));
        assert.ok(phase.every(body=>body.messages.some((m:any)=>m.role==='system' && m.content.includes('Company rules'))),
          'Python loop and structured result require the same prompt');
      } else {
        assert.equal(reports.length,seen.length-beforeCalls,'CrewAI must report each observed SDK call without using Crew totals');
        assert.ok(reports.length>=2);
        assert.equal(new Set(reports.map(r=>r.invocation_id)).size,reports.length);
        assert.ok(reports.every(r=>r.phase==='unknown' && r.state==='completed' && r.input_tokens===10 && r.output_tokens===10 && r.cached_input_tokens===null));
      }
    }
    assert.equal(invoked, 2);
    assert.equal(approved, 2);
    assert.ok(seen.length >= 6);
    assert.ok(
      seen.every(
        (body) =>
          body.model === "arbitrary-new-model" && body.temperature === 0.25,
      ),
    );
    assert.ok(logs.some((text) => text.includes(value.summary)));
    // Runtime HTTP owns preset/agent creation and durable execution logs for all engines.
    const directory = await mkdtemp(join(tmpdir(), "roster-model-engines-"));
    const storage = new FileRuntimeStorage(directory, "Model runtime");
    const journal = new SqliteSessionJournal(
      join(directory, "journal.db"),
      "models",
    );
    const factory = {
      create: (c: any, m: any) => managedImplementation(c, m, worker),
      validate: async (c: any) => {
        if (c.engine && c.engine !== "langgraph-node") await worker.validate(c);
        else await createManagedModel(c, "fixture-key");
      },
    };
    const runtime = new RosterRuntime(
      "models",
      [],
      storage,
      storage,
      storage,
      { execute: executeAgent },
      factory,
      { inspect: async () => [] },
      undefined,
      undefined,
      journal,
    );
    await runtime.initialize();
    const token = "model-fixture-token-at-least-24-chars";
    const api = createRuntimeApi(runtime, token);
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    t.after(async () => {
      await runtime.close();
      await new Promise<void>((resolve) => api.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    for (const engine of [
      "langgraph-node",
      "langgraph-python",
      "crewai-python",
    ] as const) {
      const config = {
        ...ManagedAgent.parse({
          id: engine,
          name: engine,
          kind: "llm",
          model: "arbitrary-new-model",
          provider: "openai-compatible",
          base_url,
          credential_env: "",
          events: ["complete"],
        }),
        engine,
        model_parameters: { temperature: 0.25 },
      };
      const endpoint = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
      for (const [path, body] of [
        ["/admin/agent-presets", { id: engine, name: engine, agent: config }],
        ["/admin/agents", config],
      ] as const) {
        const response = await fetch(endpoint + path, {
          method: "PUT",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 200);
        await response.json();
      }
      const frames: any[] = [];
      await runtime.run(
        { ...input, agent_id: engine, execution_id: "execution-" + engine },
        (f) => frames.push(f),
        () => {},
        undefined,
        true,
        "fixture-consumer",
      );
      assert.equal(
        (await storage.get("execution-" + engine))?.state,
        "completed",
      );
      assert.equal(frames.filter((f) => f.type === "result").length, 1);
      const records = journal.page(
        "execution-" + engine,
        "fixture-consumer",
        0,
        100,
      );
      assert.ok(
        records.entries.some(
          (r) => r.entry.kind === "log" && r.entry.text.includes(value.summary),
        ),
      );
      if(engine==='langgraph-python') {
        const usages=records.entries.filter(r=>r.entry.id.startsWith('model-usage.'));
        assert.equal(usages.length,2);
        assert.deepEqual(usages.map(r=>JSON.parse(r.entry.text).usage.phase).sort(),['final','loop']);
        assert.ok(usages.every(r=>JSON.parse(r.entry.text).usage.input_tokens===10));
      } else if(engine==='crewai-python') {
        const usages=records.entries.filter(r=>r.entry.id.startsWith('model-usage.'));
        assert.ok(usages.length>=1);
        assert.ok(usages.every(r=>JSON.parse(r.entry.text).usage.phase==='unknown' && JSON.parse(r.entry.text).usage.input_tokens===10));
      }
    }
    const recovered = await new FileRuntimeStorage(
      directory,
      "Ignored name",
    ).read();
    assert.equal(recovered.managed_agents.length, 3);
    assert.equal(recovered.agent_presets?.length, 3);
    assert.ok(
      recovered.managed_agents.every(
        (agent) => agent.model === "arbitrary-new-model" && agent.version === 1,
      ),
    );
    const original=journal.page('execution-langgraph-python','fixture-consumer',0,100);
    const crewOriginal=journal.page('execution-crewai-python','fixture-consumer',0,100);
    await runtime.close();
    const reopened=new SqliteSessionJournal(join(directory,'journal.db'),'models');
    assert.deepEqual(reopened.page('execution-langgraph-python','fixture-consumer',0,100),original);
    assert.deepEqual(reopened.page('execution-crewai-python','fixture-consumer',0,100),crewOriginal);
    reopened.close();
  },
);
