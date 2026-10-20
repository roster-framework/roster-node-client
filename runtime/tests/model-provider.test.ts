import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ManagedAgent } from "@roster/contracts";
import { managedModel } from "../src/infrastructure/langchain-managed.js";
import { createManagedModel } from "../src/infrastructure/model-factory.js";
import { publishedModelText } from "../src/domain/model-output.js";

test('bundled provider SDKs initialize without fixing a model catalogue',async()=>{
  for(const provider of ['google','ollama','groq','mistralai','xai']){
    const config=ManagedAgent.parse({id:'writer',name:'Writer',kind:'llm',provider,model:provider==='google'?'gemini-future-model':'future-model',base_url:'http://127.0.0.1:1',credential_env:''});
    const model=await createManagedModel(config,'fixture-key');
    assert.equal(typeof model.invoke,'function');
  }
});

test("provider selection keeps existing OpenAI settings and creates Claude directly", () => {
  const old = ManagedAgent.parse({
    id: "writer",
    name: "Writer",
    kind: "llm",
    model: "existing-model",
  });
  assert.equal(old.provider, "openai-compatible");
  assert.ok(managedModel(old, "fixture-key") instanceof ChatOpenAI);
  const claude = ManagedAgent.parse({
    ...old,
    provider: "anthropic",
    credential_env: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-4-6",
  });
  const model = managedModel(claude, "fixture-key");
  assert.ok(model instanceof ChatAnthropic);
  assert.equal(model.model, "claude-sonnet-4-6");
});
test("provider reasoning blocks never enter outward session logs", () => {
  assert.equal(
    publishedModelText([
      { type: "thinking", thinking: "Private reasoning" },
      { type: "reasoning", text: "Also private" },
      { type: "text", text: "Published note" },
    ]),
    "Published note",
  );
});
test("model IDs and SDK parameters survive provider factory creation without paid calls", async () => {
  const config = ManagedAgent.parse({
    id: "writer",
    name: "Writer",
    kind: "llm",
    provider: "openai-compatible",
    model: "future-model",
    model_parameters: {
      temperature: 0.2,
      maxTokens: 789,
      modelKwargs: { reasoning_effort: "high" },
    },
  });
  const model = managedModel(config, "fixture-key");
  assert.equal(model.model, "future-model");
  assert.equal(model.temperature, 0.2);
  assert.equal(model.maxTokens, 789);
  assert.equal(model.modelKwargs.reasoning_effort, "high");
  await assert.rejects(
    createManagedModel(
      { ...config, provider: "unsupported-provider" },
      "fixture-key",
    ),
  );
  assert.throws(() =>
    managedModel(
      {
        ...config,
        model_parameters: { configuration: { baseURL: "https://bad.invalid" } },
      },
      "fixture-key",
    ),
  );
});
