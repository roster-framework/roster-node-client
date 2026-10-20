import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { LocalPythonAgentWorker } from "../src/infrastructure/python-agent-worker.js";
import type { ModelExecution } from "../src/domain/model-execution.js";
import type { ModelUsage } from "../src/domain/model-usage.js";
const python = process.env.ROSTER_TEST_PYTHON;
const worker = new LocalPythonAgentWorker(
  python,
  fileURLToPath(new URL("./fixtures/python-worker.py", import.meta.url)),
);
const input: ModelExecution = {
  config: {
    engine: "langgraph-python",
    provider: "openai-compatible",
    model: "fixture",
    base_url: "http://127.0.0.1:1",
    credential_env: "",
    statuses: ["ok"],
    events: ["complete"],
  },
  prompt: "Company rules",
  request: {},
  tools: [
    {
      name: "safe",
      description: "Safe",
      schema: { type: "object", properties: { text: { type: "string" } } },
    },
  ],
};
test('Python usage frames use the host telemetry contract and journal failures fail execution', {skip:!python}, async()=>{
  const reports:ModelUsage[]=[];
  const run=(mode:string,publish:(usage:ModelUsage)=>void)=>worker.execute({...input,request:{mode}},new AbortController().signal,()=>{},async()=>({}),undefined,publish);
  const result=await run('usage',usage=>reports.push(usage));
  assert.equal(result.summary,'Usage complete');assert.equal(reports.length,2);
  assert.equal(reports[0]!.input_tokens,12);assert.equal(reports[0]!.output_tokens,0);
  assert.ok(!JSON.stringify(reports).includes('private-fixture'));
  await assert.rejects(run('invalid-usage',()=>assert.fail('invalid usage published')),/Python/);
  let writes=0;
  await assert.rejects(run('usage',()=>{writes++;throw Error('private journal failure');}),/Python/);
  assert.equal(writes,1);
});
test('Python receives the selected vault credential without changing process environment or forwarding other keys', {skip:!python},async()=>{
  const previous=process.env.REVIEWER_API_KEY,other=process.env.OTHER_API_KEY;
  process.env.REVIEWER_API_KEY='environment-reviewer-fixture';process.env.OTHER_API_KEY='other-fixture';
  try {
    const scoped=new LocalPythonAgentWorker(python,fileURLToPath(new URL('./fixtures/python-worker.py',import.meta.url)),
      reference=>reference==='REVIEWER_API_KEY'?'vault-reviewer-fixture':undefined);
    const result=await scoped.execute({...input,config:{...input.config,credential_env:'REVIEWER_API_KEY'},request:{mode:'credential'}},
      new AbortController().signal,()=>{},async()=>({}));
    assert.equal(result.summary,'Credential isolated');
    assert.equal(process.env.REVIEWER_API_KEY,'environment-reviewer-fixture');
  } finally {
    if(previous===undefined)delete process.env.REVIEWER_API_KEY;else process.env.REVIEWER_API_KEY=previous;
    if(other===undefined)delete process.env.OTHER_API_KEY;else process.env.OTHER_API_KEY=other;
  }
});
test(
  "Python worker tool RPC, published logs and declared result use one bounded bridge",
  { skip: !python },
  async () => {
    await worker.validate(input.config);
    const logs: string[] = [];
    let calls = 0;
    const result = await worker.execute(
      input,
      new AbortController().signal,
      (text) => logs.push(text),
      async (name, args) => {
        calls++;
        assert.equal(name, "safe");
        assert.equal(args.text, "hello");
        return { accepted: true };
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(logs, ["Published note"]);
    assert.equal(result.event, "complete");
  },
);
test(
  "Python worker rejects denied/unknown/duplicate tools, malformed output and cancellation",
  { skip: !python },
  async () => {
    for (const mode of ["unknown", "duplicate", "invalid", "oversized"])
      await assert.rejects(
        worker.execute(
          { ...input, request: { mode } },
          new AbortController().signal,
          () => {},
          async () => ({}),
        ),
        /Python/,
      );
    let calls = 0;
    await assert.rejects(
      worker.execute(
        input,
        new AbortController().signal,
        () => {},
        async () => {
          calls++;
          throw Error("private-credential");
        },
      ),
      /Python/,
    );
    assert.equal(calls, 1);
    const controller = new AbortController();
    const running = worker.execute(
      { ...input, request: { mode: "wait" } },
      controller.signal,
      () => {},
      async () => ({}),
    );
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(running, /cancelled/);
  },
);
