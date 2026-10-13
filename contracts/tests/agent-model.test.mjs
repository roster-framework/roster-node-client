import { test } from "node:test";
import assert from "node:assert/strict";
import { ManagedAgent, ModelParameters } from "../dist/index.js";
test("model identity and inference options are independent from presets and engine", () => {
  const base = { id: "writer", name: "Writer", kind: "llm" };
  assert.equal(ManagedAgent.parse(base).provider, "openai-compatible");
  for (const engine of [
    "langgraph-node",
    "langgraph-python",
    "crewai-python",
  ]) {
    const config = ManagedAgent.parse({
      ...base,
      engine,
      provider: "future-provider",
      model: "future/model",
      model_parameters: {
        temperature: 0.2,
        reasoning: { effort: "high" },
        stop: ["end"],
      },
    });
    assert.equal(config.model, "future/model");
  }
  for (const input of [
    { apiKey: "secret" },
    { model_kwargs: { headers: {} } },
    { tools: [] },
    { response_format: {} },
  ])
    assert.equal(ModelParameters.safeParse(input).success, false);
  assert.equal(
    ModelParameters.safeParse({ extra: "x".repeat(16001) }).success,
    false,
  );
});
