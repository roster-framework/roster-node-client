import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedAgent } from "@roster/contracts";
import { RosterRuntime } from "../src/application/runtime.js";
import { FileRuntimeStorage } from "../src/infrastructure/filesystem.js";
import { managedImplementation } from "../src/infrastructure/langchain-managed.js";
import { createManagedModel } from "../src/infrastructure/model-factory.js";
import { createRuntimeApi } from "../src/interfaces/http.js";
import { once } from "node:events";
test("unavailable model provider cannot partially create or overwrite runtime agents", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "roster-model-create-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new FileRuntimeStorage(directory, "Test runtime");
  const runtime = new RosterRuntime(
    "models",
    [],
    storage,
    storage,
    storage,
    { execute: (a, i, c) => a.execute(i, c) },
    {
      create: managedImplementation,
      validate: async (config) => {
        if (config.kind === "llm")
          await createManagedModel(config, "fixture-key");
      },
    },
    { inspect: async () => [] },
  );
  await runtime.initialize();
  const api = createRuntimeApi(runtime, "fixture-admin-token");
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  t.after(() => new Promise<void>((resolve) => api.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${(api.address() as { port: number }).port}/admin`;
  assert.equal((await fetch(endpoint)).status, 401);
  const admin = await fetch(endpoint, {
    headers: { Authorization: "Bearer fixture-admin-token" },
  });
  assert.equal(admin.status, 200);
  assert.equal((await admin.json()).can_manage_presets, true);
  const config = ManagedAgent.parse({
    id: "writer",
    name: "Writer",
    kind: "llm",
    model: "future-model",
    model_parameters: { temperature: 0.3 },
  });
  await assert.rejects(
    runtime.upsertAgent({ ...config, provider: "missing-provider" }),
  );
  assert.equal((await storage.read()).managed_agents.length, 0);
  await runtime.upsertAgent(config);
  await assert.rejects(
    runtime.upsertAgent({
      ...config,
      version: 1,
      provider: "missing-provider",
    }),
  );
  const recovered = await new FileRuntimeStorage(
    directory,
    "Ignored name",
  ).read();
  assert.equal(recovered.managed_agents[0].model, "future-model");
  assert.equal(recovered.managed_agents[0].version, 1);
  assert.deepEqual(recovered.managed_agents[0].model_parameters, {
    temperature: 0.3,
  });
});
